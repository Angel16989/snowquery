const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
// cross-spawn correctly launches Windows .cmd/.bat shims (e.g. npm-installed CLIs like codex),
// which Node's built-in spawn() can't run directly without shell:true.
const spawn = require('cross-spawn');

function loadDotEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;

    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex === -1) continue;

        const key = trimmed.slice(0, equalsIndex).trim();
        let value = trimmed.slice(equalsIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadDotEnv();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const DEFAULT_DB_CONFIG = {
    user: process.env.PGUSER || '',
    password: process.env.PGPASSWORD || '',
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'postgres',
};

let currentDbConfig = { ...DEFAULT_DB_CONFIG };

function dbConfig(overrides = {}) {
    return {
        ...currentDbConfig,
        ...overrides,
        port: Number(overrides.port || currentDbConfig.port || 5432),
    };
}

function createPool(overrides = {}, poolOptions = {}) {
    const config = dbConfig(overrides);
    return new Pool({
        ...config,
        max: poolOptions.max || 10,
        idleTimeoutMillis: poolOptions.idleTimeoutMillis || 30000,
        connectionTimeoutMillis: poolOptions.connectionTimeoutMillis || 5000,
    });
}

function getPublicDbConfig() {
    return {
        host: currentDbConfig.host || '',
        port: Number(currentDbConfig.port || DEFAULT_DB_CONFIG.port),
        user: currentDbConfig.user || '',
        database: currentDbConfig.database || '',
    };
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function validateDatabaseName(database) {
    const name = String(database || '').trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
        throw new Error('Database name must start with a letter or underscore and contain only letters, numbers, and underscores.');
    }
    return name;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL connection pool — default config
let pool = createPool();

app.get('/api/config', (req, res) => {
    res.json(getPublicDbConfig());
});

// Query history (in-memory, persisted to file)
const HISTORY_FILE = path.join(__dirname, '.query_history.json');
let queryHistory = [];

// Load history from file
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
            queryHistory = JSON.parse(data);
        }
    } catch (e) {
        queryHistory = [];
    }
}

function saveHistory() {
    try {
        // Keep only last 200 entries
        if (queryHistory.length > 200) {
            queryHistory = queryHistory.slice(-200);
        }
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(queryHistory, null, 2));
    } catch (e) {
        console.error('Failed to save history:', e.message);
    }
}

loadHistory();

// ──────────────────────────────────────────────────
// API Routes
// ──────────────────────────────────────────────────

// Health check
app.get('/api/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT version()');
        res.json({ status: 'connected', version: result.rows[0].version });
    } catch (err) {
        res.json({ status: 'disconnected', error: err.message });
    }
});

// Execute SQL query
app.post('/api/query', async (req, res) => {
    const { sql, database } = req.body;

    if (!sql || !sql.trim()) {
        return res.status(400).json({ error: 'No SQL query provided' });
    }

    // If a different database is requested, create a new pool
    let queryPool = pool;
    if (database && database !== currentDbConfig.database) {
        queryPool = createPool(
            { database },
            { max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 }
        );
    }

    const startTime = Date.now();

    try {
        const result = await queryPool.query(sql);
        const duration = Date.now() - startTime;

        const historyEntry = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            sql: sql.trim(),
            database: database || 'learn_sql',
            timestamp: new Date().toISOString(),
            duration,
            rowCount: result.rowCount,
            status: 'success',
        };
        queryHistory.push(historyEntry);
        saveHistory();

        res.json({
            columns: result.fields ? result.fields.map(f => ({
                name: f.name,
                dataTypeID: f.dataTypeID,
            })) : [],
            rows: result.rows || [],
            rowCount: result.rowCount,
            command: result.command,
            duration,
        });
    } catch (err) {
        const duration = Date.now() - startTime;

        const historyEntry = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            sql: sql.trim(),
            database: database || 'learn_sql',
            timestamp: new Date().toISOString(),
            duration,
            status: 'error',
            error: err.message,
        };
        queryHistory.push(historyEntry);
        saveHistory();

        res.status(400).json({
            error: err.message,
            position: err.position,
            detail: err.detail,
            hint: err.hint,
            duration,
        });
    } finally {
        // Close temporary pool if we created one
        if (database && database !== currentDbConfig.database && queryPool !== pool) {
            queryPool.end().catch(() => { });
        }
    }
});

