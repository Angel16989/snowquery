const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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
const PORT = 3000;

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
