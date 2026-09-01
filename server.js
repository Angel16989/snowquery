const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
// cross-spawn correctly launches Windows .cmd/.bat shims (e.g. npm-installed CLIs like codex),
// which Node's built-in spawn() can't run directly without shell:true.
const spawn = require('cross-spawn');

// os.tmpdir() resolves to the Windows 8.3 short-name form (e.g. RASIKT~1) whenever the real
// username contains a space — Claude Code's own path-safety check treats that as "outside the
// working directory" even when cwd is set to the exact same location, silently blocking Read
// on an attached image. Resolving to the real long-form path up front avoids that entirely.
function getTempDir() {
    try {
        return fs.realpathSync.native(os.tmpdir());
    } catch (e) {
        return os.tmpdir();
    }
}
const TEMP_DIR = getTempDir();

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

// Runs a query as a specific Postgres role via SET ROLE, so restrictions are enforced by
// Postgres itself — not faked in the app. Uses a single dedicated client (not pool.query
// twice) since SET ROLE only applies for the lifetime of one connection. The app always
// connects as the postgres superuser, which can SET ROLE to anything without needing that
// role's password; RESET ROLE before releasing so the restriction never leaks to the next
// borrower of a pooled connection.
async function runQueryAsRole(pgPool, sql, role, params) {
    const client = await pgPool.connect();
    try {
        if (role && role !== 'postgres') {
            await client.query(`SET ROLE ${quoteIdentifier(role)}`);
        }
        return await client.query(sql, params);
    } finally {
        try { await client.query('RESET ROLE'); } catch (e) { /* connection may already be broken */ }
        client.release();
    }
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

function validateIdentifier(value, label) {
    const name = String(value || '').trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
        throw new Error(`${label || 'Name'} must start with a letter or underscore and contain only letters, numbers, and underscores.`);
    }
    return name;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '30mb' })); // headroom for CSV import payloads
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL connection pool — default config
let pool = createPool();

// ── Ask AI chat history — persisted in Postgres itself (the 'postgres' database, since it's
// the one database that's always present, unlike user databases which get dropped/recreated
// often) rather than browser localStorage, so it's available from any machine that points at
// this same Postgres instance instead of being stuck in one browser profile.