// ── Ask AI chat — multi-provider (shells out to locally installed AI CLIs / local Ollama; no cloud API key needed) ──

const CHAT_DISALLOWED_TOOLS = 'Bash,PowerShell,Read,Write,Edit,Grep,Glob,WebFetch,WebSearch,NotebookEdit,Task';
const MAX_TOOL_ITERATIONS = 3;

const PROVIDERS = {
    claude: {
        id: 'claude', name: 'Claude Code', binary: 'claude', modelListSupported: true,
        models: [
            { id: 'sonnet', label: 'Claude Sonnet 5' },
            { id: 'opus', label: 'Claude Opus 5' },
            { id: 'haiku', label: 'Claude Haiku 4.5' },
            { id: 'fable', label: 'Claude Fable 5' },
        ],
    },
    codex: { id: 'codex', name: 'OpenAI Codex', binary: 'codex', modelListSupported: false, models: [] },
    ollama: { id: 'ollama', name: 'Ollama (local models)', binary: 'ollama', modelListSupported: true, models: [] },
    gemini: { id: 'gemini', name: 'Gemini CLI', binary: 'gemini', modelListSupported: false, models: [], planned: true },
    aider: { id: 'aider', name: 'Aider', binary: 'aider', modelListSupported: false, models: [], planned: true },
    llm: { id: 'llm', name: 'llm (Simon Willison)', binary: 'llm', modelListSupported: false, models: [], planned: true },
};

// ── Provider discovery ──

function detectBinary(name) {
    return new Promise((resolve) => {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const child = spawn(finder, [name], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let out = '';
        const timer = setTimeout(() => { child.kill(); resolve(null); }, 4000);
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', (code) => {
            clearTimeout(timer);
            const first = out.split(/\r?\n/).map(l => l.trim()).find(Boolean);
            resolve(code === 0 && first ? first : null);
        });
    });
}

function getVersion(binary, args) {
    return new Promise((resolve) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let out = '';
        const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', () => { clearTimeout(timer); resolve(out.trim().split(/\r?\n/)[0] || null); });
    });
}

async function getOllamaModels() {
    try {
        const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return [];
        const data = await r.json();
        return (data.models || []).map(m => ({ id: m.name, label: m.name }));
    } catch (e) {
        return [];
    }
}