async function ensureChatSchema() {
    const adminPool = createPool({ database: 'postgres' }, { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 });
    try {
        await adminPool.query(`CREATE SCHEMA IF NOT EXISTS snowquery_app`);
        await adminPool.query(`
            CREATE TABLE IF NOT EXISTS snowquery_app.chat_sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                provider TEXT,
                provider_name TEXT,
                model TEXT,
                model_label TEXT,
                mode TEXT NOT NULL DEFAULT 'plan',
                sort_order INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await adminPool.query(`
            CREATE TABLE IF NOT EXISTS snowquery_app.chat_messages (
                id BIGSERIAL PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES snowquery_app.chat_sessions(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                message JSONB NOT NULL
            )
        `);
    } finally {
        await adminPool.end();
    }
}
ensureChatSchema().catch(err => console.error('Failed to set up chat history tables:', err.message));

app.get('/api/chat-sessions', async (req, res) => {
    try {
        const adminPool = createPool({ database: 'postgres' }, { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 });
        const sessionsResult = await adminPool.query(`
            SELECT id, name, provider, provider_name AS "providerName", model, model_label AS "modelLabel", mode
            FROM snowquery_app.chat_sessions
            ORDER BY sort_order, updated_at
        `);
        const messagesResult = await adminPool.query(`
            SELECT session_id, message
            FROM snowquery_app.chat_messages
            ORDER BY session_id, position
        `);
        await adminPool.end();

        const historyBySession = {};
        messagesResult.rows.forEach(r => {
            if (!historyBySession[r.session_id]) historyBySession[r.session_id] = [];
            historyBySession[r.session_id].push(r.message);
        });

        const sessions = sessionsResult.rows.map(s => ({
            ...s,
            history: historyBySession[s.id] || [],
        }));
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Full-replace sync: the client sends its whole in-memory session list (it's already the
// source of truth during a session, same as the old localStorage design) and this swaps the
// stored state to match in one transaction. Simple and correct; a personal chat history table
// realistically never grows large enough for this to be a real cost.
app.put('/api/chat-sessions', async (req, res) => {
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) {
        return res.status(400).json({ error: 'sessions must be an array' });
    }

    const adminPool = createPool({ database: 'postgres' }, { max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
    const client = await adminPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM snowquery_app.chat_sessions');

        for (let i = 0; i < sessions.length; i++) {
            const s = sessions[i];
            if (!s || !s.id) continue;
            await client.query(`
                INSERT INTO snowquery_app.chat_sessions (id, name, provider, provider_name, model, model_label, mode, sort_order)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [s.id, s.name || 'Chat', s.provider || null, s.providerName || null, s.model || null, s.modelLabel || null, s.mode || 'plan', i]);

            const history = Array.isArray(s.history) ? s.history : [];
            for (let j = 0; j < history.length; j++) {
                await client.query(`
                    INSERT INTO snowquery_app.chat_messages (session_id, position, message)
                    VALUES ($1, $2, $3::jsonb)
                `, [s.id, j, JSON.stringify(history[j])]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
        await adminPool.end();
    }
});

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
    const { sql, database, role } = req.body;

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
        const result = await runQueryAsRole(queryPool, sql, role);
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

function runClaudeCli(prompt, model, imageFileName) {
    return new Promise((resolve, reject) => {
        const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence'];
        // With an image attached, switch from a denylist to a strict allowlist scoped to just
        // that one file (referenced by basename, since cwd is the same dir it was saved to —
        // an absolute/relative path outside the CLI's notion of "home" triggers its own
        // approval prompt regardless of --allowedTools, so this only works because the image
        // lives inside cwd).
        if (imageFileName) {
            args.push('--allowedTools', `Read(${imageFileName})`);
        } else {
            args.push('--disallowedTools', CHAT_DISALLOWED_TOOLS);
        }
        if (model) args.push('--model', model);
        const child = spawn('claude', args, { cwd: TEMP_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

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

function runCodexCli(prompt, model, imagePath) {
    return new Promise((resolve, reject) => {
        const outFile = path.join(TEMP_DIR, `snowquery-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
        // Prompt is piped via stdin rather than passed as an argv argument: codex is an npm .cmd
        // shim on Windows, so cross-spawn routes it through cmd.exe, whose command-line parsing
        // can mangle a large multi-line argument (and the flags after it). Stdin sidesteps that.
        const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-o', outFile];
        if (model) args.push('-m', model);
        if (imagePath) args.push('-i', imagePath);
        const child = spawn('codex', args, { cwd: TEMP_DIR, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

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

async function runOllamaApi(prompt, model, imageBase64) {
    if (!model) throw new Error('No Ollama model selected.');
    const body = { model, prompt, stream: false, keep_alive: '10m' };
    // Only vision-capable models (e.g. gemma3, llava) will actually use this — a text-only
    // model just silently ignores it, so no separate capability check is needed here.
    if (imageBase64) body.images = [imageBase64];
    const r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // keep_alive keeps the model resident in memory between chat turns so a follow-up
        // question doesn't pay the multi-second reload cost on top of inference time.
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Ollama error: ${text || r.statusText}`);
    }
    const data = await r.json();
    return data.response || '';
}

// image (when present) is { dataUrl, base64, mime } from parseImageDataUrl(), plus paths
// resolved once per request in tempImagePaths — see saveTempImage().
async function runProvider(providerId, model, prompt, image) {
    switch (providerId) {
        case 'claude': return runClaudeCli(prompt, model, image ? image.claudeFileName : null);
        case 'codex': return runCodexCli(prompt, model, image ? image.filePath : null);
        case 'ollama': return runOllamaApi(prompt, model, image ? image.base64 : null);
        default: throw new Error(`"${providerId}" isn't integrated yet — pick Claude, Codex, or Ollama.`);
    }
}

function parseImageDataUrl(dataUrl) {
    const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(dataUrl || ''));
    if (!match) throw new Error('Invalid image data');
    return { mime: match[1], base64: match[2] };
}

async function saveTempImage(dataUrl) {
    const { mime, base64 } = parseImageDataUrl(dataUrl);
    const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const fileName = `snowquery-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const filePath = path.join(TEMP_DIR, fileName);
    await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
    return { filePath, claudeFileName: fileName, base64 };
}

async function cleanupTempImage(image) {
    if (!image) return;
    try { await fs.promises.unlink(image.filePath); } catch (e) { /* already gone */ }
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

async function execSqlOnDatabase(database, sql, role) {
    const dbPool = createPool({ database }, { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 });
    try {
        const result = await runQueryAsRole(dbPool, sql, role);
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

function buildPrompt({ schema, database, historyText, toolTurns, userMessage, mode, currentTable, worksheetSql, fileContext, image }) {
    const parts = [
        CHAT_SYSTEM_PROMPT,
        `\n(${MODE_NOTES[mode] || MODE_NOTES.plan})`,
        `\nCurrent database: ${database}\nExisting tables in the 'public' schema (you are not limited to these — you can create new tables/schemas too):\n${schema}`,
    ];
    if (currentTable) {
        parts.push(`\nThe user currently has the data preview open for table "${currentTable}" — if their question is ambiguous about which table they mean, assume it's this one.`);
    }
    if (worksheetSql && worksheetSql.trim()) {
        parts.push(`\nThe user's SQL worksheet currently contains this (it may be a draft they haven't run yet — use it to understand what they're working on, don't assume it already ran):\n\`\`\`sql\n${worksheetSql.trim().slice(0, 2000)}\n\`\`\``);
    }
    if (fileContext && fileContext.headers && fileContext.headers.length) {
        const previewRows = (fileContext.rows || []).slice(0, 50)
            .map(r => JSON.stringify(fileContext.headers.reduce((o, h, i) => { o[h] = r[i]; return o; }, {})))
            .join('\n');
        const more = (fileContext.rows || []).length > 50 ? `\n...(${fileContext.rows.length - 50} more rows not shown)` : '';
        parts.push(`\nThe user attached a spreadsheet/CSV "${fileContext.fileName}" with columns: ${fileContext.headers.join(', ')}\nSample rows:\n${previewRows}${more}\nThis is reference data they shared, not necessarily anything already in the database — use it to answer their question (e.g. compare it to a table, or help them import/map it) and don't confuse it with the database schema above.`);
    }
    if (image) {
        if (image.claudeFileName) {
            parts.push(`\nThe user attached an image. It has been saved at this exact path, relative to your current working directory: "${image.claudeFileName}" — you are allowed to Read exactly this one file (and nothing else). Use your Read tool to view it before answering; don't say you can't see it without trying to Read that path first.`);
        } else {
            parts.push(`\nThe user also attached an image, passed directly to you — look at it and use it to answer their question.`);
        }
    }
    if (historyText) parts.push(`\nConversation so far:\n${historyText}`);
    parts.push(`\nUser: ${userMessage}`);
    toolTurns.forEach((t) => {
        parts.push(`\n[You ran a query]\n${formatToolResultForPrompt(t.sql, t.result, t.error)}\nGive your final natural-language answer now using this result; only include another \`\`\`sql block if you genuinely need one more query.`);
    });
    return parts.join('\n');
}

async function runChatTurn(state, onStatus) {
    const { provider, model, database, mode, schema, historyText, userMessage, toolTurns, currentTable, worksheetSql, role, fileContext, image } = state;

    if (toolTurns.length >= MAX_TOOL_ITERATIONS) {
        return { done: true, reply: state.lastReply || 'Reached the query limit for this turn.', sql: null, toolTurns };
    }

    const providerName = (PROVIDERS[provider] && PROVIDERS[provider].name) || provider;
    if (onStatus) onStatus(toolTurns.length === 0 ? `Asking ${providerName}…` : `Asking ${providerName} to continue with the result…`);

    const prompt = buildPrompt({ schema, database, historyText, toolTurns, userMessage, mode, currentTable, worksheetSql, fileContext, image });
    const reply = await runProvider(provider, model, prompt, image);
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
            resumeState: { provider, model, database, mode, schema, historyText, userMessage, toolTurns, currentTable, worksheetSql, role, pendingSql: sql, reply },
        };
    }

    if (onStatus) onStatus(`Running the query on ${database}…`);
    let result, error;
    try {
        result = await execSqlOnDatabase(database, sql, role);
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
    const { message, database, history, provider, model, mode, currentTable, worksheetSql, role, fileContext, image } = req.body;

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

    let savedImage = null;
    try {
        if (image) {
            sendChatEvent(res, { type: 'status', text: 'Processing the attached image…' });
            savedImage = await saveTempImage(image);
        }

        sendChatEvent(res, { type: 'status', text: 'Reading the database schema…' });
        const schema = await getSchemaContext(db);
        const recentHistory = Array.isArray(history) ? history.slice(-6) : [];
        const historyText = recentHistory
            .map(h => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${h.content}`)
            .join('\n');

        const result = await runChatTurn(
            {
                provider, model, database: db, mode: chatMode, schema, historyText,
                userMessage: message.trim(), toolTurns: [],
                currentTable: currentTable || null,
                worksheetSql: typeof worksheetSql === 'string' ? worksheetSql.slice(0, 4000) : '',
                role: role || null,
                fileContext: fileContext && Array.isArray(fileContext.headers) ? fileContext : null,
                image: savedImage,
            },
            (text) => sendChatEvent(res, { type: 'status', text })
        );

        sendChatEvent(res, buildChatResultEvent(result));
    } catch (err) {
        sendChatEvent(res, { type: 'error', error: err.message });
    } finally {
        await cleanupTempImage(savedImage);
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
            result = await execSqlOnDatabase(resumeState.database, resumeState.pendingSql, resumeState.role);
        } catch (e) {
            error = e.message;
        }

        const nextToolTurns = [...resumeState.toolTurns, { sql: resumeState.pendingSql, result, error }];
        const continued = await runChatTurn(
            {
                provider: resumeState.provider, model: resumeState.model, database: resumeState.database,
                mode: resumeState.mode, schema: resumeState.schema, historyText: resumeState.historyText,
                userMessage: resumeState.userMessage, toolTurns: nextToolTurns,
                currentTable: resumeState.currentTable, worksheetSql: resumeState.worksheetSql, role: resumeState.role,
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

// Full table/column map for the SQL editor's autocomplete (CodeMirror's sql-hint addon wants
// { tableName: [col1, col2, ...] }). Keys are provided both unqualified (table) and qualified
// (schema.table) so completion works either way; unqualified keys point at whichever
// schema's table was seen first if there's a name collision across schemas.
app.get('/api/schema-map/:database', async (req, res) => {
    const { database } = req.params;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const result = await dbPool.query(`
            SELECT table_schema, table_name, column_name
            FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY table_schema, table_name, ordinal_position
        `);
        await dbPool.end();

        const map = {};
        for (const row of result.rows) {
            const qualified = `${row.table_schema}.${row.table_name}`;
            if (!map[qualified]) map[qualified] = [];
            map[qualified].push(row.column_name);

            if (!map[row.table_name]) map[row.table_name] = [];
            if (!map[row.table_name].includes(row.column_name)) map[row.table_name].push(row.column_name);
        }

        res.json(map);
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
async function getPrimaryKeyColumns(dbPool, schema, table) {
    const result = await dbPool.query(`
        SELECT a.attname AS column_name
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)
    `, [quoteIdentifier(schema), quoteIdentifier(table)]);
    return result.rows.map(r => r.column_name);
}

app.get('/api/table-preview/:database/:schema/:table', async (req, res) => {
    const { database, schema, table } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const role = req.query.role;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        // Get row count
        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const countResult = await runQueryAsRole(dbPool, `SELECT COUNT(*) AS total FROM ${qualifiedTable}`, role);

        const result = await runQueryAsRole(dbPool, `SELECT * FROM ${qualifiedTable} LIMIT $1`, role, [limit]);

        let primaryKey = [];
        try {
            primaryKey = await getPrimaryKeyColumns(dbPool, schema, table);
        } catch (e) {
            primaryKey = []; // e.g. the object is a view, which has no primary key
        }

        await dbPool.end();

        res.json({
            columns: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
            rows: result.rows,
            totalRows: parseInt(countResult.rows[0].total),
            rowCount: result.rowCount,
            primaryKey,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update a single cell/row, matched by primary key — used by the data preview's inline editor.
app.patch('/api/table-preview/:database/:schema/:table/row', async (req, res) => {
    const { database, schema, table } = req.params;
    const { primaryKey, changes, role } = req.body;

    if (!primaryKey || typeof primaryKey !== 'object' || Object.keys(primaryKey).length === 0) {
        return res.status(400).json({ error: 'No primary key provided — this table has no primary key, so individual rows cannot be safely edited.' });
    }
    if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
        return res.status(400).json({ error: 'No changes provided' });
    }

    try {
        const dbPool = createPool({ database }, { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 });
        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

        const changeEntries = Object.entries(changes);
        const pkEntries = Object.entries(primaryKey);
        const params = [];

        const setClause = changeEntries.map(([col, val]) => {
            params.push(val);
            return `${quoteIdentifier(col)} = $${params.length}`;
        }).join(', ');

        const whereClause = pkEntries.map(([col, val]) => {
            params.push(val);
            return `${quoteIdentifier(col)} = $${params.length}`;
        }).join(' AND ');

        const result = await runQueryAsRole(
            dbPool, `UPDATE ${qualifiedTable} SET ${setClause} WHERE ${whereClause}`, role, params
        );
        await dbPool.end();

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'No matching row found — it may have been edited or deleted elsewhere.' });
        }
        res.json({ success: true, rowCount: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a single row, matched by primary key — used by the data preview's delete button.
app.delete('/api/table-preview/:database/:schema/:table/row', async (req, res) => {
    const { database, schema, table } = req.params;
    const { primaryKey, role } = req.body;

    if (!primaryKey || typeof primaryKey !== 'object' || Object.keys(primaryKey).length === 0) {
        return res.status(400).json({ error: 'No primary key provided — this table has no primary key, so individual rows cannot be safely deleted.' });
    }

    try {
        const dbPool = createPool({ database }, { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 });
        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

        const pkEntries = Object.entries(primaryKey);
        const params = [];
        const whereClause = pkEntries.map(([col, val]) => {
            params.push(val);
            return `${quoteIdentifier(col)} = $${params.length}`;
        }).join(' AND ');

        const result = await runQueryAsRole(
            dbPool, `DELETE FROM ${qualifiedTable} WHERE ${whereClause}`, role, params
        );
        await dbPool.end();

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'No matching row found — it may have already been deleted.' });
        }
        res.json({ success: true, rowCount: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Import parsed CSV rows into a new or existing table (client parses the CSV and infers types;
// this endpoint only validates identifiers/types and does the CREATE TABLE + chunked INSERTs).
const IMPORT_COLUMN_TYPES = new Set(['TEXT', 'INTEGER', 'BIGINT', 'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP']);
const IMPORT_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

app.post('/api/import/:database/:schema', async (req, res) => {
    const { database, schema } = req.params;
    const { table, createNew, columns, rows } = req.body;

    if (!table || !IMPORT_IDENTIFIER_RE.test(table)) {
        return res.status(400).json({ error: 'Invalid table name' });
    }
    if (!Array.isArray(columns) || columns.length === 0) {
        return res.status(400).json({ error: 'No columns provided' });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'No rows provided' });
    }
    for (const col of columns) {
        if (!col.name || !IMPORT_IDENTIFIER_RE.test(col.name)) {
            return res.status(400).json({ error: `Invalid column name: ${col.name}` });
        }
        if (!IMPORT_COLUMN_TYPES.has(String(col.type || '').toUpperCase())) {
            return res.status(400).json({ error: `Invalid column type: ${col.type}` });
        }
    }

    const dbPool = createPool({ database }, { max: 3, idleTimeoutMillis: 15000, connectionTimeoutMillis: 5000 });
    const client = await dbPool.connect();
    const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    try {
        await client.query('BEGIN');

        let tableCreated = false;
        if (createNew) {
            const colDefs = columns.map(c => `${quoteIdentifier(c.name)} ${c.type.toUpperCase()}`).join(', ');
            await client.query(`CREATE TABLE ${qualifiedTable} (${colDefs})`);
            tableCreated = true;
        }

        const colList = columns.map(c => quoteIdentifier(c.name)).join(', ');
        const CHUNK_SIZE = 500;
        let rowsInserted = 0;

        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            const chunk = rows.slice(i, i + CHUNK_SIZE);
            const params = [];
            const valueRows = chunk.map((row) => {
                const placeholders = row.map((val) => {
                    params.push(val === '' ? null : val);
                    return `$${params.length}`;
                });
                return `(${placeholders.join(', ')})`;
            }).join(', ');

            await client.query(`INSERT INTO ${qualifiedTable} (${colList}) VALUES ${valueRows}`, params);
            rowsInserted += chunk.length;
        }

        await client.query('COMMIT');
        res.json({ success: true, rowsInserted, tableCreated });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
        await dbPool.end();
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

// Database-level details for the right-click "Details" panel. Postgres has no built-in
// creation-timestamp catalog for databases (no audit log by default) — owner is the closest
// real proxy for "who made this", and is what's actually shown; we don't fabricate a date.
app.get('/api/database-details/:database', async (req, res) => {
    const { database } = req.params;
    try {
        const adminPool = createPool(
            { database: 'postgres' },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const infoResult = await adminPool.query(`
            SELECT
                d.datname AS name,
                pg_get_userbyid(d.datdba) AS owner,
                pg_size_pretty(pg_database_size(d.datname)) AS size,
                pg_encoding_to_char(d.encoding) AS encoding,
                d.datcollate AS collation,
                d.datconnlimit AS connection_limit,
                d.datistemplate AS is_template
            FROM pg_database d
            WHERE d.datname = $1
        `, [database]);

        if (infoResult.rows.length === 0) {
            await adminPool.end();
            return res.status(404).json({ error: `Database "${database}" not found` });
        }

        const aclResult = await adminPool.query(`
            SELECT
                CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
                a.privilege_type AS privilege
            FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
            WHERE d.datname = $1
            ORDER BY grantee, a.privilege_type
        `, [database]);

        await adminPool.end();

        res.json({
            ...infoResult.rows[0],
            accessList: aclResult.rows,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// View definition + a lightweight dependency list (what this object references, and what
// references it) pulled straight from Postgres's own catalog — not a full lineage graph.
app.get('/api/lineage/:database/:schema/:object', async (req, res) => {
    const { database, schema, object } = req.params;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const defResult = await dbPool.query(`
            SELECT view_definition FROM information_schema.views
            WHERE table_schema = $1 AND table_name = $2
        `, [schema, object]);

        const dependsOnResult = await dbPool.query(`
            SELECT DISTINCT table_schema, table_name
            FROM information_schema.view_table_usage
            WHERE view_schema = $1 AND view_name = $2
            ORDER BY table_schema, table_name
        `, [schema, object]);

        const usedByResult = await dbPool.query(`
            SELECT DISTINCT view_schema, view_name
            FROM information_schema.view_table_usage
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY view_schema, view_name
        `, [schema, object]);

        await dbPool.end();

        res.json({
            definition: defResult.rows[0] ? defResult.rows[0].view_definition : null,
            dependsOn: dependsOnResult.rows.map(r => ({ schema: r.table_schema, name: r.table_name })),
            usedBy: usedByResult.rows.map(r => ({ schema: r.view_schema, name: r.view_name })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Roles & Grants (real Postgres RBAC — reads/writes actual pg_roles and privileges) ──

app.get('/api/roles', async (req, res) => {
    try {
        const adminPool = createPool(
            { database: 'postgres' },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );
        const result = await adminPool.query(`
            SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin
            FROM pg_roles
            WHERE rolname NOT LIKE 'pg\_%'
            ORDER BY rolname
        `);
        await adminPool.end();
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/roles', async (req, res) => {
    const { name, password, canLogin, createDb, createRole, ifNotExists } = req.body;
    try {
        const roleName = validateIdentifier(name, 'Role name');
        const adminPool = createPool(
            { database: 'postgres' },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );

        const clauses = [canLogin ? 'LOGIN' : 'NOLOGIN'];
        if (createDb) clauses.push('CREATEDB');
        if (createRole) clauses.push('CREATEROLE');
        if (canLogin && password) {
            const escaped = String(password).replace(/'/g, "''");
            clauses.push(`PASSWORD '${escaped}'`);
        }

        try {
            await adminPool.query(`CREATE ROLE ${quoteIdentifier(roleName)} ${clauses.join(' ')}`);
        } catch (createErr) {
            // 42710 = duplicate_object (role already exists) — fine when quick-creating standard role templates.
            if (createErr.code === '42710' && ifNotExists) {
                await adminPool.end();
                res.json({ success: true, alreadyExisted: true });
                return;
            }
            throw createErr;
        }

        await adminPool.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/roles/:name', async (req, res) => {
    try {
        const roleName = validateIdentifier(req.params.name, 'Role name');
        const adminPool = createPool(
            { database: 'postgres' },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );
        try {
            await adminPool.query(`DROP ROLE ${quoteIdentifier(roleName)}`);
        } catch (dropErr) {
            // 2BP01 = dependent_objects_still_exist — the role still owns or has grants on
            // something (possibly in a different database than 'postgres').
            if (dropErr.code === '2BP01') {
                throw new Error(`Can't delete "${roleName}" — it still has privileges granted somewhere (check the Permissions tab on tables it can access, or Revoke its database-wide access first).`);
            }
            throw dropErr;
        }
        await adminPool.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/grants/:database/:schema', async (req, res) => {
    const { database, schema } = req.params;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );
        const result = await dbPool.query(`
            SELECT grantee, table_name, privilege_type
            FROM information_schema.role_table_grants
            WHERE table_schema = $1 AND grantee <> 'postgres' AND grantor <> grantee
            ORDER BY table_name, grantee, privilege_type
        `, [schema]);
        await dbPool.end();
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const GRANT_PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']);

app.post('/api/grants/:database/:schema/:table', async (req, res) => {
    const { database, schema, table } = req.params;
    const { role, privilege, action } = req.body; // action: 'grant' | 'revoke'
    try {
        const roleName = validateIdentifier(role, 'Role name');
        const priv = String(privilege || '').toUpperCase();
        if (!GRANT_PRIVILEGES.has(priv)) {
            throw new Error(`Invalid privilege: ${privilege}`);
        }

        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );
        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

        if (action === 'revoke') {
            await dbPool.query(`REVOKE ${priv} ON ${qualifiedTable} FROM ${quoteIdentifier(roleName)}`);
        } else {
            await dbPool.query(`GRANT ${priv} ON ${qualifiedTable} TO ${quoteIdentifier(roleName)}`);
        }
        await dbPool.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Database-wide access: grants a privilege on every current table in a schema, AND sets a
// default privilege so tables created later are automatically covered too — this is the
// real Postgres idiom for "give this role access to this whole database" (Postgres has no
// single ON DATABASE data-privilege the way Snowflake does; ALL TABLES + ALTER DEFAULT
// PRIVILEGES together is the closest honest equivalent).
app.post('/api/grants/:database/database-wide', async (req, res) => {
    const { database } = req.params;
    const { schema, role, privilege, action } = req.body; // action: 'grant' | 'revoke'
    try {
        const roleName = validateIdentifier(role, 'Role name');
        const schemaName = validateIdentifier(schema || 'public', 'Schema name');
        const priv = String(privilege || '').toUpperCase();
        if (!GRANT_PRIVILEGES.has(priv)) {
            throw new Error(`Invalid privilege: ${privilege}`);
        }

        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 }
        );
        const qualifiedSchema = quoteIdentifier(schemaName);
        const quotedRole = quoteIdentifier(roleName);

        if (action === 'revoke') {
            await dbPool.query(`REVOKE ${priv} ON ALL TABLES IN SCHEMA ${qualifiedSchema} FROM ${quotedRole}`);
            await dbPool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${qualifiedSchema} REVOKE ${priv} ON TABLES FROM ${quotedRole}`);
            // Mirror the schema-level USAGE grant that 'grant' adds, so a full revoke leaves no
            // trace behind — otherwise DROP ROLE later fails with "objects depend on it".
            await dbPool.query(`REVOKE USAGE ON SCHEMA ${qualifiedSchema} FROM ${quotedRole}`);
        } else {
            await dbPool.query(`GRANT USAGE ON SCHEMA ${qualifiedSchema} TO ${quotedRole}`);
            await dbPool.query(`GRANT ${priv} ON ALL TABLES IN SCHEMA ${qualifiedSchema} TO ${quotedRole}`);
            await dbPool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${qualifiedSchema} GRANT ${priv} ON TABLES TO ${quotedRole}`);
        }
        await dbPool.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Change History ("time travel" analog — trigger-based audit log, not literal AS OF queries) ──

const HISTORY_SUFFIX = '_history';

app.get('/api/history-tracking/:database/:schema/:table/status', async (req, res) => {
    const { database, schema, table } = req.params;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );
        const historyTable = `${table}${HISTORY_SUFFIX}`;
        const result = await dbPool.query(`
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = $2
        `, [schema, historyTable]);
        await dbPool.end();
        res.json({ enabled: result.rows.length > 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/history-tracking/:database/:schema/:table/enable', async (req, res) => {
    const { database, schema, table } = req.params;
    try {
        validateIdentifier(table, 'Table name');
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 }
        );
        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const historyTable = `${table}${HISTORY_SUFFIX}`;
        const qualifiedHistoryTable = `${quoteIdentifier(schema)}.${quoteIdentifier(historyTable)}`;
        const triggerName = `${table}_history_trigger`;

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS ${qualifiedHistoryTable} (
                _history_id BIGSERIAL PRIMARY KEY,
                _op TEXT NOT NULL,
                _changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                _changed_by TEXT NOT NULL DEFAULT current_user,
                _row JSONB NOT NULL
            )
        `);

        await dbPool.query(`
            CREATE OR REPLACE FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier(table + '_history_fn')}()
            RETURNS TRIGGER AS $$
            BEGIN
                IF (TG_OP = 'DELETE') THEN
                    INSERT INTO ${qualifiedHistoryTable} (_op, _row) VALUES ('DELETE', to_jsonb(OLD));
                    RETURN OLD;
                ELSIF (TG_OP = 'UPDATE') THEN
                    INSERT INTO ${qualifiedHistoryTable} (_op, _row) VALUES ('UPDATE', to_jsonb(NEW));
                    RETURN NEW;
                ELSE
                    INSERT INTO ${qualifiedHistoryTable} (_op, _row) VALUES ('INSERT', to_jsonb(NEW));
                    RETURN NEW;
                END IF;
            END;
            $$ LANGUAGE plpgsql;
        `);

        await dbPool.query(`DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${qualifiedTable}`);
        await dbPool.query(`
            CREATE TRIGGER ${quoteIdentifier(triggerName)}
            AFTER INSERT OR UPDATE OR DELETE ON ${qualifiedTable}
            FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier(table + '_history_fn')}()
        `);

        await dbPool.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/history-tracking/:database/:schema/:table/disable', async (req, res) => {
    const { database, schema, table } = req.params;
    try {
        validateIdentifier(table, 'Table name');
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 }
        );
        const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const triggerName = `${table}_history_trigger`;

        await dbPool.query(`DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${qualifiedTable}`);
        await dbPool.query(`DROP FUNCTION IF EXISTS ${quoteIdentifier(schema)}.${quoteIdentifier(table + '_history_fn')}()`);
        // The history table itself is left in place — disabling tracking shouldn't destroy the audit trail already collected.

        await dbPool.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history-tracking/:database/:schema/:table/log', async (req, res) => {
    const { database, schema, table } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    try {
        const dbPool = createPool(
            { database },
            { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 }
        );
        const historyTable = `${table}${HISTORY_SUFFIX}`;
        const qualifiedHistoryTable = `${quoteIdentifier(schema)}.${quoteIdentifier(historyTable)}`;

        const result = await dbPool.query(`
            SELECT _history_id, _op, _changed_at, _changed_by, _row
            FROM ${qualifiedHistoryTable}
            ORDER BY _history_id DESC
            LIMIT $1
        `, [limit]);
        await dbPool.end();
        res.json(result.rows);
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