// Scans PATH for known AI CLIs and queries Ollama for locally pulled models.
// Only checks for presence of binaries/models on this machine — nothing is read, sent, or executed beyond a --version call.
app.get('/api/ai-providers/scan', async (req, res) => {
    try {
        const results = await Promise.all(Object.values(PROVIDERS).map(async (p) => {
            const binPath = await detectBinary(p.binary);
            if (!binPath) {
                return { id: p.id, name: p.name, detected: false, planned: !!p.planned, modelListSupported: p.modelListSupported };
            }
            const entry = {
                id: p.id, name: p.name, detected: true, path: binPath,
                planned: !!p.planned, modelListSupported: p.modelListSupported, models: p.models,
            };
            if (p.id === 'ollama') {
                entry.version = await getVersion('ollama', ['--version']);
                entry.models = await getOllamaModels();
            } else if (!p.planned) {
                entry.version = await getVersion(p.binary, ['--version']);
            }
            return entry;
        }));
        res.json({ providers: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Schema context ──
// Cached briefly per database so a back-to-back chat turn doesn't re-run the same
// information_schema lookups; invalidated immediately after any write so it never goes stale.

const schemaCache = new Map(); // database -> { schema, expiresAt }
const SCHEMA_CACHE_TTL_MS = 60000;

function invalidateSchemaCache(database) {
    schemaCache.delete(database);
}

async function getSchemaContext(database) {
    const cached = schemaCache.get(database);
    if (cached && cached.expiresAt > Date.now()) return cached.schema;

    const dbPool = createPool(
        { database },
        { max: 8, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
    );
    try {
        const tablesResult = await dbPool.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
            LIMIT 40
        `);

        // Column lookups are independent per table — fire them concurrently instead of
        // awaiting one at a time (was the single biggest chunk of chat latency: N round
        // trips in series instead of ~1).
        const lines = await Promise.all(tablesResult.rows.map(async ({ table_name }) => {
            const colsResult = await dbPool.query(`
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position
            `, [table_name]);
            const cols = colsResult.rows.map(c => `${c.column_name} ${c.data_type}`).join(', ');
            return `- ${table_name}(${cols})`;
        }));

        const schema = lines.length ? lines.join('\n') : '(no tables found in the public schema)';
        schemaCache.set(database, { schema, expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS });
        return schema;
    } finally {
        await dbPool.end();
    }
}

// ── Provider invocation ──

function runClaudeCli(prompt, model) {
    return new Promise((resolve, reject) => {
        const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence', '--disallowedTools', CHAT_DISALLOWED_TOOLS];
        if (model) args.push('--model', model);
        const child = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

        let out = '';
        let err = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('Claude CLI timed out')); }, 90000);

        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e.code === 'ENOENT' ? new Error('Claude CLI not found on PATH.') : e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(err.trim() || `Claude CLI exited with code ${code}`));
                return;
            }
            try {
                const parsed = JSON.parse(out);
                if (parsed.is_error) {
                    reject(new Error(parsed.result || 'Claude CLI returned an error'));
                    return;
                }
                resolve(parsed.result || '');
            } catch (e) {
                resolve(out.trim());
            }
        });
    });
}

function runCodexCli(prompt, model) {
    return new Promise((resolve, reject) => {
        const outFile = path.join(os.tmpdir(), `snowquery-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
        // Prompt is piped via stdin rather than passed as an argv argument: codex is an npm .cmd
        // shim on Windows, so cross-spawn routes it through cmd.exe, whose command-line parsing
        // can mangle a large multi-line argument (and the flags after it). Stdin sidesteps that.
        const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-o', outFile];
        if (model) args.push('-m', model);
        const child = spawn('codex', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        let err = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('Codex CLI timed out')); }, 90000);

        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e.code === 'ENOENT' ? new Error('Codex CLI not found on PATH.') : e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            fs.readFile(outFile, 'utf-8', (readErr, content) => {
                fs.unlink(outFile, () => {});
                if (readErr) {
                    reject(new Error(err.trim() || `Codex CLI exited with code ${code}`));
                    return;
                }
                resolve(content.trim());
            });
        });

        child.stdin.write(prompt);
        child.stdin.end();
    });
}

async function runOllamaApi(prompt, model) {
    if (!model) throw new Error('No Ollama model selected.');
    const r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // keep_alive keeps the model resident in memory between chat turns so a follow-up
        // question doesn't pay the multi-second reload cost on top of inference time.
        body: JSON.stringify({ model, prompt, stream: false, keep_alive: '10m' }),
        signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Ollama error: ${text || r.statusText}`);
    }
    const data = await r.json();
    return data.response || '';
}

async function runProvider(providerId, model, prompt) {
    switch (providerId) {
        case 'claude': return runClaudeCli(prompt, model);
        case 'codex': return runCodexCli(prompt, model);
        case 'ollama': return runOllamaApi(prompt, model);
        default: throw new Error(`"${providerId}" isn't integrated yet — pick Claude, Codex, or Ollama.`);
    }
}

// ── SQL tool loop (database-scoped read/write access, gated by mode) ──

const CHAT_SYSTEM_PROMPT = `You are "Ask AI", an assistant embedded inside SnowQuery, a local PostgreSQL learning tool with a Snowflake-style worksheet UI.
You have real, working read AND write access to the PostgreSQL database below via the SQL code block convention described below — this is not a restricted sandbox or a read-only demo. You can create/alter/drop tables, create new schemas, create or drop whole databases, insert/update/delete rows, and run any other valid PostgreSQL statement — each statement you propose runs on its own, outside of any transaction, so statements like CREATE DATABASE that PostgreSQL normally forbids inside a transaction block work fine here. The app (not you) decides whether a given statement runs immediately or needs the user's approval first, based on the current mode — that gating happens after you respond, so you should never refuse or hedge about your own ability to do something just because it changes the database, creates a database, or sounds structurally significant. If the user asks for a change you can make with SQL, propose the SQL — don't claim a limitation you don't actually have.
Use the current tables/columns listed below — don't invent ones that aren't there, but you may create new ones if asked.
Rules:
- Answer conversationally in 1-4 short sentences.
- When a SQL statement would help, include exactly one statement in a single fenced \`\`\`sql code block using standard PostgreSQL syntax. Never put more than one statement in the block.
- If a query result is shown to you below, use it to answer instead of repeating the same query.
- Do not use any tools other than this SQL code block convention.`;

function classifyStatement(sql) {
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    if (statements.length !== 1) return 'write'; // multi-statement / ambiguous -> require approval
    const first = statements[0].replace(/^\s*--.*$/gm, '').trim();
    const keyword = (first.match(/^\(*\s*([a-zA-Z]+)/) || [])[1] || '';
    const readKeywords = new Set(['select', 'with', 'show', 'explain', 'table']);
    return readKeywords.has(keyword.toLowerCase()) ? 'read' : 'write';
}

async function execSqlOnDatabase(database, sql) {
    const dbPool = createPool({ database }, { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 });
    try {
        const result = await dbPool.query(sql);
        if (result.command && result.command !== 'SELECT') {
            invalidateSchemaCache(database);
        }
        return {
            columns: result.fields ? result.fields.map(f => f.name) : [],
            rows: result.rows || [],
            rowCount: result.rowCount,
            command: result.command,
        };
    } finally {
        await dbPool.end();
    }
}

function formatToolResultForPrompt(sql, result, error) {
    if (error) return `Query:\n${sql}\nResult: ERROR — ${error}`;
    if (result.rows && result.rows.length) {
        const preview = result.rows.slice(0, 20).map(r => JSON.stringify(r)).join('\n');
        const more = result.rows.length > 20 ? `\n...(${result.rows.length - 20} more rows)` : '';
        return `Query:\n${sql}\nResult (${result.rowCount} row(s)):\n${preview}${more}`;
    }
    return `Query:\n${sql}\nResult: ${result.command} executed, ${result.rowCount ?? 0} row(s) affected.`;
}

function extractSql(reply) {
    const match = reply.match(/```sql\s*([\s\S]*?)```/i);
    return match ? match[1].trim() : null;
}

const MODE_NOTES = {
    plan: 'You are in Plan mode: any SQL you propose will NOT run automatically — the user reviews and runs it themselves.',
    auto: 'You are in Auto mode: any SQL you propose in a ```sql block runs immediately and you will be shown the result to continue your answer.',
    ask: "You are in Ask-before-writes mode: SELECT/read queries you propose run immediately and you'll see the result; anything that changes data pauses for the user's approval first.",
};

function buildPrompt({ schema, database, historyText, toolTurns, userMessage, mode }) {
    const parts = [
        CHAT_SYSTEM_PROMPT,
        `\n(${MODE_NOTES[mode] || MODE_NOTES.plan})`,
        `\nCurrent database: ${database}\nExisting tables in the 'public' schema (you are not limited to these — you can create new tables/schemas too):\n${schema}`,
    ];
    if (historyText) parts.push(`\nConversation so far:\n${historyText}`);
    parts.push(`\nUser: ${userMessage}`);
    toolTurns.forEach((t) => {
        parts.push(`\n[You ran a query]\n${formatToolResultForPrompt(t.sql, t.result, t.error)}\nGive your final natural-language answer now using this result; only include another \`\`\`sql block if you genuinely need one more query.`);
    });
    return parts.join('\n');
}

async function runChatTurn(state, onStatus) {
    const { provider, model, database, mode, schema, historyText, userMessage, toolTurns } = state;

    if (toolTurns.length >= MAX_TOOL_ITERATIONS) {
        return { done: true, reply: state.lastReply || 'Reached the query limit for this turn.', sql: null, toolTurns };
    }

    const providerName = (PROVIDERS[provider] && PROVIDERS[provider].name) || provider;
    if (onStatus) onStatus(toolTurns.length === 0 ? `Asking ${providerName}…` : `Asking ${providerName} to continue with the result…`);

    const prompt = buildPrompt({ schema, database, historyText, toolTurns, userMessage, mode });
    const reply = await runProvider(provider, model, prompt);
    const sql = extractSql(reply);

    if (!sql) return { done: true, reply, sql: null, toolTurns };
    if (mode === 'plan') return { done: true, reply, sql, toolTurns };

    const classification = classifyStatement(sql);

    if (mode === 'ask' && classification === 'write') {
        return {
            done: false,
            awaitingApproval: true,
            reply,
            sql,
            toolTurns,
            resumeState: { provider, model, database, mode, schema, historyText, userMessage, toolTurns, pendingSql: sql, reply },
        };
    }

    if (onStatus) onStatus(`Running the query on ${database}…`);
    let result, error;
    try {
        result = await execSqlOnDatabase(database, sql);
    } catch (e) {
        error = e.message;
    }

    const nextToolTurns = [...toolTurns, { sql, result, error }];
    return runChatTurn({ ...state, toolTurns: nextToolTurns, lastReply: reply }, onStatus);
}

function buildChatResultEvent(result) {
    if (result.awaitingApproval) {
        return { type: 'awaitingApproval', reply: result.reply, sql: result.sql, resumeState: result.resumeState };
    }
    return {
        type: 'result',
        reply: result.reply,
        sql: result.sql,
        executedQueries: result.toolTurns.map(t => ({
            sql: t.sql,
            rowCount: t.result ? t.result.rowCount : null,
            command: t.result ? t.result.command : null,
            error: t.error || null,
            columns: t.result ? t.result.columns : null,
            rows: t.result ? t.result.rows.slice(0, 20) : null,
        })),
    };
}

// Responses stream newline-delimited JSON: {type:'status', text} events while work is in
// progress, followed by exactly one {type:'result'|'awaitingApproval'|'error'} terminal event.
function sendChatEvent(res, obj) {
    res.write(JSON.stringify(obj) + '\n');
}

app.post('/api/chat', async (req, res) => {
    const { message, database, history, provider, model, mode } = req.body;

    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'No message provided' });
    }
    if (String(message).length > 4000) {
        return res.status(400).json({ error: 'Message is too long (max 4000 characters)' });
    }
    if (!provider || !PROVIDERS[provider]) {
        return res.status(400).json({ error: 'No AI provider selected. Scan for AI tools and pick one first.' });
    }

    const db = database || currentDbConfig.database || 'postgres';
    const chatMode = ['plan', 'auto', 'ask'].includes(mode) ? mode : 'plan';

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    try {
        sendChatEvent(res, { type: 'status', text: 'Reading the database schema…' });
        const schema = await getSchemaContext(db);
        const recentHistory = Array.isArray(history) ? history.slice(-6) : [];
        const historyText = recentHistory
            .map(h => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${h.content}`)
            .join('\n');

        const result = await runChatTurn(
            { provider, model, database: db, mode: chatMode, schema, historyText, userMessage: message.trim(), toolTurns: [] },
            (text) => sendChatEvent(res, { type: 'status', text })
        );

        sendChatEvent(res, buildChatResultEvent(result));
    } catch (err) {
        sendChatEvent(res, { type: 'error', error: err.message });
    } finally {
        res.end();
    }
});

app.post('/api/chat/resume', async (req, res) => {
    const { resumeState, approved } = req.body;
    if (!resumeState || !resumeState.pendingSql) {
        return res.status(400).json({ error: 'Invalid resume state' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    try {
        if (!approved) {
            const declineNote = resumeState.reply ? resumeState.reply.replace(/```sql[\s\S]*?```/i, '').trim() : '';
            sendChatEvent(res, {
                type: 'result',
                reply: (declineNote ? declineNote + '\n\n' : '') + '_You declined to run that query, so the database is unchanged._',
                sql: null,
                executedQueries: [],
            });
            res.end();
            return;
        }

        sendChatEvent(res, { type: 'status', text: `Running the query on ${resumeState.database}…` });
        let result, error;
        try {
            result = await execSqlOnDatabase(resumeState.database, resumeState.pendingSql);
        } catch (e) {
            error = e.message;
        }

        const nextToolTurns = [...resumeState.toolTurns, { sql: resumeState.pendingSql, result, error }];
        const continued = await runChatTurn(
            {
                provider: resumeState.provider, model: resumeState.model, database: resumeState.database,
                mode: resumeState.mode, schema: resumeState.schema, historyText: resumeState.historyText,
                userMessage: resumeState.userMessage, toolTurns: nextToolTurns,
            },
            (text) => sendChatEvent(res, { type: 'status', text })
        );

        sendChatEvent(res, buildChatResultEvent(continued));
    } catch (err) {
        sendChatEvent(res, { type: 'error', error: err.message });
    } finally {
        res.end();
    }
});

// Create a new database
app.post('/api/databases', async (req, res) => {
    const { name } = req.body;
    let adminPool;
    try {
        const databaseName = validateDatabaseName(name);
        adminPool = createPool(
            { database: 'postgres' },
            { max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const existsResult = await adminPool.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [databaseName]
        );
        if (existsResult.rowCount > 0) {
            await adminPool.end().catch(() => {});
            return res.status(400).json({ error: `Database "${databaseName}" already exists` });
        }

        await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
        await adminPool.end().catch(() => {});
        res.json({ status: 'created', database: databaseName });
    } catch (err) {
        if (adminPool) await adminPool.end().catch(() => {});
        res.status(400).json({ error: err.message });
    }
});

// List all databases
app.get('/api/databases', async (req, res) => {
    try {
        // Use a pool that connects to postgres default db for listing databases
        const adminPool = createPool(
            { database: 'postgres' },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const result = await adminPool.query(`
            SELECT datname AS database_name 
            FROM pg_database 
            WHERE datistemplate = false 
            ORDER BY datname
        `);
        await adminPool.end();
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List schemas in a database
app.get('/api/schemas/:database', async (req, res) => {
    const { database } = req.params;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const result = await dbPool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY schema_name
        `);
        await dbPool.end();
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List tables and views in a schema
app.get('/api/tables/:database/:schema', async (req, res) => {
    const { database, schema } = req.params;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const result = await dbPool.query(`
            SELECT table_name, table_type 
            FROM information_schema.tables 
            WHERE table_schema = $1
            ORDER BY table_type, table_name
        `, [schema]);
        await dbPool.end();
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get columns for a table
app.get('/api/columns/:database/:schema/:table', async (req, res) => {
    const { database, schema, table } = req.params;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const result = await dbPool.query(`
            SELECT column_name, data_type, is_nullable, column_default,
                   character_maximum_length, numeric_precision, numeric_scale
            FROM information_schema.columns 
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
        `, [schema, table]);
        await dbPool.end();
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Preview table data
app.get('/api/table-preview/:database/:schema/:table', async (req, res) => {
    const { database, schema, table } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        // Get row count
        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const countResult = await dbPool.query(
            `SELECT COUNT(*) AS total FROM ${qualifiedTable}`
        );

        const result = await dbPool.query(
            `SELECT * FROM ${qualifiedTable} LIMIT $1`, [limit]
        );
        await dbPool.end();

        res.json({
            columns: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
            rows: result.rows,
            totalRows: parseInt(countResult.rows[0].total),
            rowCount: result.rowCount,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get table row count and size info
app.get('/api/table-info/:database/:schema/:table', async (req, res) => {
    const { database, schema, table } = req.params;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const result = await dbPool.query(`
            SELECT 
                pg_size_pretty(pg_total_relation_size($1::regclass)) AS total_size,
                (SELECT COUNT(*) FROM ${qualifiedTable}) AS row_count
        `, [qualifiedTable]);
        await dbPool.end();
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Query history
app.get('/api/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const reversed = [...queryHistory].reverse().slice(0, limit);
    res.json(reversed);
});

app.delete('/api/history', (req, res) => {
    queryHistory = [];
    saveHistory();
    res.json({ message: 'History cleared' });
});

function parseSampleQueries(content) {
    const sections = [];
    let currentSection = null;
    let previousWasBlank = true;
    const sqlKeywordPattern = /^(SELECT|WITH|CREATE|INSERT|ALTER|DROP|UPDATE|DELETE|TRUNCATE|VALUES|EXPLAIN)\b/i;
    const commentedSqlContinuationPattern = /^(\)|\(|,|'|"|[a-zA-Z_][a-zA-Z0-9_]*\s+(SERIAL|VARCHAR|TEXT|INTEGER|INT|DECIMAL|NUMERIC|DATE|TIMESTAMP|BOOLEAN|PRIMARY|NOT|DEFAULT|REFERENCES))/i;

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        const commentMatch = trimmed.match(/^--\s*(.*)$/);
        const commentText = commentMatch ? commentMatch[1].trim() : '';
        const firstCommentToken = commentText.split(/\s+/)[0] || '';
        const isSeparator = commentText.startsWith('=') || commentText.startsWith('─');
        const isSectionHeader = commentMatch
            && !isSeparator
            && /[^\x00-\x7F]/.test(firstCommentToken)
            && !commentText.includes('SnowQuery Sample Queries')
            && !commentText.startsWith('Copy any query');

        if (isSectionHeader) {
            if (currentSection) sections.push(currentSection);
            currentSection = {
                icon: firstCommentToken,
                title: commentText.slice(firstCommentToken.length).trim(),
                queries: [],
            };
            previousWasBlank = false;
            continue;
        }

        if (!trimmed || isSeparator) {
            previousWasBlank = true;
            continue;
        }

        if (currentSection && commentMatch) {
            const lastQuery = currentSection.queries[currentSection.queries.length - 1];
            const isCommentedSql = sqlKeywordPattern.test(commentText)
                || Boolean(lastQuery && lastQuery.commentedSql && commentedSqlContinuationPattern.test(commentText));

            if (lastQuery && isCommentedSql && (!previousWasBlank || !lastQuery.sql.trim())) {
                lastQuery.sql += commentText + '\n';
                lastQuery.commentedSql = true;
            } else {
                currentSection.queries.push({
                    title: commentText,
                    sql: '',
                    commentedSql: false,
                });
            }
            previousWasBlank = false;
            continue;
        }

        if (currentSection && currentSection.queries.length > 0 && !trimmed.startsWith('--')) {
            const lastQuery = currentSection.queries[currentSection.queries.length - 1];
            lastQuery.sql += line + '\n';
            lastQuery.commentedSql = false;
            previousWasBlank = false;
        }
    }

    if (currentSection) sections.push(currentSection);

    for (const section of sections) {
        for (const query of section.queries) {
            query.sql = query.sql.trim();
            delete query.commentedSql;
        }
        section.queries = section.queries.filter(q => q.sql.length > 0);
    }
    return sections;
}

// Get sample queries
app.get('/api/samples', (req, res) => {
    try {
        const samplesPath = path.join(__dirname, 'sample_queries.sql');
        if (fs.existsSync(samplesPath)) {
            const content = fs.readFileSync(samplesPath, 'utf-8');
            return res.json(parseSampleQueries(content));

            // Parse into sections
            const sections = [];
            let currentSection = null;

            const lines = content.split('\n');
            for (const line of lines) {
                // Detect section headers (emoji + uppercase text)
                const sectionMatch = line.match(/^-- ([🟢🔵🟣🟠🔴⭐🛠️📅🏗️🧩])\s+(.+)/);
                if (sectionMatch) {
                    if (currentSection) sections.push(currentSection);
                    currentSection = {
                        icon: sectionMatch[1],
                        title: sectionMatch[2].trim(),
                        queries: [],
                    };
                    continue;
                }

                // Detect individual query comments (starting with "-- ")
                if (currentSection && line.match(/^-- [A-Z]/) && !line.startsWith('-- ─')) {
                    currentSection.queries.push({
                        title: line.replace(/^-- /, ''),
                        sql: '',
                    });
                    continue;
                }

                // Accumulate SQL lines
                if (currentSection && currentSection.queries.length > 0) {
                    const lastQuery = currentSection.queries[currentSection.queries.length - 1];
                    if (line.trim() && !line.startsWith('-- ─') && !line.startsWith('-- =')) {
                        lastQuery.sql += line + '\n';
                    }
                }
            }
            if (currentSection) sections.push(currentSection);

            // Clean up SQL
            for (const section of sections) {
                for (const query of section.queries) {
                    query.sql = query.sql.trim();
                }
                section.queries = section.queries.filter(q => q.sql.length > 0);
            }

            res.json(sections);
        } else {
            res.json([]);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Learning database setup
app.get('/api/setup-status', async (req, res) => {
    const database = req.query.database || currentDbConfig.database || 'learn_sql';
    let adminPool;
    let dbPool;
    try {
        const databaseName = validateDatabaseName(database);
        adminPool = createPool(
            { database: 'postgres' },
            { max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );
        const existsResult = await adminPool.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [databaseName]
        );
        const exists = existsResult.rowCount > 0;

        let tableCount = 0;
        if (exists) {
            dbPool = createPool(
                { database: databaseName },
                { max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
            );
            const tablesResult = await dbPool.query(`
                SELECT COUNT(*)::int AS table_count
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_type = 'BASE TABLE'
            `);
            tableCount = tablesResult.rows[0].table_count;
        }

        res.json({
            status: 'ok',
            database: databaseName,
            exists,
            seeded: tableCount > 0,
            tableCount,
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    } finally {
        if (dbPool) await dbPool.end().catch(() => { });
        if (adminPool) await adminPool.end().catch(() => { });
    }
});

app.post('/api/setup', async (req, res) => {
    const database = (req.body && req.body.database) || currentDbConfig.database || 'learn_sql';
    const seedPath = path.join(__dirname, 'seed.sql');
    let adminPool;
    let dbPool;
    try {
        const databaseName = validateDatabaseName(database);
        if (!fs.existsSync(seedPath)) {
            return res.status(500).json({ error: 'seed.sql was not found next to server.js.' });
        }

        adminPool = createPool(
            { database: 'postgres' },
            { max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const existsResult = await adminPool.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [databaseName]
        );
        let created = false;
        if (existsResult.rowCount === 0) {
            await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
            created = true;
        }

        dbPool = createPool(
            { database: databaseName },
            { max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );
        const seedSql = fs.readFileSync(seedPath, 'utf-8');
        await dbPool.query(seedSql);

        currentDbConfig = { ...currentDbConfig, database: databaseName };
        await pool.end().catch(() => { });
        pool = createPool();

        res.json({
            status: 'ready',
            database: databaseName,
            created,
            message: `${databaseName} is ready with the learning tables from seed.sql.`,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (dbPool) await dbPool.end().catch(() => { });
        if (adminPool) await adminPool.end().catch(() => { });
    }
});

// Update connection settings
app.post('/api/settings', async (req, res) => {
    const { host, port, user, password, database } = req.body;
    try {
        const nextConfig = {
            host: host || DEFAULT_DB_CONFIG.host,
            port: Number(port || DEFAULT_DB_CONFIG.port),
            user: user || DEFAULT_DB_CONFIG.user,
            password: typeof password === 'string' ? password : DEFAULT_DB_CONFIG.password,
            database: database || DEFAULT_DB_CONFIG.database,
        };

        // Test connection first
        const testPool = new Pool({
            ...nextConfig,
            max: 1,
            connectionTimeoutMillis: 5000,
        });

        await testPool.query('SELECT 1');
        await testPool.end();

        // Update main pool
        await pool.end();
        currentDbConfig = nextConfig;
        pool = createPool();

        res.json({ status: 'connected', message: 'Connection settings updated' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║                                              ║');
    console.log('  ║   ❄️  SnowQuery — PostgreSQL Learning Lab     ║');
    console.log('  ║                                              ║');
    console.log(`  ║   🌐 App:    http://localhost:${PORT}             ║`);
    console.log('  ║   🐘 PgSQL:  localhost:5432                  ║');
    console.log('  ║                                              ║');
    console.log('  ║   Open your browser to start querying!       ║');
    console.log('  ║                                              ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
});
