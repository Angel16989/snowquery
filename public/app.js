// ═══════════════════════════════════════════════════════
// SnowQuery — Client-side Application
// ═══════════════════════════════════════════════════════

const API_BASE = '';

// ── State ──
let editor = null;
let worksheets = [];
let activeWorksheetId = null;
let currentView = 'worksheets';
let objectTreeData = {};
let lastResults = null;
let isResizing = false;
let currentSchemaMap = {}; // mutated in place, never reassigned — CodeMirror holds this exact object by reference
let aiSettings = { consented: false }; // provider/model/mode live per-session now — see chatSessions
let providersScanCache = null;
let pendingAttachment = null; // { type:'image', dataUrl, fileName } | { type:'file', fileName, headers, rows }
let skills = [];

// ═══════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    bootstrapApp();
});

async function bootstrapApp() {
    await loadConnectionDefaults();
    initEditor();
    initWorksheets();
    initNavigation();
    initResizer();
    initEventListeners();
    initChat();
    checkConnection();
    loadDatabases();
    loadDbSelector();
    loadRoleSelector();
    loadSchemaMap(document.getElementById('db-selector').value || 'learn_sql');
    checkSetupStatus();

    // Show the worksheets view with sidebar collapsed by default
    switchView('worksheets');
}

async function loadConnectionDefaults() {
    try {
        const res = await fetch(`${API_BASE}/api/config`);
        if (!res.ok) return;
        const config = await res.json();
        const hostEl = document.getElementById('setting-host');
        const portEl = document.getElementById('setting-port');
        const userEl = document.getElementById('setting-user');
        const dbEl = document.getElementById('setting-database');

        if (hostEl && !hostEl.value) hostEl.value = config.host || '';
        if (portEl && !portEl.value) portEl.value = config.port || '';
        if (userEl && !userEl.value) userEl.value = config.user || '';
        if (dbEl && !dbEl.value) dbEl.value = config.database || '';
    } catch (e) {
        // Use local placeholders if the config endpoint is unavailable.
    }
}

// ── SQL autocomplete: position-aware, not just a flat keyword/table list ──
// Priority mirrors how you'd actually read a query left to right: start of a statement suggests
// statement keywords, after FROM/JOIN/INTO/UPDATE suggests tables, after `alias.` resolves the
// alias back to its real table (scanning FROM/JOIN clauses already typed) and suggests that
// table's real columns, and everywhere else suggests columns already in scope plus functions.

const SQL_STATEMENT_KEYWORDS = [
    'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'CREATE SCHEMA',
    'CREATE INDEX', 'CREATE VIEW', 'CREATE DATABASE', 'ALTER TABLE', 'DROP TABLE',
    'DROP DATABASE', 'WITH', 'EXPLAIN', 'TRUNCATE',
];
const SQL_CLAUSE_KEYWORDS = [
    'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN',
    'RIGHT JOIN', 'INNER JOIN', 'ON', 'AND', 'OR', 'AS', 'DISTINCT', 'UNION', 'VALUES', 'SET',
];
const SQL_FUNCTION_KEYWORDS = [
    'COUNT(*)', 'SUM(', 'AVG(', 'MAX(', 'MIN(', 'NOW()', 'COALESCE(', 'CAST(', 'ROUND(',
    'DATE_TRUNC(', 'EXTRACT(',
];

// Scans the whole query for `FROM x`, `JOIN x`, `x AS y`, `x y` so `alias.col` and bare `col`
// completions can resolve back to a real table's actual columns, not just the alias name.
function resolveTableAliases(fullText) {
    const refs = {};
    const re = /\b(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/gi;
    let m;
    while ((m = re.exec(fullText))) {
        const real = m[1];
        const alias = m[2];
        const bareName = real.includes('.') ? real.slice(real.lastIndexOf('.') + 1) : real;
        refs[bareName] = real;
        if (alias && !/^(ON|WHERE|GROUP|ORDER|LIMIT|JOIN)$/i.test(alias)) refs[alias] = real;
    }
    return refs;
}

function sqlAutocompleteHint(cm) {
    const cursor = cm.getCursor();
    const fullText = cm.getValue();
    const offset = cm.indexFromPos(cursor);
    const textBefore = fullText.slice(0, offset);
    const tableRefs = resolveTableAliases(fullText);

    const wordMatch = /[\w.]*$/.exec(textBefore);
    const partial = wordMatch ? wordMatch[0] : '';
    const start = cursor.ch - partial.length;

    let candidates = [];
    let dotPrefix = null;

    if (partial.includes('.')) {
        dotPrefix = partial.slice(0, partial.lastIndexOf('.'));
        const realTable = tableRefs[dotPrefix] || dotPrefix;
        candidates = (currentSchemaMap[realTable] || []).map(c => `${dotPrefix}.${c}`);
    } else {
        const before = textBefore.slice(0, textBefore.length - partial.length);
        const trimmedBefore = before.replace(/\s+$/, '');
        const lastWords = trimmedBefore.toUpperCase().trim().split(/\s+/).slice(-2);
        const lastTwo = lastWords.join(' ');
        const lastOne = lastWords[lastWords.length - 1] || '';
        const isStatementStart = !trimmedBefore.trim() || /;\s*$/.test(trimmedBefore);

        if (isStatementStart) {
            candidates = SQL_STATEMENT_KEYWORDS;
        } else if (/^(FROM|JOIN|INTO|UPDATE|TABLE)$/.test(lastOne) || /(LEFT|RIGHT|INNER|FULL|CROSS)\s+JOIN$/.test(lastTwo)) {
            candidates = Object.keys(currentSchemaMap);
        } else {
            const scopedColumns = new Set();
            Object.values(tableRefs).forEach(t => (currentSchemaMap[t] || []).forEach(c => scopedColumns.add(c)));
            candidates = [...scopedColumns, ...SQL_FUNCTION_KEYWORDS, ...SQL_CLAUSE_KEYWORDS, ...Object.keys(currentSchemaMap)];
        }
    }

    const filterText = (dotPrefix ? partial.slice(partial.lastIndexOf('.') + 1) : partial).toLowerCase();
    let list = dotPrefix
        ? candidates.filter(c => c.split('.').pop().toLowerCase().startsWith(filterText))
        : candidates.filter(c => c.toLowerCase().startsWith(filterText));

    list = [...new Set(list)].slice(0, 30);
    if (list.length === 0) return null;

    return { list, from: CodeMirror.Pos(cursor.line, start), to: cursor };
}

// ── CodeMirror Editor ──
function initEditor() {
    const editorEl = document.getElementById('sql-editor');
    editor = CodeMirror(editorEl, {
        mode: 'text/x-pgsql',
        theme: 'material-darker',
        lineNumbers: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: true,
        indentWithTabs: false,
        indentUnit: 4,
        tabSize: 4,
        lineWrapping: false,
        placeholder: 'Write your SQL here...',
        extraKeys: {
            'Ctrl-Enter': () => runQuery(),
            'Cmd-Enter': () => runQuery(),
            'Ctrl-S': (cm) => { saveCurrentWorksheet(); showToast('Worksheet saved', 'success'); },
            'Ctrl-Space': 'autocomplete',
            'Ctrl-/': 'toggleComment',
        },
        hintOptions: {
            hint: sqlAutocompleteHint,
            completeSingle: false,
            completeOnSingleClick: false,
        },
    });

    // Auto-complete on typing
    editor.on('inputRead', (cm, change) => {
        if (change.text[0] && /[a-zA-Z_.]/.test(change.text[0])) {
            const cursor = cm.getCursor();
            const token = cm.getTokenAt(cursor);
            if (token.string.length >= 2 || change.text[0] === '.') {
                cm.showHint({ hint: sqlAutocompleteHint, completeSingle: false });
            }
        }
    });
}

// ═══════════════════════════════════════════
// Worksheet Management
// ═══════════════════════════════════════════

function initWorksheets() {
    // Load from localStorage
    const saved = localStorage.getItem('snowquery_worksheets');
    if (saved) {
        try {
            worksheets = JSON.parse(saved);
        } catch (e) {
            worksheets = [];
        }
    }

    if (worksheets.length === 0) {
        addWorksheet('Worksheet 1', '-- Welcome to SnowQuery!\n-- Try running: SELECT * FROM employees LIMIT 10;\n\nSELECT * FROM employees LIMIT 10;');
    } else {
        activeWorksheetId = worksheets[0].id;
        renderWorksheetTabs();
        loadWorksheet(activeWorksheetId);
    }
}

function addWorksheet(name, sql = '') {
    const id = 'ws_' + Date.now().toString(36);
    const ws = {
        id,
        name: name || `Worksheet ${worksheets.length + 1}`,
        sql: sql || '',
        database: 'learn_sql',
        role: '',
        createdAt: new Date().toISOString(),
    };
    worksheets.push(ws);
    activeWorksheetId = id;
    saveWorksheets();
    renderWorksheetTabs();
    loadWorksheet(id);
}

function loadWorksheet(id) {
    const ws = worksheets.find(w => w.id === id);
    if (!ws) return;
    activeWorksheetId = id;
    editor.setValue(ws.sql || '');
    document.getElementById('db-selector').value = ws.database || 'learn_sql';
    const roleSelector = document.getElementById('role-selector');
    if ([...roleSelector.options].some(o => o.value === (ws.role || ''))) {
        roleSelector.value = ws.role || '';
    } else {
        roleSelector.value = '';
    }
    renderWorksheetTabs();
}

function saveCurrentWorksheet() {
    const ws = worksheets.find(w => w.id === activeWorksheetId);
    if (ws) {
        ws.sql = editor.getValue();
        ws.database = document.getElementById('db-selector').value;
        ws.role = document.getElementById('role-selector').value;
        saveWorksheets();
    }
}

function deleteWorksheet(id) {
    if (worksheets.length <= 1) {
        showToast('Cannot delete the last worksheet', 'error');
        return;
    }
    worksheets = worksheets.filter(w => w.id !== id);
    if (activeWorksheetId === id) {
        activeWorksheetId = worksheets[0].id;
        loadWorksheet(activeWorksheetId);
    }
    saveWorksheets();
    renderWorksheetTabs();
}

function saveWorksheets() {
    // Save current editor content
    const ws = worksheets.find(w => w.id === activeWorksheetId);
    if (ws && editor) {
        ws.sql = editor.getValue();
    }
    localStorage.setItem('snowquery_worksheets', JSON.stringify(worksheets));
}

function renderWorksheetTabs() {
    const container = document.getElementById('worksheet-tabs');
    container.innerHTML = '';

    worksheets.forEach(ws => {
        const tab = document.createElement('div');
        tab.className = `worksheet-tab${ws.id === activeWorksheetId ? ' active' : ''}`;
        tab.dataset.id = ws.id;

        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = ws.name;
        label.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const newName = prompt('Rename worksheet:', ws.name);
            if (newName && newName.trim()) {
                ws.name = newName.trim();
                saveWorksheets();
                renderWorksheetTabs();
            }
        });

        const closeBtn = document.createElement('span');
        closeBtn.className = 'tab-close';
        closeBtn.innerHTML = '×';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteWorksheet(ws.id);
        });

        tab.appendChild(label);
        tab.appendChild(closeBtn);

        tab.addEventListener('click', () => {
            saveCurrentWorksheet();
            loadWorksheet(ws.id);
        });

        container.appendChild(tab);
    });
}

// ═══════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════

function initNavigation() {
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            switchView(view);
        });
    });
}

function switchView(view) {
    currentView = view;

    // Update nav buttons
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });

    // Hide all sidebar panels
    document.querySelectorAll('.sidebar-panel').forEach(p => p.style.display = 'none');

    const sidebar = document.getElementById('sidebar');

    if (view === 'worksheets') {
        sidebar.classList.add('collapsed');
    } else {
        sidebar.classList.remove('collapsed');
        const panelId = `sidebar-${view}`;
        const panel = document.getElementById(panelId);
        if (panel) {
            panel.style.display = 'flex';
        }

        // Load data for the view
        if (view === 'data') loadObjectTree();
        if (view === 'history') loadHistory();
        if (view === 'samples') loadSamples();
        if (view === 'roles') loadRoles();
    }

    // Refresh editor layout after sidebar toggle
    setTimeout(() => editor && editor.refresh(), 250);
}

// ═══════════════════════════════════════════
// Query Execution
// ═══════════════════════════════════════════

async function runQuery() {
    let sql = editor.getSelection() || editor.getValue();
    sql = sql.trim();

    if (!sql) {
        showToast('No query to run', 'error');
        return;
    }

    const runBtn = document.getElementById('run-query');
    runBtn.classList.add('running');
    runBtn.querySelector('span').textContent = 'Running...';

    // Show results tab
    showResultsTab('results');

    try {
        const database = document.getElementById('db-selector').value;
        const role = document.getElementById('role-selector').value;
        const response = await fetch(`${API_BASE}/api/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql, database, role }),
        });

        const data = await response.json();

        if (response.ok) {
            lastResults = data;
            renderResults(data);
            showResultsInfo(data);
            document.getElementById('export-csv').style.display = data.rows && data.rows.length > 0 ? 'inline-flex' : 'none';
        } else {
            renderError(data);
            document.getElementById('export-csv').style.display = 'none';
        }
    } catch (err) {
        renderError({ error: 'Connection failed: ' + err.message });
        document.getElementById('export-csv').style.display = 'none';
    } finally {
        runBtn.classList.remove('running');
        runBtn.querySelector('span').textContent = 'Run';
    }
}

function renderResults(data) {
    const container = document.getElementById('results-table-container');
    const welcome = document.getElementById('results-welcome');
    const messagesEl = document.getElementById('results-messages');

    welcome.style.display = 'none';
    messagesEl.style.display = 'none';
    container.style.display = 'block';

    if (!data.rows || data.rows.length === 0) {
        if (data.command && data.command !== 'SELECT') {
            container.style.display = 'none';
            messagesEl.style.display = 'block';
            messagesEl.innerHTML = `<div class="message-success">✓ ${data.command} executed successfully. ${data.rowCount !== null ? data.rowCount + ' row(s) affected.' : ''}</div>
            <div class="message-info">Duration: ${data.duration}ms</div>`;
            showResultsTab('messages');

            // Refresh object tree if DDL command
            if (['CREATE', 'DROP', 'ALTER'].includes(data.command)) {
                loadObjectTree();
                loadSchemaMap(document.getElementById('db-selector').value);
            }
            return;
        }
        container.innerHTML = '<div class="empty-state">Query returned no rows</div>';
        return;
    }

    const columns = data.columns || [];
    const rows = data.rows || [];

    let html = '<table class="results-table"><thead><tr>';
    html += '<th class="row-number">#</th>';
    columns.forEach((col, i) => {
        html += `<th data-col="${i}" onclick="sortResults(${i})">${escapeHtml(col.name)}<span class="sort-indicator"></span></th>`;
    });
    html += '</tr></thead><tbody>';

    rows.forEach((row, rowIdx) => {
        html += '<tr>';
        html += `<td class="row-number">${rowIdx + 1}</td>`;
        columns.forEach(col => {
            const val = row[col.name];
            if (val === null || val === undefined) {
                html += `<td class="null-value">NULL</td>`;
            } else if (typeof val === 'object') {
                html += `<td>${escapeHtml(JSON.stringify(val))}</td>`;
            } else {
                html += `<td>${escapeHtml(String(val))}</td>`;
            }
        });
        html += '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

function renderError(data) {
    const container = document.getElementById('results-table-container');
    const welcome = document.getElementById('results-welcome');
    const messagesEl = document.getElementById('results-messages');

    welcome.style.display = 'none';
    container.style.display = 'none';
    messagesEl.style.display = 'block';

    let errorHtml = `<div class="message-error">✗ ERROR: ${escapeHtml(data.error)}</div>`;
    if (data.detail) {
        errorHtml += `<div class="message-info">Detail: ${escapeHtml(data.detail)}</div>`;
    }
    if (data.hint) {
        errorHtml += `<div class="message-info">Hint: ${escapeHtml(data.hint)}</div>`;
    }
    if (data.duration !== undefined) {
        errorHtml += `<div class="message-info">Duration: ${data.duration}ms</div>`;
    }

    messagesEl.innerHTML = errorHtml;
    showResultsTab('messages');
}

function showResultsInfo(data) {
    const info = document.getElementById('results-info');
    const parts = [];
    if (data.rowCount !== null && data.rowCount !== undefined) {
        parts.push(`${data.rowCount} row${data.rowCount !== 1 ? 's' : ''}`);
    }
    if (data.duration !== undefined) {
        parts.push(`${data.duration}ms`);
    }
    if (data.command) {
        parts.push(data.command);
    }
    info.textContent = parts.join(' • ');
}

let sortColumn = -1;
let sortAsc = true;

function sortResults(colIndex) {
    if (!lastResults || !lastResults.rows) return;

    if (sortColumn === colIndex) {
        sortAsc = !sortAsc;
    } else {
        sortColumn = colIndex;
        sortAsc = true;
    }

    const colName = lastResults.columns[colIndex].name;
    lastResults.rows.sort((a, b) => {
        let va = a[colName], vb = b[colName];
        if (va === null) return 1;
        if (vb === null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') {
            return sortAsc ? va - vb : vb - va;
        }
        va = String(va);
        vb = String(vb);
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    renderResults(lastResults);

    // Update sort indicators
    const ths = document.querySelectorAll('.results-table th[data-col]');
    ths.forEach(th => {
        const indicator = th.querySelector('.sort-indicator');
        if (parseInt(th.dataset.col) === colIndex) {
            indicator.textContent = sortAsc ? ' ▲' : ' ▼';
        } else {
            indicator.textContent = '';
        }
    });
}

function showResultsTab(tab) {
    document.querySelectorAll('.results-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });

    const container = document.getElementById('results-table-container');
    const messages = document.getElementById('results-messages');

    if (tab === 'results') {
        container.style.display = 'block';
        messages.style.display = 'none';
    } else {
        container.style.display = 'none';
        messages.style.display = 'block';
    }
}

// ═══════════════════════════════════════════
// Object Explorer
// ═══════════════════════════════════════════

async function loadDatabases() {
    try {
        const res = await fetch(`${API_BASE}/api/databases`);
        if (res.ok) {
            const dbs = await res.json();
            objectTreeData.databases = dbs;
        }
    } catch (e) {
        console.error('Failed to load databases:', e);
    }
}

async function createDatabase() {
    const name = prompt('Enter a name for the new database:');
    if (!name || !name.trim()) return;

    try {
        const res = await fetch(`${API_BASE}/api/databases`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim() }),
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`Database "${data.database}" created`, 'success');
            const tree = document.getElementById('object-tree');
            tree.innerHTML = '';
            loadObjectTree();
            loadDbSelector();
        } else {
            showToast(data.error || 'Failed to create database', 'error');
        }
    } catch (e) {
        showToast('Failed to create database: ' + e.message, 'error');
    }
}

async function loadDbSelector() {
    try {
        const res = await fetch(`${API_BASE}/api/databases`);
        if (res.ok) {
            const dbs = await res.json();
            const selector = document.getElementById('db-selector');
            selector.innerHTML = '';
            dbs.forEach(db => {
                const opt = document.createElement('option');
                opt.value = db.database_name;
                opt.textContent = db.database_name;
                if (db.database_name === 'learn_sql') opt.selected = true;
                selector.appendChild(opt);
            });
        }
    } catch (e) {
        // Selector will keep default value
    }
}

async function loadSchemaMap(database) {
    try {
        const res = await fetch(`${API_BASE}/api/schema-map/${database}`);
        if (!res.ok) return;
        const map = await res.json();
        // Mutate in place — `editor`'s hintOptions.tables holds this exact object by reference.
        Object.keys(currentSchemaMap).forEach(k => delete currentSchemaMap[k]);
        Object.assign(currentSchemaMap, map);
    } catch (e) {
        // Autocomplete just falls back to keyword-only suggestions
    }
}

async function loadRoleSelector() {
    const selector = document.getElementById('role-selector');
    const previousValue = selector.value;
    try {
        const res = await fetch(`${API_BASE}/api/roles`);
        if (!res.ok) return;
        const roles = await res.json();
        selector.innerHTML = '<option value="">Full access (no role)</option>';
        roles.filter(r => r.rolname !== 'postgres').forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.rolname;
            opt.textContent = r.rolname;
            selector.appendChild(opt);
        });
        if ([...selector.options].some(o => o.value === previousValue)) {
            selector.value = previousValue;
        }
    } catch (e) {
        // Selector will keep default value
    }
}

async function loadObjectTree() {
    const tree = document.getElementById('object-tree');
    tree.innerHTML = '<div class="tree-loading"><div class="loading-spinner"></div></div>';

    try {
        const dbRes = await fetch(`${API_BASE}/api/databases`);
        if (!dbRes.ok) throw new Error('Failed to load databases');
        const databases = await dbRes.json();

        tree.innerHTML = '';

        for (const db of databases) {
            const dbNode = createTreeNode({
                type: 'database',
                label: db.database_name,
                icon: '🗄️',
                iconClass: 'db',
                depth: 0,
                expandable: true,
                data: { database: db.database_name },
            });
            tree.appendChild(dbNode);
        }
    } catch (e) {
        tree.innerHTML = `<div class="empty-state">Failed to load databases<br><small>${e.message}</small></div>`;
    }
}

function createTreeNode({ type, label, icon, iconClass, depth, expandable, data, badge }) {
    const node = document.createElement('div');
    node.className = 'tree-node';

    const item = document.createElement('div');
    item.className = 'tree-item';
    item.dataset.depth = depth;
    item.dataset.type = type;

    // Chevron
    if (expandable) {
        const chevron = document.createElement('span');
        chevron.className = 'tree-chevron';
        chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>';
        item.appendChild(chevron);
    } else {
        const spacer = document.createElement('span');
        spacer.style.width = '16px';
        spacer.style.flexShrink = '0';
        item.appendChild(spacer);
    }

    // Icon
    const iconEl = document.createElement('span');
    iconEl.className = `tree-icon ${iconClass || ''}`;
    iconEl.textContent = icon;
    item.appendChild(iconEl);

    // Label
    const labelEl = document.createElement('span');
    labelEl.className = 'tree-label';
    labelEl.textContent = label;
    item.appendChild(labelEl);

    // Badge
    if (badge) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'tree-badge';
        badgeEl.textContent = badge;
        item.appendChild(badgeEl);
    }

    if (type === 'table' || type === 'view') {
        const previewBtn = document.createElement('button');
        previewBtn.className = 'tree-preview-btn';
        previewBtn.title = 'Preview data';
        previewBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        previewBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openTablePreview(data.database, data.schema, data.table, label);
        });
        item.appendChild(previewBtn);
    }

    node.appendChild(item);

    // Children container
    const children = document.createElement('div');
    children.className = 'tree-children';
    node.appendChild(children);

    // Click handler
    item.addEventListener('click', () => {
        if (expandable) {
            toggleTreeNode(node, item, children, type, data);
        } else if (type === 'table' || type === 'view') {
            // Insert table name into editor
            const fullName = `${data.schema}.${data.table}`;
            insertIntoEditor(fullName);
        } else if (type === 'column') {
            insertIntoEditor(data.column);
        }
    });

    if (type === 'database') {
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openDatabaseDetails(data.database, e.clientX, e.clientY);
        });
    }

    return node;
}

async function toggleTreeNode(node, item, children, type, data) {
    const chevron = item.querySelector('.tree-chevron');
    const isExpanded = children.classList.contains('expanded');

    if (isExpanded) {
        children.classList.remove('expanded');
        chevron.classList.remove('expanded');
        return;
    }

    chevron.classList.add('expanded');
    children.classList.add('expanded');

    // If children already loaded, just show them
    if (children.children.length > 0) return;

    // Load children based on type
    children.innerHTML = '<div class="tree-loading" style="padding: 8px 0;">Loading...</div>';

    try {
        if (type === 'database') {
            const res = await fetch(`${API_BASE}/api/schemas/${data.database}`);
            const schemas = await res.json();
            children.innerHTML = '';
            schemas.forEach(s => {
                const schemaNode = createTreeNode({
                    type: 'schema',
                    label: s.schema_name,
                    icon: '📁',
                    iconClass: 'schema',
                    depth: 1,
                    expandable: true,
                    data: { database: data.database, schema: s.schema_name },
                });
                children.appendChild(schemaNode);
            });
        } else if (type === 'schema') {
            const res = await fetch(`${API_BASE}/api/tables/${data.database}/${data.schema}`);
            const tables = await res.json();
            children.innerHTML = '';
            tables.forEach(t => {
                const isView = t.table_type === 'VIEW';
                const tableNode = createTreeNode({
                    type: isView ? 'view' : 'table',
                    label: t.table_name,
                    icon: isView ? '👁️' : '📋',
                    iconClass: isView ? 'view' : 'table',
                    depth: 2,
                    expandable: true,
                    data: { database: data.database, schema: data.schema, table: t.table_name },
                    badge: isView ? 'VIEW' : undefined,
                });
                children.appendChild(tableNode);
            });
            if (tables.length === 0) {
                children.innerHTML = '<div class="tree-loading" style="padding: 8px 44px; font-size: 11px;">No tables found</div>';
            }
        } else if (type === 'table' || type === 'view') {
            const res = await fetch(`${API_BASE}/api/columns/${data.database}/${data.schema}/${data.table}`);
            const columns = await res.json();
            children.innerHTML = '';
            columns.forEach(col => {
                const typeLabel = formatColumnType(col);
                const colNode = createTreeNode({
                    type: 'column',
                    label: col.column_name,
                    icon: '•',
                    iconClass: 'column',
                    depth: 3,
                    expandable: false,
                    data: { column: col.column_name },
                    badge: typeLabel,
                });
                children.appendChild(colNode);
            });
        }
    } catch (e) {
        children.innerHTML = `<div class="tree-loading" style="color: var(--error);">Error: ${e.message}</div>`;
    }
}

function formatColumnType(col) {
    let type = col.data_type.toUpperCase();
    // Shorten common types
    const map = {
        'CHARACTER VARYING': 'VARCHAR',
        'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP',
        'TIMESTAMP WITH TIME ZONE': 'TIMESTAMPTZ',
        'INTEGER': 'INT',
        'BOOLEAN': 'BOOL',
        'NUMERIC': 'DECIMAL',
    };
    type = map[type] || type;
    if (col.character_maximum_length) {
        type += `(${col.character_maximum_length})`;
    }
    return type;
}

// ── Table/View Data Preview ──

let previewContext = null; // { database, schema, table, columns, primaryKey }

async function openTablePreview(database, schema, table, label) {
    previewContext = { database, schema, table, columns: [], primaryKey: [] };

    const modal = document.getElementById('preview-modal');
    const titleEl = document.getElementById('preview-title');
    const bodyEl = document.getElementById('preview-body');
    const lineageBodyEl = document.getElementById('preview-lineage-body');
    const metaEl = document.getElementById('preview-meta');

    titleEl.textContent = `${schema}.${label}`;
    metaEl.textContent = 'Loading…';
    bodyEl.innerHTML = '<div class="tree-loading"><div class="loading-spinner"></div></div>';
    lineageBodyEl.innerHTML = '';
    switchPreviewTab('data');
    modal.style.display = 'flex';

    try {
        const role = document.getElementById('role-selector').value;
        const res = await fetch(`${API_BASE}/api/table-preview/${database}/${schema}/${table}?limit=100&role=${encodeURIComponent(role)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load preview');

        previewContext.columns = data.columns;
        previewContext.primaryKey = data.primaryKey || [];

        const editableNote = previewContext.primaryKey.length
            ? ' · double-click a cell to edit'
            : ' · read-only (no primary key found)';
        metaEl.textContent = `${data.totalRows.toLocaleString()} total row(s) — showing first ${data.rows.length}${editableNote}`;

        bodyEl.innerHTML = '';
        bodyEl.appendChild(buildPreviewTable(data.columns, data.rows, previewContext.primaryKey));
    } catch (err) {
        metaEl.textContent = '';
        bodyEl.innerHTML = `<div class="empty-state">Failed to load preview<br><small>${escapeHtml(err.message)}</small></div>`;
    }

    loadPreviewLineage(database, schema, table);
    updateChatPlaceholder();
}

const PREVIEW_TABS = ['data', 'lineage', 'permissions', 'history'];

function switchPreviewTab(tab) {
    PREVIEW_TABS.forEach(t => {
        document.getElementById(`preview-tab-${t}`).classList.toggle('active', t === tab);
        document.getElementById(t === 'data' ? 'preview-body' : `preview-${t}-body`).style.display = t === tab ? 'block' : 'none';
    });

    if (!previewContext) return;
    if (tab === 'permissions' && !previewContext.permissionsLoaded) {
        previewContext.permissionsLoaded = true;
        loadPreviewPermissions();
    }
    if (tab === 'history' && !previewContext.historyLoaded) {
        previewContext.historyLoaded = true;
        loadPreviewHistory();
    }
}

async function loadPreviewLineage(database, schema, table) {
    const lineageBodyEl = document.getElementById('preview-lineage-body');
    lineageBodyEl.innerHTML = '<div class="tree-loading"><div class="loading-spinner"></div></div>';

    try {
        const res = await fetch(`${API_BASE}/api/lineage/${database}/${schema}/${table}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load definition');

        lineageBodyEl.innerHTML = '';

        if (data.definition) {
            const section = document.createElement('div');
            section.className = 'lineage-section';
            section.innerHTML = '<h3>View definition</h3>';
            const pre = document.createElement('div');
            pre.className = 'lineage-definition';
            pre.textContent = data.definition.trim();
            section.appendChild(pre);
            lineageBodyEl.appendChild(section);
        }

        lineageBodyEl.appendChild(buildLineageListSection(
            'Depends on (this reads from)',
            data.dependsOn,
            'This object doesn\'t reference any other tables or views.'
        ));
        lineageBodyEl.appendChild(buildLineageListSection(
            'Used by (views that read this)',
            data.usedBy,
            'No views currently depend on this object.'
        ));
    } catch (err) {
        lineageBodyEl.innerHTML = `<div class="empty-state">Failed to load definition<br><small>${escapeHtml(err.message)}</small></div>`;
    }
}

function buildLineageListSection(heading, items, emptyText) {
    const section = document.createElement('div');
    section.className = 'lineage-section';

    const h3 = document.createElement('h3');
    h3.textContent = heading;
    section.appendChild(h3);

    if (!items || items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '0';
        empty.textContent = emptyText;
        section.appendChild(empty);
        return section;
    }

    const list = document.createElement('div');
    list.className = 'lineage-list';
    items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'lineage-item';
        el.textContent = `${item.schema}.${item.name}`;
        list.appendChild(el);
    });
    section.appendChild(list);
    return section;
}

// ── Preview: Permissions tab (grant/revoke real Postgres privileges) ──

const GRANT_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL'];

async function loadPreviewPermissions() {
    const { database, schema, table } = previewContext;
    const body = document.getElementById('preview-permissions-body');
    body.innerHTML = '<div class="tree-loading"><div class="loading-spinner"></div></div>';

    try {
        const [grantsRes, rolesRes] = await Promise.all([
            fetch(`${API_BASE}/api/grants/${database}/${schema}`),
            fetch(`${API_BASE}/api/roles`),
        ]);
        const allGrants = await grantsRes.json();
        const roles = await rolesRes.json();
        if (!grantsRes.ok) throw new Error(allGrants.error || 'Failed to load grants');
        if (!rolesRes.ok) throw new Error(roles.error || 'Failed to load roles');

        const grants = allGrants.filter(g => g.table_name === table);

        body.innerHTML = '';

        const section = document.createElement('div');
        section.className = 'lineage-section';
        section.innerHTML = '<h3>Current grants</h3>';

        if (grants.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.style.padding = '0';
            empty.textContent = 'No roles currently have explicit privileges on this table.';
            section.appendChild(empty);
        } else {
            const list = document.createElement('div');
            list.className = 'lineage-list';
            grants.forEach(g => {
                const row = document.createElement('div');
                row.className = 'grant-row';

                const label = document.createElement('span');
                label.textContent = `${g.grantee} — ${g.privilege_type}`;
                row.appendChild(label);

                const revokeBtn = document.createElement('button');
                revokeBtn.className = 'btn btn-secondary btn-sm';
                revokeBtn.textContent = 'Revoke';
                revokeBtn.addEventListener('click', () => runGrantAction(g.grantee, g.privilege_type, 'revoke'));
                row.appendChild(revokeBtn);

                list.appendChild(row);
            });
            section.appendChild(list);
        }
        body.appendChild(section);

        const formSection = document.createElement('div');
        formSection.className = 'lineage-section';
        formSection.innerHTML = '<h3>Grant a privilege</h3>';

        const form = document.createElement('div');
        form.className = 'grant-form';

        const roleSelect = document.createElement('select');
        roleSelect.className = 'chat-model-select';
        if (roles.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = 'No roles yet — create one first';
            roleSelect.appendChild(opt);
            roleSelect.disabled = true;
        } else {
            roles.filter(r => r.rolname !== 'postgres').forEach(r => {
                const opt = document.createElement('option');
                opt.value = r.rolname;
                opt.textContent = r.rolname;
                roleSelect.appendChild(opt);
            });
        }

        const privSelect = document.createElement('select');
        privSelect.className = 'chat-model-select';
        GRANT_PRIVILEGES.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            privSelect.appendChild(opt);
        });

        const grantBtn = document.createElement('button');
        grantBtn.className = 'btn btn-primary btn-sm';
        grantBtn.textContent = 'Grant';
        grantBtn.disabled = roles.length === 0;
        grantBtn.addEventListener('click', () => runGrantAction(roleSelect.value, privSelect.value, 'grant'));

        form.appendChild(roleSelect);
        form.appendChild(privSelect);
        form.appendChild(grantBtn);
        formSection.appendChild(form);
        body.appendChild(formSection);
    } catch (err) {
        body.innerHTML = `<div class="empty-state">Failed to load permissions<br><small>${escapeHtml(err.message)}</small></div>`;
    }
}

async function runGrantAction(role, privilege, action) {
    const { database, schema, table } = previewContext;
    try {
        const res = await fetch(`${API_BASE}/api/grants/${database}/${schema}/${table}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role, privilege, action }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Failed to ${action}`);

        showToast(`${action === 'grant' ? 'Granted' : 'Revoked'} ${privilege} ${action === 'grant' ? 'to' : 'from'} ${role}`, 'success');
        previewContext.permissionsLoaded = false;
        loadPreviewPermissions();
        previewContext.permissionsLoaded = true;
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Preview: History tab (change-tracking audit log — the "time travel" analog) ──

async function loadPreviewHistory() {
    const { database, schema, table } = previewContext;
    const body = document.getElementById('preview-history-body');
    body.innerHTML = '<div class="tree-loading"><div class="loading-spinner"></div></div>';

    try {
        const statusRes = await fetch(`${API_BASE}/api/history-tracking/${database}/${schema}/${table}/status`);
        const status = await statusRes.json();
        if (!statusRes.ok) throw new Error(status.error || 'Failed to check tracking status');

        body.innerHTML = '';

        const section = document.createElement('div');
        section.className = 'lineage-section history-toggle-section';

        const note = document.createElement('div');
        note.className = 'empty-state';
        note.style.padding = '0';
        note.textContent = status.enabled
            ? 'Change tracking is on — every insert/update/delete on this table is being logged below.'
            : 'Change tracking is off. Turn it on to start logging every insert/update/delete on this table with a timestamp, so you can see (and recover) prior values.';
        section.appendChild(note);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = status.enabled ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
        toggleBtn.textContent = status.enabled ? 'Disable tracking' : 'Enable tracking';
        toggleBtn.addEventListener('click', () => toggleHistoryTracking(!status.enabled));
        section.appendChild(toggleBtn);

        body.appendChild(section);

        if (status.enabled) {
            const logRes = await fetch(`${API_BASE}/api/history-tracking/${database}/${schema}/${table}/log?limit=100`);
            const log = await logRes.json();
            if (!logRes.ok) throw new Error(log.error || 'Failed to load history log');

            const logSection = document.createElement('div');
            logSection.className = 'lineage-section';
            logSection.innerHTML = '<h3>Change log (most recent first)</h3>';

            if (log.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                empty.style.padding = '0';
                empty.textContent = 'No changes logged yet — insert, update, or delete a row to see it here.';
                logSection.appendChild(empty);
            } else {
                const table_ = document.createElement('table');
                table_.className = 'results-table';
                const thead = document.createElement('thead');
                thead.innerHTML = '<tr><th>Op</th><th>When</th><th>By</th><th>Row</th></tr>';
                table_.appendChild(thead);
                const tbody = document.createElement('tbody');
                log.forEach(entry => {
                    const tr = document.createElement('tr');
                    const opTd = document.createElement('td');
                    opTd.textContent = entry._op;
                    const whenTd = document.createElement('td');
                    whenTd.textContent = new Date(entry._changed_at).toLocaleString();
                    const byTd = document.createElement('td');
                    byTd.textContent = entry._changed_by;
                    const rowTd = document.createElement('td');
                    rowTd.textContent = JSON.stringify(entry._row);
                    tr.appendChild(opTd);
                    tr.appendChild(whenTd);
                    tr.appendChild(byTd);
                    tr.appendChild(rowTd);
                    tbody.appendChild(tr);
                });
                table_.appendChild(tbody);
                logSection.appendChild(table_);
            }
            body.appendChild(logSection);
        }
    } catch (err) {
        body.innerHTML = `<div class="empty-state">Failed to load history<br><small>${escapeHtml(err.message)}</small></div>`;
    }
}

async function toggleHistoryTracking(enable) {
    const { database, schema, table } = previewContext;
    try {
        const res = await fetch(`${API_BASE}/api/history-tracking/${database}/${schema}/${table}/${enable ? 'enable' : 'disable'}`, {
            method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update tracking');

        showToast(`Change tracking ${enable ? 'enabled' : 'disabled'}`, 'success');
        loadPreviewHistory();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function getRowPrimaryKey(row, primaryKeyCols) {
    const pk = {};
    primaryKeyCols.forEach(col => { pk[col] = row[col]; });
    return pk;
}

function buildPreviewTable(columns, rows, primaryKeyCols) {
    if (!rows || rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'This table has no rows';
        return empty;
    }

    const editable = primaryKeyCols.length > 0;
    const table = document.createElement('table');
    table.className = 'results-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.innerHTML = '<th class="row-number">#</th>' + (editable ? '<th class="row-number"></th>' : '');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col.name + (primaryKeyCols.includes(col.name) ? ' 🔑' : '');
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row, rowIdx) => {
        const tr = document.createElement('tr');

        const numTd = document.createElement('td');
        numTd.className = 'row-number';
        numTd.textContent = rowIdx + 1;
        tr.appendChild(numTd);

        if (editable) {
            const delTd = document.createElement('td');
            delTd.className = 'row-number';
            const delBtn = document.createElement('button');
            delBtn.className = 'row-delete-btn';
            delBtn.title = 'Delete row';
            delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
            delBtn.addEventListener('click', () => deletePreviewRow(row, primaryKeyCols, tr));
            delTd.appendChild(delBtn);
            tr.appendChild(delTd);
        }

        columns.forEach(col => {
            const td = document.createElement('td');
            const val = row[col.name];
            const isPk = primaryKeyCols.includes(col.name);

            if (val === null || val === undefined) {
                td.textContent = 'NULL';
                td.className = 'null-value';
            } else if (typeof val === 'object') {
                td.textContent = JSON.stringify(val);
            } else {
                td.textContent = String(val);
            }

            if (editable && !isPk) {
                td.classList.add('editable-cell');
                td.title = 'Double-click to edit';
                td.addEventListener('dblclick', () => startCellEdit(td, row, col.name, primaryKeyCols));
            }

            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    return table;
}

function startCellEdit(td, row, colName, primaryKeyCols) {
    if (td.querySelector('input')) return; // already editing

    const originalText = td.textContent;
    const originalValue = row[colName];
    td.textContent = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-edit-input';
    input.value = originalValue === null || originalValue === undefined ? '' : String(originalValue);
    td.appendChild(input);
    input.focus();
    input.select();

    let settled = false;

    const cancel = () => {
        if (settled) return;
        settled = true;
        td.textContent = originalText;
    };

    const commit = async () => {
        if (settled) return;
        settled = true;
        const newValue = input.value;

        if (newValue === (originalValue === null || originalValue === undefined ? '' : String(originalValue))) {
            td.textContent = originalText;
            return;
        }

        td.textContent = 'Saving…';
        td.classList.add('cell-saving');

        try {
            const pk = getRowPrimaryKey(row, primaryKeyCols);
            const res = await fetch(
                `${API_BASE}/api/table-preview/${previewContext.database}/${previewContext.schema}/${previewContext.table}/row`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ primaryKey: pk, changes: { [colName]: newValue }, role: document.getElementById('role-selector').value }),
                }
            );
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Update failed');

            row[colName] = newValue;
            td.textContent = newValue === '' ? 'NULL' : newValue;
            td.classList.toggle('null-value', newValue === '');
            showToast('Row updated', 'success');
        } catch (err) {
            td.textContent = originalText;
            showToast(err.message, 'error');
        } finally {
            td.classList.remove('cell-saving');
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
}

async function deletePreviewRow(row, primaryKeyCols, trEl) {
    if (!confirm('Delete this row? This cannot be undone.')) return;

    try {
        const pk = getRowPrimaryKey(row, primaryKeyCols);
        const res = await fetch(
            `${API_BASE}/api/table-preview/${previewContext.database}/${previewContext.schema}/${previewContext.table}/row`,
            {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ primaryKey: pk, role: document.getElementById('role-selector').value }),
            }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Delete failed');

        trEl.remove();
        showToast('Row deleted', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function closePreviewModal() {
    document.getElementById('preview-modal').style.display = 'none';
    previewContext = null;
    updateChatPlaceholder();
}

// ── CSV Import ──

const IMPORT_COLUMN_TYPES = ['TEXT', 'INTEGER', 'BIGINT', 'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP'];
let importState = null; // { fileName, headers, rows, columns: [{name, type}], mode: 'new'|'existing', database, schema, table }

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += ch; i++; continue;
        }

        if (ch === '"') { inQuotes = true; i++; continue; }
        if (ch === ',') { row.push(field); field = ''; i++; continue; }
        if (ch === '\r') { i++; continue; }
        if (ch === '\n') {
            row.push(field); field = '';
            rows.push(row); row = [];
            i++; continue;
        }
        field += ch; i++;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

    const nonEmpty = rows.filter(r => !(r.length === 1 && r[0] === ''));
    if (nonEmpty.length === 0) return { headers: [], rows: [] };

    const headers = nonEmpty[0].map(h => h.trim());
    return { headers, rows: nonEmpty.slice(1) };
}

function inferColumnType(values) {
    const sample = values.filter(v => v !== '' && v !== null && v !== undefined).slice(0, 50);
    if (sample.length === 0) return 'TEXT';

    if (sample.every(v => /^-?\d+$/.test(v))) return 'BIGINT';
    if (sample.every(v => /^-?\d*\.?\d+$/.test(v))) return 'NUMERIC';
    if (sample.every(v => /^(true|false)$/i.test(v))) return 'BOOLEAN';
    if (sample.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'DATE';
    if (sample.every(v => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) return 'TIMESTAMP';
    return 'TEXT';
}

function openImportModal(file) {
    const reader = new FileReader();
    reader.onload = () => {
        const { headers, rows } = parseCsv(String(reader.result));
        if (headers.length === 0) {
            showToast('Could not read any rows from that CSV', 'error');
            return;
        }

        const columns = headers.map((name, i) => ({
            name: sanitizeColumnName(name, i),
            type: inferColumnType(rows.map(r => r[i])),
        }));

        importState = {
            fileName: file.name,
            headers, rows, columns,
            mode: 'new',
            database: document.getElementById('db-selector').value,
            schema: 'public',
            table: sanitizeColumnName(file.name.replace(/\.csv$/i, ''), 0) || 'imported_data',
        };

        document.getElementById('import-modal').style.display = 'flex';
        document.getElementById('import-meta').textContent = `${file.name} — ${rows.length.toLocaleString()} row(s), ${headers.length} column(s)`;
        renderImportForm();
    };
    reader.onerror = () => showToast('Failed to read file', 'error');
    reader.readAsText(file);
}

function sanitizeColumnName(name, fallbackIdx) {
    let clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!clean || /^\d/.test(clean)) clean = `col_${fallbackIdx}${clean ? '_' + clean : ''}`;
    return clean.slice(0, 63);
}

async function renderImportForm() {
    const body = document.getElementById('import-body');
    body.innerHTML = '';
    body.className = 'modal-body import-body';

    // Target: database / schema / table name / mode
    const targetRow = document.createElement('div');
    targetRow.className = 'import-target-row';

    const dbSelect = document.createElement('select');
    dbSelect.className = 'chat-model-select';
    try {
        const dbRes = await fetch(`${API_BASE}/api/databases`);
        const dbs = await dbRes.json();
        dbs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.database_name;
            opt.textContent = d.database_name;
            if (d.database_name === importState.database) opt.selected = true;
            dbSelect.appendChild(opt);
        });
    } catch (e) { /* leave empty */ }
    dbSelect.addEventListener('change', () => { importState.database = dbSelect.value; renderImportForm(); });

    const tableInput = document.createElement('input');
    tableInput.type = 'text';
    tableInput.className = 'chat-model-input';
    tableInput.placeholder = 'new_table_name';
    tableInput.value = importState.table;
    tableInput.addEventListener('input', () => { importState.table = tableInput.value.trim(); });

    const dbLabel = document.createElement('label');
    dbLabel.className = 'import-field-label';
    dbLabel.textContent = 'Database';
    dbLabel.appendChild(dbSelect);

    const tableLabel = document.createElement('label');
    tableLabel.className = 'import-field-label';
    tableLabel.textContent = 'Table name';
    tableLabel.appendChild(tableInput);

    targetRow.appendChild(dbLabel);
    targetRow.appendChild(tableLabel);
    body.appendChild(targetRow);

    // Existing-table toggle
    let existingTables = [];
    try {
        const tRes = await fetch(`${API_BASE}/api/tables/${importState.database}/${importState.schema}`);
        existingTables = await tRes.json();
    } catch (e) { /* ignore */ }

    if (existingTables.length > 0) {
        const modeRow = document.createElement('div');
        modeRow.className = 'import-mode-row';

        const newLabel = document.createElement('label');
        const newRadio = document.createElement('input');
        newRadio.type = 'radio'; newRadio.name = 'import-mode'; newRadio.checked = importState.mode === 'new';
        newRadio.addEventListener('change', () => { importState.mode = 'new'; renderImportForm(); });
        newLabel.appendChild(newRadio);
        newLabel.append(' Create new table');

        const existingLabel = document.createElement('label');
        const existingRadio = document.createElement('input');
        existingRadio.type = 'radio'; existingRadio.name = 'import-mode'; existingRadio.checked = importState.mode === 'existing';
        existingRadio.addEventListener('change', () => { importState.mode = 'existing'; renderImportForm(); });
        existingLabel.appendChild(existingRadio);
        existingLabel.append(' Append to existing table');

        modeRow.appendChild(newLabel);
        modeRow.appendChild(existingLabel);
        body.appendChild(modeRow);

        if (importState.mode === 'existing') {
            const existingSelect = document.createElement('select');
            existingSelect.className = 'chat-model-select';
            existingTables.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.table_name;
                opt.textContent = t.table_name;
                if (t.table_name === importState.table) opt.selected = true;
                existingSelect.appendChild(opt);
            });
            existingSelect.addEventListener('change', () => { importState.table = existingSelect.value; });
            if (!existingTables.some(t => t.table_name === importState.table)) {
                importState.table = existingTables[0].table_name;
                existingSelect.value = importState.table;
            }
            body.appendChild(existingSelect);
        }
    }

    // Column mapping (only editable in "new" mode)
    const colTable = document.createElement('table');
    colTable.className = 'results-table import-columns-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>CSV column</th><th>Target column</th><th>Type</th></tr>';
    colTable.appendChild(thead);
    const tbody = document.createElement('tbody');

    importState.columns.forEach((col, i) => {
        const tr = document.createElement('tr');

        const csvTd = document.createElement('td');
        csvTd.textContent = importState.headers[i];
        tr.appendChild(csvTd);

        const nameTd = document.createElement('td');
        if (importState.mode === 'new') {
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'chat-model-input';
            nameInput.value = col.name;
            nameInput.addEventListener('input', () => { col.name = nameInput.value.trim(); });
            nameTd.appendChild(nameInput);
        } else {
            nameTd.textContent = col.name;
        }
        tr.appendChild(nameTd);

        const typeTd = document.createElement('td');
        if (importState.mode === 'new') {
            const typeSelect = document.createElement('select');
            typeSelect.className = 'chat-model-select';
            IMPORT_COLUMN_TYPES.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t;
                if (t === col.type) opt.selected = true;
                typeSelect.appendChild(opt);
            });
            typeSelect.addEventListener('change', () => { col.type = typeSelect.value; });
            typeTd.appendChild(typeSelect);
        } else {
            typeTd.textContent = '—';
        }
        tr.appendChild(typeTd);

        tbody.appendChild(tr);
    });
    colTable.appendChild(tbody);
    body.appendChild(colTable);

    // Preview of first rows
    const previewLabel = document.createElement('div');
    previewLabel.className = 'import-preview-label';
    previewLabel.textContent = `Preview (first ${Math.min(5, importState.rows.length)} of ${importState.rows.length.toLocaleString()} rows)`;
    body.appendChild(previewLabel);
    body.appendChild(buildMiniResultTable(
        importState.headers,
        importState.rows.slice(0, 5).map(r => Object.fromEntries(importState.headers.map((h, i) => [h, r[i]])))
    ));

    document.getElementById('import-confirm').disabled = !importState.table;
}

async function runImport() {
    if (!importState || !importState.table) return;

    const confirmBtn = document.getElementById('import-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Importing…';

    try {
        const colNames = importState.columns.map(c => c.name);
        const uniqueNames = new Set(colNames);
        if (uniqueNames.size !== colNames.length) {
            throw new Error('Column names must be unique');
        }

        const payload = {
            table: importState.table,
            createNew: importState.mode === 'new',
            columns: importState.columns,
            rows: importState.rows,
        };

        const res = await fetch(`${API_BASE}/api/import/${importState.database}/${importState.schema}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');

        showToast(`Imported ${data.rowsInserted.toLocaleString()} row(s) into ${importState.table}`, 'success');
        loadSchemaMap(importState.database);
        closeImportModal();
        loadObjectTree();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Import';
    }
}

function closeImportModal() {
    document.getElementById('import-modal').style.display = 'none';
    document.getElementById('import-csv-input').value = '';
    importState = null;
}

function insertIntoEditor(text) {
    const cursor = editor.getCursor();
    editor.replaceRange(text, cursor);
    editor.focus();
    showToast(`Inserted: ${text}`, 'info');
}

// ── Explorer Search ──
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('explorer-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const items = document.querySelectorAll('#object-tree .tree-item');
            items.forEach(item => {
                const label = item.querySelector('.tree-label');
                if (label) {
                    const matches = !query || label.textContent.toLowerCase().includes(query);
                    item.closest('.tree-node').style.display = matches ? '' : 'none';
                }
            });
        });
    }
});

// ═══════════════════════════════════════════
// Query History
// ═══════════════════════════════════════════

async function loadHistory() {
    const container = document.getElementById('history-list');
    try {
        const res = await fetch(`${API_BASE}/api/history?limit=100`);
        const history = await res.json();

        if (history.length === 0) {
            container.innerHTML = '<div class="empty-state">No queries yet.<br>Run your first query!</div>';
            return;
        }

        container.innerHTML = '';
        history.forEach(entry => {
            const el = document.createElement('div');
            el.className = 'history-entry';
            el.innerHTML = `
                <div class="history-entry-header">
                    <div class="history-status ${entry.status}"></div>
                    <span class="history-time">${formatTime(entry.timestamp)}</span>
                </div>
                <div class="history-sql">${escapeHtml(entry.sql.substring(0, 200))}</div>
                <div class="history-meta">
                    <span>⏱ ${entry.duration}ms</span>
                    <span>📊 ${entry.database}</span>
                    ${entry.rowCount !== undefined ? `<span>${entry.rowCount} rows</span>` : ''}
                </div>
            `;
            el.addEventListener('click', () => {
                editor.setValue(entry.sql);
                switchView('worksheets');
                editor.focus();
            });
            container.appendChild(el);
        });
    } catch (e) {
        container.innerHTML = `<div class="empty-state">Failed to load history</div>`;
    }
}

// ═══════════════════════════════════════════
// Sample Queries
// ═══════════════════════════════════════════

async function loadSamples() {
    const container = document.getElementById('samples-list');
    try {
        const res = await fetch(`${API_BASE}/api/samples`);
        const sections = await res.json();

        if (sections.length === 0) {
            container.innerHTML = '<div class="empty-state">No sample queries found</div>';
            return;
        }

        container.innerHTML = '';
        sections.forEach(section => {
            const sectionEl = document.createElement('div');
            sectionEl.className = 'sample-section';

            const header = document.createElement('div');
            header.className = 'sample-section-header';
            header.innerHTML = `<span>${section.icon}</span> ${escapeHtml(section.title)}`;

            const queriesContainer = document.createElement('div');
            queriesContainer.style.display = 'none';

            header.addEventListener('click', () => {
                const isVisible = queriesContainer.style.display !== 'none';
                queriesContainer.style.display = isVisible ? 'none' : 'block';
            });

            section.queries.forEach(query => {
                const queryEl = document.createElement('div');
                queryEl.className = 'sample-query';
                queryEl.textContent = query.title;
                queryEl.addEventListener('click', () => {
                    editor.setValue(query.sql);
                    switchView('worksheets');
                    editor.focus();
                    showToast('Sample query loaded — press Ctrl+Enter to run', 'info');
                });
                queriesContainer.appendChild(queryEl);
            });

            sectionEl.appendChild(header);
            sectionEl.appendChild(queriesContainer);
            container.appendChild(sectionEl);
        });
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Failed to load samples</div>';
    }
}

// ═══════════════════════════════════════════
// Database Details (right-click a database)
// ═══════════════════════════════════════════

async function openDatabaseDetails(database) {
    const modal = document.getElementById('db-details-modal');
    const titleEl = document.getElementById('db-details-title');
    const bodyEl = document.getElementById('db-details-body');

    titleEl.textContent = database;
    bodyEl.innerHTML = '<div class="tree-loading"><div class="loading-spinner"></div></div>';
    modal.style.display = 'flex';

    try {
        const [detailsRes, grantsRes] = await Promise.all([
            fetch(`${API_BASE}/api/database-details/${database}`),
            fetch(`${API_BASE}/api/grants/${database}/public`),
        ]);
        const details = await detailsRes.json();
        if (!detailsRes.ok) throw new Error(details.error || 'Failed to load database details');
        const tableGrants = grantsRes.ok ? await grantsRes.json() : [];

        bodyEl.innerHTML = '';

        const infoSection = document.createElement('div');
        infoSection.className = 'lineage-section';
        infoSection.innerHTML = '<h3>Overview</h3>';
        const infoList = document.createElement('div');
        infoList.className = 'lineage-list';
        [
            ['Owner', details.owner],
            ['Size', details.size],
            ['Encoding', details.encoding],
            ['Collation', details.collation],
            ['Connection limit', details.connection_limit === -1 ? 'Unlimited' : details.connection_limit],
        ].forEach(([label, value]) => {
            const row = document.createElement('div');
            row.className = 'lineage-item';
            row.textContent = `${label}: ${value}`;
            infoList.appendChild(row);
        });
        infoSection.appendChild(infoList);
        bodyEl.appendChild(infoSection);

        const dbAccessSection = document.createElement('div');
        dbAccessSection.className = 'lineage-section';
        dbAccessSection.innerHTML = '<h3>Database-level access (connect / create)</h3>';
        dbAccessSection.appendChild(buildGranteeSummaryList(details.accessList));
        bodyEl.appendChild(dbAccessSection);

        const tableAccessSection = document.createElement('div');
        tableAccessSection.className = 'lineage-section';
        tableAccessSection.innerHTML = '<h3>Table-level access (public schema)</h3>';
        tableAccessSection.appendChild(buildTableGrantSummaryList(tableGrants));
        bodyEl.appendChild(tableAccessSection);
    } catch (err) {
        bodyEl.innerHTML = `<div class="empty-state">Failed to load database details<br><small>${escapeHtml(err.message)}</small></div>`;
    }
}

function groupByGrantee(list) {
    const map = {};
    (list || []).forEach(({ grantee, privilege }) => {
        if (!map[grantee]) map[grantee] = [];
        map[grantee].push(privilege);
    });
    return map;
}

function buildGranteeSummaryList(accessList) {
    const grouped = groupByGrantee(accessList);
    const names = Object.keys(grouped);
    if (names.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '0';
        empty.textContent = 'No explicit access entries.';
        return empty;
    }
    const list = document.createElement('div');
    list.className = 'lineage-list';
    names.forEach(name => {
        const row = document.createElement('div');
        row.className = 'lineage-item';
        row.textContent = `${name}: ${grouped[name].join(', ')}`;
        list.appendChild(row);
    });
    return list;
}

function buildTableGrantSummaryList(tableGrants) {
    if (!tableGrants || tableGrants.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '0';
        empty.textContent = 'No roles currently have explicit table-level privileges in the public schema.';
        return empty;
    }
    const byGrantee = {};
    tableGrants.forEach(({ grantee, table_name, privilege_type }) => {
        if (!byGrantee[grantee]) byGrantee[grantee] = [];
        byGrantee[grantee].push(`${table_name} (${privilege_type})`);
    });
    const list = document.createElement('div');
    list.className = 'lineage-list';
    Object.keys(byGrantee).forEach(grantee => {
        const row = document.createElement('div');
        row.className = 'lineage-item';
        row.textContent = `${grantee}: ${byGrantee[grantee].join(', ')}`;
        list.appendChild(row);
    });
    return list;
}

function closeDatabaseDetails() {
    document.getElementById('db-details-modal').style.display = 'none';
}

// ═══════════════════════════════════════════
// Roles (RBAC — real Postgres roles & grants)
// ═══════════════════════════════════════════

async function loadRoles() {
    const container = document.getElementById('roles-list');
    container.innerHTML = '<div class="tree-loading"><div class="loading-spinner"></div></div>';

    try {
        const res = await fetch(`${API_BASE}/api/roles`);
        const roles = await res.json();
        if (!res.ok) throw new Error(roles.error || 'Failed to load roles');

        if (roles.length === 0) {
            container.innerHTML = '<div class="empty-state">No roles found</div>';
            return;
        }

        container.innerHTML = '';
        roles.forEach(role => {
            const item = document.createElement('div');
            item.className = 'role-item';

            const info = document.createElement('div');
            info.className = 'role-info';

            const name = document.createElement('div');
            name.className = 'role-name';
            name.textContent = role.rolname;
            info.appendChild(name);

            const badges = document.createElement('div');
            badges.className = 'role-badges';
            if (role.rolsuper) badges.appendChild(makeRoleBadge('SUPERUSER'));
            if (role.rolcanlogin) badges.appendChild(makeRoleBadge('LOGIN'));
            if (role.rolcreatedb) badges.appendChild(makeRoleBadge('CREATEDB'));
            if (role.rolcreaterole) badges.appendChild(makeRoleBadge('CREATEROLE'));
            info.appendChild(badges);

            item.appendChild(info);

            if (role.rolname !== 'postgres') {
                const delBtn = document.createElement('button');
                delBtn.className = 'icon-btn';
                delBtn.title = 'Delete role';
                delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
                delBtn.addEventListener('click', () => deleteRole(role.rolname));
                item.appendChild(delBtn);
            }

            container.appendChild(item);
        });
        populateDbAccessRoleSelect(roles);
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Failed to load roles<br><small>${escapeHtml(err.message)}</small></div>`;
    }

    populateDbAccessDatabaseSelect();
    loadRoleSelector();
}

function populateDbAccessRoleSelect(roles) {
    const select = document.getElementById('db-access-role');
    if (!select) return;
    select.innerHTML = '';
    const assignable = roles.filter(r => r.rolname !== 'postgres');
    if (assignable.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'No roles yet — create one above';
        select.appendChild(opt);
        select.disabled = true;
        return;
    }
    select.disabled = false;
    assignable.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.rolname;
        opt.textContent = r.rolname;
        select.appendChild(opt);
    });
}

async function populateDbAccessDatabaseSelect() {
    const select = document.getElementById('db-access-database');
    if (!select) return;
    try {
        const res = await fetch(`${API_BASE}/api/databases`);
        const dbs = await res.json();
        select.innerHTML = '';
        dbs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.database_name;
            opt.textContent = d.database_name;
            select.appendChild(opt);
        });
    } catch (e) { /* leave as-is */ }
}

const STANDARD_ROLE_TEMPLATES = [
    { name: 'ACCOUNTADMIN', createDb: true, createRole: true, canLogin: false },
    { name: 'ENGINEER', createDb: false, createRole: false, canLogin: false },
    { name: 'ANALYST', createDb: false, createRole: false, canLogin: false },
];

async function createStandardRoles() {
    const btn = document.getElementById('create-standard-roles');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    try {
        for (const tpl of STANDARD_ROLE_TEMPLATES) {
            const res = await fetch(`${API_BASE}/api/roles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: tpl.name, canLogin: tpl.canLogin,
                    createDb: tpl.createDb, createRole: tpl.createRole,
                    ifNotExists: true,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(`${tpl.name}: ${data.error || 'failed'}`);
        }
        showToast('Standard roles ready: ACCOUNTADMIN, ENGINEER, ANALYST', 'success');
        loadRoles();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create standard roles';
    }
}

async function runDatabaseWideGrant(action) {
    const roleSelect = document.getElementById('db-access-role');
    const dbSelect = document.getElementById('db-access-database');
    const privilege = document.getElementById('db-access-privilege').value;

    const role = roleSelect.value;
    const databases = Array.from(dbSelect.selectedOptions).map(o => o.value);

    if (!role) { showToast('Pick a role first', 'error'); return; }
    if (databases.length === 0) { showToast('Pick at least one database', 'error'); return; }

    let succeeded = 0;
    for (const database of databases) {
        try {
            const res = await fetch(`${API_BASE}/api/grants/${database}/database-wide`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ schema: 'public', role, privilege, action }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'failed');
            succeeded++;
        } catch (err) {
            showToast(`${database}: ${err.message}`, 'error');
        }
    }

    if (succeeded > 0) {
        const verb = action === 'grant' ? 'Granted' : 'Revoked';
        const prep = action === 'grant' ? 'to' : 'from';
        showToast(`${verb} ${privilege} on ${succeeded} database(s) ${prep} ${role}`, 'success');
    }
}

function makeRoleBadge(text) {
    const badge = document.createElement('span');
    badge.className = 'tree-badge role-badge';
    badge.textContent = text;
    return badge;
}

async function createRole() {
    const nameInput = document.getElementById('new-role-name');
    const canLoginInput = document.getElementById('new-role-can-login');
    const passwordInput = document.getElementById('new-role-password');

    const name = nameInput.value.trim();
    if (!name) {
        showToast('Enter a role name', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                canLogin: canLoginInput.checked,
                password: canLoginInput.checked ? passwordInput.value : undefined,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create role');

        showToast(`Role "${name}" created`, 'success');
        nameInput.value = '';
        passwordInput.value = '';
        canLoginInput.checked = false;
        passwordInput.style.display = 'none';
        loadRoles();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteRole(name) {
    if (!confirm(`Delete role "${name}"? This cannot be undone.`)) return;

    try {
        const res = await fetch(`${API_BASE}/api/roles/${name}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to delete role');

        showToast(`Role "${name}" deleted`, 'success');
        loadRoles();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ═══════════════════════════════════════════
// Resizer
// ═══════════════════════════════════════════

function initResizer() {
    const handle = document.getElementById('resize-handle');
    const editorPanel = document.getElementById('editor-panel');
    const split = document.getElementById('editor-results-split');

    let startY, startHeight;

    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = editorPanel.offsetHeight;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (e) => {
            const delta = e.clientY - startY;
            const newHeight = Math.max(100, Math.min(startHeight + delta, split.offsetHeight - 150));
            editorPanel.style.height = newHeight + 'px';
            editorPanel.style.flex = 'none';
            editor.refresh();
        };

        const onMouseUp = () => {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ═══════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════

function initEventListeners() {
    // Run Query
    document.getElementById('run-query').addEventListener('click', runQuery);

    // Add Worksheet
    document.getElementById('add-worksheet').addEventListener('click', () => {
        saveCurrentWorksheet();
        addWorksheet();
    });

    // Clear Editor
    document.getElementById('clear-editor').addEventListener('click', () => {
        editor.setValue('');
        editor.focus();
    });

    // Export CSV
    document.getElementById('export-csv').addEventListener('click', exportCSV);

    // Results Tabs
    document.querySelectorAll('.results-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            showResultsTab(tab.dataset.tab);
        });
    });

    // Create Database
    document.getElementById('create-database').addEventListener('click', createDatabase);

    // CSV Import
    document.getElementById('import-csv').addEventListener('click', () => {
        document.getElementById('import-csv-input').click();
    });
    document.getElementById('import-csv-input').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) openImportModal(file);
    });
    document.getElementById('close-import').addEventListener('click', closeImportModal);
    document.getElementById('import-cancel').addEventListener('click', closeImportModal);
    document.getElementById('import-modal').addEventListener('click', (e) => {
        if (e.target.id === 'import-modal') closeImportModal();
    });
    document.getElementById('import-confirm').addEventListener('click', runImport);

    // Table/View Preview Modal
    document.getElementById('close-preview').addEventListener('click', closePreviewModal);
    document.getElementById('preview-tab-data').addEventListener('click', () => switchPreviewTab('data'));
    document.getElementById('preview-tab-lineage').addEventListener('click', () => switchPreviewTab('lineage'));
    document.getElementById('preview-tab-permissions').addEventListener('click', () => switchPreviewTab('permissions'));
    document.getElementById('preview-tab-history').addEventListener('click', () => switchPreviewTab('history'));

    // Roles (RBAC)
    document.getElementById('refresh-roles').addEventListener('click', loadRoles);
    document.getElementById('create-role').addEventListener('click', createRole);
    document.getElementById('new-role-can-login').addEventListener('change', (e) => {
        document.getElementById('new-role-password').style.display = e.target.checked ? 'block' : 'none';
    });
    document.getElementById('close-db-details').addEventListener('click', closeDatabaseDetails);
    document.getElementById('db-details-modal').addEventListener('click', (e) => {
        if (e.target.id === 'db-details-modal') closeDatabaseDetails();
    });
    document.getElementById('create-standard-roles').addEventListener('click', createStandardRoles);
    document.getElementById('db-access-grant').addEventListener('click', () => runDatabaseWideGrant('grant'));
    document.getElementById('db-access-revoke').addEventListener('click', () => runDatabaseWideGrant('revoke'));
    document.getElementById('role-selector').addEventListener('change', () => {
        saveCurrentWorksheet();
    });
    document.getElementById('preview-modal').addEventListener('click', (e) => {
        if (e.target.id === 'preview-modal') closePreviewModal();
    });
    document.getElementById('preview-insert').addEventListener('click', () => {
        if (!previewContext) return;
        switchView('worksheets');
        insertIntoEditor(`${previewContext.schema}.${previewContext.table}`);
        closePreviewModal();
    });
    document.getElementById('preview-query').addEventListener('click', () => {
        if (!previewContext) return;
        const { database, schema, table } = previewContext;
        switchView('worksheets');
        document.getElementById('db-selector').value = database;
        editor.setValue(`SELECT * FROM ${schema}.${table} LIMIT 100;`);
        saveCurrentWorksheet();
        closePreviewModal();
        setTimeout(() => runQuery(), 100);
    });

    // Refresh Object Explorer
    document.getElementById('refresh-explorer').addEventListener('click', () => {
        const tree = document.getElementById('object-tree');
        tree.innerHTML = '';
        loadObjectTree();
        loadDbSelector();
    });

    // Clear History
    document.getElementById('clear-history').addEventListener('click', async () => {
        if (confirm('Clear all query history?')) {
            await fetch(`${API_BASE}/api/history`, { method: 'DELETE' });
            loadHistory();
            showToast('History cleared', 'success');
        }
    });

    // Ask AI chat
    document.getElementById('chat-send').addEventListener('click', sendChatMessage);
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
    document.getElementById('clear-chat').addEventListener('click', () => {
        activeSession().history.length = 0;
        renderChatMessages();
        saveChatHistory();
    });
    document.getElementById('new-chat-tab').addEventListener('click', addChatSession);

    // Skills + attachments
    document.getElementById('chat-skills-btn').addEventListener('click', toggleSkillsPopover);
    document.getElementById('chat-attach-btn').addEventListener('click', () => {
        document.getElementById('chat-attach-input').click();
    });
    document.getElementById('chat-attach-input').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) handleAttachFile(file);
        e.target.value = '';
    });
    document.getElementById('chat-input').addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
                e.preventDefault();
                handleAttachFile(item.getAsFile());
                return;
            }
        }
    });
    document.addEventListener('click', (e) => {
        const pop = document.getElementById('chat-skills-popover');
        if (pop.style.display !== 'none' && !pop.contains(e.target) && e.target.id !== 'chat-skills-btn') {
            pop.style.display = 'none';
        }
    });

    // Save Settings
    document.getElementById('save-settings').addEventListener('click', saveSettings);
    document.getElementById('setup-database').addEventListener('click', setupLearningDatabase);
    document.getElementById('setting-database').addEventListener('change', checkSetupStatus);

    // Database selector change
    document.getElementById('db-selector').addEventListener('change', (e) => {
        saveCurrentWorksheet();
        updateChatPlaceholder();
        loadSchemaMap(e.target.value);
    });

    // Auto-save on editor changes (debounced)
    let saveTimeout;
    if (editor) {
        editor.on('change', () => {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(saveCurrentWorksheet, 1000);
        });
    }
}

// ═══════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════

async function saveSettings() {
    const settings = {
        host: document.getElementById('setting-host').value,
        port: parseInt(document.getElementById('setting-port').value),
        user: document.getElementById('setting-user').value,
        password: document.getElementById('setting-password').value,
        database: document.getElementById('setting-database').value,
    };

    const statusEl = document.getElementById('settings-status');
    statusEl.className = 'settings-status';
    statusEl.textContent = 'Testing connection...';
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--text-secondary)';
    statusEl.style.background = 'var(--bg-tertiary)';
    statusEl.style.border = '1px solid var(--border)';

    try {
        const res = await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });

        const data = await res.json();
        if (res.ok) {
            statusEl.className = 'settings-status success';
            statusEl.textContent = '✓ Connected successfully!';
            checkConnection();
            loadDbSelector();
            showToast('Connection settings saved', 'success');
        } else {
            statusEl.className = 'settings-status error';
            statusEl.textContent = '✗ ' + data.error;
        }
    } catch (e) {
        statusEl.className = 'settings-status error';
        statusEl.textContent = '✗ Failed to connect: ' + e.message;
    }
}

// ═══════════════════════════════════════════
// Connection Check
// ═══════════════════════════════════════════

async function checkSetupStatus() {
    const statusEl = document.getElementById('setup-status');
    if (!statusEl) return;

    try {
        const database = document.getElementById('setting-database').value || 'learn_sql';
        const res = await fetch(`${API_BASE}/api/setup-status?database=${encodeURIComponent(database)}`);
        const data = await res.json();
        if (res.ok && data.seeded) {
            statusEl.className = 'settings-status success';
            statusEl.textContent = `✓ ${data.database} is ready (${data.tableCount} tables).`;
        } else if (res.ok && data.exists) {
            statusEl.className = 'settings-status info';
            statusEl.textContent = `${data.database} exists but has no public learning tables yet.`;
        } else if (res.ok) {
            statusEl.className = 'settings-status info';
            statusEl.textContent = `${data.database} has not been created yet.`;
        } else {
            statusEl.className = 'settings-status error';
            statusEl.textContent = 'Setup status failed: ' + (data.error || 'Unknown error');
        }
    } catch (e) {
        statusEl.className = 'settings-status error';
        statusEl.textContent = 'PostgreSQL is not reachable yet: ' + e.message;
    }
}

async function setupLearningDatabase() {
    const statusEl = document.getElementById('setup-status');
    const button = document.getElementById('setup-database');
    const database = document.getElementById('setting-database').value || 'learn_sql';

    statusEl.className = 'settings-status info';
    statusEl.textContent = `Setting up ${database} from seed.sql...`;
    button.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ database }),
        });
        const data = await res.json();
        if (res.ok) {
            statusEl.className = 'settings-status success';
            statusEl.textContent = '✓ ' + data.message;
            await loadDbSelector();
            const selector = document.getElementById('db-selector');
            if ([...selector.options].some(option => option.value === data.database)) {
                selector.value = data.database;
            }
            await loadObjectTree();
            checkConnection();
            showToast('Learning database ready', 'success');
        } else {
            statusEl.className = 'settings-status error';
            statusEl.textContent = '✗ ' + (data.error || 'Setup failed');
        }
    } catch (e) {
        statusEl.className = 'settings-status error';
        statusEl.textContent = '✗ Setup failed: ' + e.message;
    } finally {
        button.disabled = false;
    }
}

async function checkConnection() {
    const dot = document.querySelector('.connection-dot');
    const indicator = document.getElementById('connection-indicator');
    try {
        const res = await fetch(`${API_BASE}/api/health`);
        const data = await res.json();
        if (data.status === 'connected') {
            dot.classList.add('connected');
            indicator.title = 'Connected to PostgreSQL';
        } else {
            dot.classList.remove('connected');
            indicator.title = 'Disconnected: ' + (data.error || 'Unknown error');
        }
    } catch (e) {
        dot.classList.remove('connected');
        indicator.title = 'Server not reachable';
    }
}

// Check connection every 30s
setInterval(checkConnection, 30000);

// ═══════════════════════════════════════════
// CSV Export
// ═══════════════════════════════════════════

function exportCSV() {
    if (!lastResults || !lastResults.rows || lastResults.rows.length === 0) {
        showToast('No data to export', 'error');
        return;
    }

    const columns = lastResults.columns.map(c => c.name);
    const rows = lastResults.rows;

    let csv = columns.map(c => `"${c}"`).join(',') + '\n';
    rows.forEach(row => {
        csv += columns.map(c => {
            const val = row[c];
            if (val === null || val === undefined) return '';
            return `"${String(val).replace(/"/g, '""')}"`;
        }).join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `query_results_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exported successfully', 'success');
}

// ═══════════════════════════════════════════
// Toast Notifications
// ═══════════════════════════════════════════

function showToast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✓', error: '✗', info: 'ℹ' };
    toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span> ${escapeHtml(message)}`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ═══════════════════════════════════════════
// Ask AI Chat
// ═══════════════════════════════════════════

const DEFAULT_CHAT_LAYOUT = {
    mode: 'floating', // 'floating' | 'docked'
    floating: { left: null, top: null, width: 380, height: 560 },
    docked: { width: 380 },
};

let chatLayout = JSON.parse(JSON.stringify(DEFAULT_CHAT_LAYOUT));

// ── Chat sessions (multiple tabs) ──
// Each session is fully self-contained: its own history, its own pending/in-flight state, and
// its own provider/model/mode — switching tabs must never lose, hide, or cross-wire another
// tab's in-flight request. Always operate on an explicitly captured session object inside async
// chat calls (never re-read activeChatSessionId after an await) so a reply lands in the tab that
// asked for it even if the user has switched away by the time it comes back.

let chatSessions = []; // [{ id, name, history, pending, pendingStatusText, provider, providerName, model, modelLabel, mode }]
let activeChatSessionId = null;

function activeSession() {
    return chatSessions.find(s => s.id === activeChatSessionId) || chatSessions[0];
}

function makeChatSession(name, overrides) {
    return {
        id: 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        history: [],
        pending: false,
        pendingStatusText: '',
        provider: null, providerName: null, model: null, modelLabel: null, mode: 'plan',
        ...overrides,
    };
}

function initChat() {
    const savedSessions = localStorage.getItem('snowquery_chat_sessions');
    if (savedSessions) {
        try { chatSessions = JSON.parse(savedSessions); } catch (e) { chatSessions = []; }
    }
    if (!Array.isArray(chatSessions) || chatSessions.length === 0) {
        // Migrate a pre-multi-tab single history/settings, if any, into the first session.
        let legacyHistory = [];
        const legacy = localStorage.getItem('snowquery_chat');
        if (legacy) {
            try { legacyHistory = JSON.parse(legacy); } catch (e) { /* ignore */ }
        }
        let legacySettings = {};
        const savedSettings = localStorage.getItem('snowquery_ai_settings');
        if (savedSettings) {
            try { legacySettings = JSON.parse(savedSettings); } catch (e) { /* ignore */ }
        }
        chatSessions = [makeChatSession('Chat 1', { history: legacyHistory, ...legacySettings })];
        if (legacySettings.consented) aiSettings.consented = true;
    }
    // A request that was in-flight when the page was last closed/reloaded is definitely dead now.
    chatSessions.forEach(s => { s.pending = false; s.pendingStatusText = ''; });

    activeChatSessionId = chatSessions[0].id;

    const savedLayout = localStorage.getItem('snowquery_chat_layout');
    if (savedLayout) {
        try {
            const parsed = JSON.parse(savedLayout);
            chatLayout = {
                mode: parsed.mode === 'docked' ? 'docked' : 'floating',
                floating: { ...DEFAULT_CHAT_LAYOUT.floating, ...(parsed.floating || {}) },
                docked: { ...DEFAULT_CHAT_LAYOUT.docked, ...(parsed.docked || {}) },
            };
        } catch (e) { /* keep defaults */ }
    }

    loadSkills();
    renderChatSessionTabs();
    renderChatMessages();
    renderAiBar();
    applyChatLayout();

    document.getElementById('chat-fab').addEventListener('click', toggleChatPanel);
    document.getElementById('close-chat').addEventListener('click', closeChatPanel);
    document.getElementById('dock-chat').addEventListener('click', toggleChatDock);
    initChatDrag();
    initChatResize();
    window.addEventListener('resize', () => applyChatLayout());
}

function renderChatSessionTabs() {
    const container = document.getElementById('chat-session-tabs');
    if (!container) return;
    container.innerHTML = '';

    chatSessions.forEach(session => {
        const tab = document.createElement('div');
        tab.className = `chat-session-tab${session.id === activeChatSessionId ? ' active' : ''}`;

        const label = document.createElement('span');
        label.className = 'chat-session-tab-label';
        label.textContent = session.name + (session.pending ? ' •' : '');
        label.title = session.pending ? `${session.name} (still working…)` : session.name;
        label.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const newName = prompt('Rename chat:', session.name);
            if (newName && newName.trim()) {
                session.name = newName.trim();
                saveChatHistory();
                renderChatSessionTabs();
            }
        });
        tab.appendChild(label);

        if (chatSessions.length > 1) {
            const closeBtn = document.createElement('span');
            closeBtn.className = 'chat-session-tab-close';
            closeBtn.innerHTML = '×';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeChatSession(session.id);
            });
            tab.appendChild(closeBtn);
        }

        tab.addEventListener('click', () => switchChatSession(session.id));
        container.appendChild(tab);
    });
}

function switchChatSession(id) {
    if (id === activeChatSessionId) return;
    const session = chatSessions.find(s => s.id === id);
    if (!session) return;
    activeChatSessionId = id;
    renderChatSessionTabs();
    renderChatMessages();
    renderAiBar();
    document.getElementById('chat-send').disabled = session.pending;
}

function addChatSession() {
    // New tabs default to the same provider/model/mode as the current tab — easy to change,
    // saves re-picking an AI every time, while still letting each tab diverge from there.
    const current = activeSession();
    const session = makeChatSession(`Chat ${chatSessions.length + 1}`, {
        provider: current.provider, providerName: current.providerName,
        model: current.model, modelLabel: current.modelLabel, mode: current.mode,
    });
    chatSessions.push(session);
    switchChatSession(session.id);
    saveChatHistory();
}

// Renames a session from its first message, the way ChatGPT/Claude.ai auto-title new chats —
// only when it's still on the generic "Chat N" default name, so a manual rename is never
// overwritten, and only on the session's first message (later messages don't re-title it).
function autoTitleSessionIfDefault(session, firstMessage) {
    if (session.history.length !== 1) return;
    if (!/^Chat \d+$/.test(session.name)) return;

    let title = firstMessage.replace(/\s+/g, ' ').trim();
    if (!title) return;
    if (title.length > 40) title = title.slice(0, 40).trim() + '…';
    session.name = title;
    renderChatSessionTabs();
}

function closeChatSession(id) {
    if (chatSessions.length <= 1) return;
    const wasActive = id === activeChatSessionId;
    chatSessions = chatSessions.filter(s => s.id !== id);
    if (wasActive) {
        activeChatSessionId = chatSessions[0].id;
        renderChatMessages();
        renderAiBar();
        document.getElementById('chat-send').disabled = chatSessions[0].pending;
    }
    renderChatSessionTabs();
    saveChatHistory();
}

function saveChatLayout() {
    localStorage.setItem('snowquery_chat_layout', JSON.stringify(chatLayout));
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function applyChatLayout() {
    const panel = document.getElementById('chat-floating-panel');
    const docked = chatLayout.mode === 'docked';

    panel.classList.toggle('mode-docked', docked);
    panel.classList.toggle('mode-floating', !docked);

    const dockBtn = document.getElementById('dock-chat');
    if (dockBtn) {
        dockBtn.classList.toggle('active', docked);
        dockBtn.title = docked ? 'Undock (float)' : 'Dock as sidebar';
    }

    if (docked) {
        const width = clamp(chatLayout.docked.width, 300, Math.min(720, window.innerWidth - 80));
        panel.style.left = '';
        panel.style.right = '0px';
        panel.style.top = '0px';
        panel.style.bottom = '0px';
        panel.style.width = width + 'px';
        panel.style.height = '';
    } else {
        const width = clamp(chatLayout.floating.width, 300, Math.min(900, window.innerWidth - 40));
        const height = clamp(chatLayout.floating.height, 320, Math.min(900, window.innerHeight - 40));
        const defaultLeft = window.innerWidth - width - 24;
        const defaultTop = window.innerHeight - height - 92;
        const left = clamp(chatLayout.floating.left ?? defaultLeft, 8, window.innerWidth - 120);
        const top = clamp(chatLayout.floating.top ?? defaultTop, 8, window.innerHeight - 60);

        panel.style.right = '';
        panel.style.bottom = '';
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.width = width + 'px';
        panel.style.height = height + 'px';
    }
}

function toggleChatDock() {
    chatLayout.mode = chatLayout.mode === 'docked' ? 'floating' : 'docked';
    applyChatLayout();
    saveChatLayout();
}

function initChatDrag() {
    const handle = document.getElementById('chat-drag-handle');
    const panel = document.getElementById('chat-floating-panel');

    handle.addEventListener('mousedown', (e) => {
        if (chatLayout.mode !== 'floating') return;
        if (e.target.closest('button')) return;
        e.preventDefault();

        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = panel.offsetLeft;
        const startTop = panel.offsetTop;

        function onMove(ev) {
            chatLayout.floating.left = clamp(startLeft + (ev.clientX - startX), 8, window.innerWidth - 120);
            chatLayout.floating.top = clamp(startTop + (ev.clientY - startY), 8, window.innerHeight - 60);
            applyChatLayout();
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            saveChatLayout();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function initChatResize() {
    const grip = document.getElementById('chat-resize-grip');
    const panel = document.getElementById('chat-floating-panel');

    grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = panel.offsetWidth;
        const startHeight = panel.offsetHeight;
        const mode = chatLayout.mode;

        function onMove(ev) {
            if (mode === 'docked') {
                const dx = startX - ev.clientX; // grip is on the left edge
                chatLayout.docked.width = clamp(startWidth + dx, 300, Math.min(720, window.innerWidth - 80));
            } else {
                const dw = ev.clientX - startX;
                const dh = ev.clientY - startY;
                chatLayout.floating.width = clamp(startWidth + dw, 300, Math.min(900, window.innerWidth - 40));
                chatLayout.floating.height = clamp(startHeight + dh, 320, Math.min(900, window.innerHeight - 40));
            }
            applyChatLayout();
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            saveChatLayout();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function updateChatPlaceholder() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const db = document.getElementById('db-selector')?.value;
    if (previewContext) {
        input.placeholder = `Ask about ${previewContext.table}... (Enter to send)`;
    } else if (db) {
        input.placeholder = `Ask about ${db}... (Enter to send)`;
    } else {
        input.placeholder = 'Ask about your data... (Enter to send)';
    }
}

function toggleChatPanel() {
    const panel = document.getElementById('chat-floating-panel');
    const isOpen = panel.classList.toggle('open');
    document.getElementById('chat-fab').hidden = isOpen;
    if (isOpen) {
        applyChatLayout();
        updateChatPlaceholder();
        setTimeout(() => document.getElementById('chat-input')?.focus(), 200);
    }
}

function closeChatPanel() {
    document.getElementById('chat-floating-panel').classList.remove('open');
    document.getElementById('chat-fab').hidden = false;
}

function saveChatHistory() {
    localStorage.setItem('snowquery_chat_sessions', JSON.stringify(chatSessions));
}

function saveAiSettings() {
    localStorage.setItem('snowquery_ai_settings', JSON.stringify(aiSettings));
}

// ── AI bar: provider badge + mode switch ──

const CHAT_MODES = [
    { id: 'plan', label: 'Plan', title: 'Proposes SQL only — you review and run it yourself' },
    { id: 'auto', label: 'Auto', title: 'Runs any SQL immediately, including changes' },
    { id: 'ask', label: 'Ask', title: 'Runs reads immediately, asks you to approve changes' },
];

function renderAiBar() {
    const bar = document.getElementById('chat-ai-bar');
    if (!bar) return;
    bar.innerHTML = '';

    const session = activeSession();

    const providerRow = document.createElement('div');
    providerRow.className = 'chat-ai-provider-row';

    const badge = document.createElement('div');
    if (session.provider) {
        badge.className = 'chat-ai-badge';
        badge.innerHTML = `<strong>${escapeHtml(session.providerName)}</strong>${session.modelLabel ? ` &middot; ${escapeHtml(session.modelLabel)}` : ''}`;
    } else {
        badge.className = 'chat-ai-badge muted';
        badge.textContent = 'No AI selected';
    }
    providerRow.appendChild(badge);

    const changeBtn = document.createElement('button');
    changeBtn.className = 'btn btn-secondary btn-sm';
    changeBtn.textContent = session.provider ? 'Change' : 'Select AI';
    changeBtn.addEventListener('click', openPicker);
    providerRow.appendChild(changeBtn);

    bar.appendChild(providerRow);

    const modeRow = document.createElement('div');
    modeRow.className = 'chat-mode-row';
    CHAT_MODES.forEach(m => {
        const btn = document.createElement('button');
        btn.className = `chat-mode-btn${session.mode === m.id ? ' active' : ''}`;
        btn.textContent = m.label;
        btn.title = m.title;
        btn.addEventListener('click', () => {
            session.mode = m.id;
            saveChatHistory();
            renderAiBar();
        });
        modeRow.appendChild(btn);
    });
    bar.appendChild(modeRow);
}

// ── Picker: consent card + provider/model selection ──

function openPicker() {
    document.getElementById('chat-main').style.display = 'none';
    document.getElementById('chat-picker').style.display = 'flex';

    if (!aiSettings.consented) {
        renderConsentCard();
    } else {
        renderProviderListLoading();
        scanAiProviders();
    }
}

function closePicker() {
    document.getElementById('chat-picker').style.display = 'none';
    document.getElementById('chat-main').style.display = 'flex';
}

function renderConsentCard() {
    const picker = document.getElementById('chat-picker');
    picker.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'chat-consent-card';
    card.innerHTML = `
        <h3>Scan for installed AI tools?</h3>
        <p>SnowQuery can check whether common AI command-line tools (Claude Code, Codex, Ollama, Gemini CLI, Aider, llm) are installed on this computer, and list any local Ollama models. This only checks what's <strong>installed locally</strong> — nothing is read, sent anywhere, or run beyond a quick version check.</p>
    `;

    const actions = document.createElement('div');
    actions.className = 'chat-consent-actions';

    const allowBtn = document.createElement('button');
    allowBtn.className = 'btn btn-primary btn-sm';
    allowBtn.textContent = 'Allow scan';
    allowBtn.addEventListener('click', () => {
        aiSettings.consented = true;
        saveAiSettings();
        renderProviderListLoading();
        scanAiProviders();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary btn-sm';
    cancelBtn.textContent = 'Not now';
    cancelBtn.addEventListener('click', closePicker);

    actions.appendChild(cancelBtn);
    actions.appendChild(allowBtn);
    card.appendChild(actions);
    picker.appendChild(card);
}

function renderProviderListLoading() {
    document.getElementById('chat-picker').innerHTML = '<div class="tree-loading">Scanning for AI tools installed on this computer…</div>';
}

async function scanAiProviders() {
    try {
        const res = await fetch(`${API_BASE}/api/ai-providers/scan`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Scan failed');
        providersScanCache = data.providers || [];
        renderProviderList(providersScanCache);
    } catch (err) {
        document.getElementById('chat-picker').innerHTML = `<div class="chat-consent-card"><p>Scan failed: ${escapeHtml(err.message)}</p></div>`;
    }
}

function renderProviderList(providers) {
    const picker = document.getElementById('chat-picker');
    picker.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'chat-picker-header';
    const heading = document.createElement('h3');
    heading.textContent = 'Choose an AI';
    header.appendChild(heading);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary btn-sm';
    closeBtn.textContent = activeSession().provider ? 'Cancel' : 'Close';
    closeBtn.addEventListener('click', closePicker);
    header.appendChild(closeBtn);
    picker.appendChild(header);

    const list = document.createElement('div');
    list.className = 'chat-provider-list';

    providers.forEach(p => {
        const card = document.createElement('div');
        card.className = `chat-provider-card${!p.detected ? ' unavailable' : ''}${p.planned ? ' planned' : ''}`;

        const title = document.createElement('div');
        title.className = 'chat-provider-title';
        title.innerHTML = `<strong>${escapeHtml(p.name)}</strong>`;
        card.appendChild(title);

        const status = document.createElement('div');
        status.className = 'chat-provider-status';
        if (!p.detected) {
            status.textContent = 'Not installed on this computer';
        } else if (p.planned) {
            status.textContent = `Detected (${p.version || 'installed'}) — integration coming soon`;
        } else {
            status.textContent = p.version || 'Detected';
        }
        card.appendChild(status);

        if (p.detected && !p.planned) {
            if (p.modelListSupported && p.models && p.models.length) {
                const select = document.createElement('select');
                select.className = 'chat-model-select';
                p.models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.label;
                    select.appendChild(opt);
                });
                card.appendChild(select);

                const useBtn = document.createElement('button');
                useBtn.className = 'btn btn-primary btn-sm';
                useBtn.textContent = 'Use this';
                useBtn.addEventListener('click', () => {
                    const chosen = p.models.find(m => m.id === select.value);
                    selectProvider(p, chosen.id, chosen.label);
                });
                card.appendChild(useBtn);
            } else if (p.modelListSupported) {
                const note = document.createElement('div');
                note.className = 'chat-provider-status';
                note.textContent = 'No local models found';
                card.appendChild(note);
            } else {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'chat-model-input';
                input.placeholder = 'Model (optional — blank uses the default)';
                card.appendChild(input);

                const useBtn = document.createElement('button');
                useBtn.className = 'btn btn-primary btn-sm';
                useBtn.textContent = 'Use this';
                useBtn.addEventListener('click', () => {
                    const val = input.value.trim();
                    selectProvider(p, val || null, val || 'default');
                });
                card.appendChild(useBtn);
            }
        }

        list.appendChild(card);
    });

    picker.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'chat-picker-footer';
    const rescanBtn = document.createElement('button');
    rescanBtn.className = 'btn btn-secondary btn-sm';
    rescanBtn.textContent = 'Rescan';
    rescanBtn.addEventListener('click', () => { renderProviderListLoading(); scanAiProviders(); });
    footer.appendChild(rescanBtn);
    picker.appendChild(footer);
}

function selectProvider(p, modelId, modelLabel) {
    const session = activeSession();
    session.provider = p.id;
    session.providerName = p.name;
    session.model = modelId;
    session.modelLabel = modelLabel;
    saveChatHistory();
    renderAiBar();
    renderChatSessionTabs();
    closePicker();
    showToast(`Using ${p.name}${modelLabel ? ' (' + modelLabel + ')' : ''} in "${session.name}"`, 'success');
}

// ── Messages ──

function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const session = activeSession();

    if (session.history.length === 0 && !session.pending) {
        container.innerHTML = '<div class="empty-state">Pick an AI above, then ask about the current database — e.g. "which table has the most rows?"</div>';
        return;
    }

    container.innerHTML = '';
    session.history.forEach((msg, idx) => {
        container.appendChild(buildChatBubble(msg, idx));
    });
    if (session.pending) {
        container.appendChild(buildPendingBubble(session.pendingStatusText || 'Thinking…'));
    }
    container.scrollTop = container.scrollHeight;
}

function buildChatBubble(msg, idx) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${msg.role}${msg.error ? ' error' : ''}`;

    const textEl = document.createElement('div');
    textEl.textContent = msg.displayText !== undefined ? msg.displayText : msg.content;
    bubble.appendChild(textEl);

    if (msg.sql && !msg.awaitingApproval) {
        bubble.appendChild(buildSqlBlock(msg.sql));
    }

    if (msg.executedQueries && msg.executedQueries.length) {
        msg.executedQueries.forEach(q => bubble.appendChild(buildExecutedQueryBlock(q)));
    }

    if (msg.awaitingApproval || (msg.resolved && msg.sqlForApproval)) {
        bubble.appendChild(buildApprovalBlock(msg, idx));
    }

    return bubble;
}

function buildSqlBlock(sql) {
    const block = document.createElement('div');
    block.className = 'chat-sql-block';

    const pre = document.createElement('pre');
    pre.textContent = sql;
    block.appendChild(pre);

    const actions = document.createElement('div');
    actions.className = 'chat-sql-actions';
    const insertBtn = document.createElement('button');
    insertBtn.className = 'btn btn-secondary btn-sm';
    insertBtn.textContent = 'Insert & Run';
    insertBtn.addEventListener('click', () => insertAndRunSql(sql));
    actions.appendChild(insertBtn);
    block.appendChild(actions);

    return block;
}

function buildExecutedQueryBlock(q) {
    const block = document.createElement('div');
    block.className = 'chat-sql-block executed';

    const pre = document.createElement('pre');
    pre.textContent = q.sql;
    block.appendChild(pre);

    const summary = document.createElement('div');
    summary.className = 'chat-exec-summary';
    if (q.error) {
        summary.classList.add('error');
        summary.textContent = `Error: ${q.error}`;
    } else if (q.rows && q.rows.length) {
        summary.textContent = `${q.rowCount} row(s)`;
    } else {
        summary.textContent = `${q.command} executed${q.rowCount !== null && q.rowCount !== undefined ? ` — ${q.rowCount} row(s) affected` : ''}`;
    }
    block.appendChild(summary);

    if (q.rows && q.rows.length) {
        block.appendChild(buildMiniResultTable(q.columns, q.rows));
    }

    const actions = document.createElement('div');
    actions.className = 'chat-sql-actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-secondary btn-sm';
    openBtn.textContent = 'Open in worksheet';
    openBtn.addEventListener('click', () => {
        switchView('worksheets');
        editor.setValue(q.sql);
        saveCurrentWorksheet();
    });
    actions.appendChild(openBtn);
    block.appendChild(actions);

    return block;
}

function buildMiniResultTable(columns, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-mini-table-wrap';

    const cols = columns && columns.length ? columns : Object.keys(rows[0] || {});
    const table = document.createElement('table');
    table.className = 'chat-mini-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    cols.forEach(c => {
        const th = document.createElement('th');
        th.textContent = c;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.slice(0, 5).forEach(row => {
        const tr = document.createElement('tr');
        cols.forEach(c => {
            const td = document.createElement('td');
            const val = row[c];
            td.textContent = val === null || val === undefined ? 'NULL' : String(val);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    if (rows.length > 5) {
        const more = document.createElement('div');
        more.className = 'chat-exec-summary';
        more.textContent = `...and ${rows.length - 5} more row(s)`;
        wrap.appendChild(more);
    }

    return wrap;
}

function buildApprovalBlock(msg, idx) {
    const block = document.createElement('div');
    block.className = 'chat-sql-block approval';

    const pre = document.createElement('pre');
    pre.textContent = msg.sqlForApproval || msg.sql;
    block.appendChild(pre);

    if (msg.resolved) {
        const resolvedEl = document.createElement('div');
        resolvedEl.className = 'chat-exec-summary';
        resolvedEl.textContent = msg.resolvedApproved ? 'Approved — this ran on your database.' : 'Rejected — not run.';
        block.appendChild(resolvedEl);
        return block;
    }

    const warn = document.createElement('div');
    warn.className = 'chat-exec-summary warn';
    warn.textContent = 'This changes data. Approve to run it on your database.';
    block.appendChild(warn);

    const actions = document.createElement('div');
    actions.className = 'chat-sql-actions';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-secondary btn-sm';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => resolveApproval(idx, false));

    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-primary btn-sm';
    approveBtn.textContent = 'Approve & Run';
    approveBtn.addEventListener('click', () => resolveApproval(idx, true));

    actions.appendChild(rejectBtn);
    actions.appendChild(approveBtn);
    block.appendChild(actions);

    return block;
}

function insertAndRunSql(sql) {
    switchView('worksheets');
    editor.setValue(sql);
    saveCurrentWorksheet();
    setTimeout(() => runQuery(), 100);
}

// ── Streaming: the server sends newline-delimited JSON — {type:'status', text} events while
// it works, then exactly one {type:'result'|'awaitingApproval'|'error'} terminal event.
async function streamChatRequest(url, body, onStatus) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        let errMsg = 'Request failed';
        try { const data = await response.json(); errMsg = data.error || errMsg; } catch (e) { /* ignore */ }
        throw new Error(errMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalEvent = null;

    const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt;
        try { evt = JSON.parse(trimmed); } catch (e) { return; }
        if (evt.type === 'status') {
            if (onStatus) onStatus(evt.text);
        } else {
            finalEvent = evt;
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            handleLine(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 1);
        }
    }
    handleLine(buffer);

    if (!finalEvent) throw new Error('No response received from server');
    if (finalEvent.type === 'error') throw new Error(finalEvent.error || 'Request failed');
    return finalEvent;
}

function buildPendingBubble(text) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble assistant pending';

    const wrap = document.createElement('div');
    wrap.className = 'chat-thinking';

    const spinner = document.createElement('span');
    spinner.className = 'chat-spinner';
    wrap.appendChild(spinner);

    const label = document.createElement('span');
    label.className = 'chat-thinking-text';
    label.textContent = text;
    wrap.appendChild(label);

    bubble.appendChild(wrap);
    return bubble;
}

function updatePendingBubble(bubble, text) {
    const label = bubble.querySelector('.chat-thinking-text');
    if (label) label.textContent = text;
    const container = document.getElementById('chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
}

function normalizeChatEvent(evt) {
    return {
        reply: evt.reply,
        sql: evt.sql,
        executedQueries: evt.executedQueries || [],
        awaitingApproval: evt.type === 'awaitingApproval',
        resumeState: evt.resumeState || null,
    };
}

function buildAssistantEntry(data) {
    const replyText = data.sql ? data.reply.replace(/```sql[\s\S]*?```/i, '').trim() : data.reply;
    return {
        role: 'assistant',
        content: data.reply,
        displayText: replyText || data.reply,
        sql: data.awaitingApproval ? null : (data.sql || null),
        executedQueries: data.executedQueries || [],
        awaitingApproval: !!data.awaitingApproval,
        resumeState: data.resumeState || null,
    };
}

// Builds a status callback that updates a session's stored status text always, but only
// touches the visible pending-bubble DOM node when that session is the one currently shown —
// so switching tabs away and back never loses progress, it just stops/resumes being visible.
function makeSessionStatusUpdater(session) {
    return (text) => {
        session.pendingStatusText = text;
        if (activeChatSessionId === session.id) {
            const bubbleEl = document.querySelector('#chat-messages .chat-bubble.pending');
            if (bubbleEl) updatePendingBubble(bubbleEl, text);
        }
    };
}

// Called when a session's in-flight request finishes (success or failure), regardless of
// whether that session is still the one on screen.
function finishSessionTurn(session) {
    session.pending = false;
    session.pendingStatusText = '';
    saveChatHistory();
    renderChatSessionTabs();
    if (activeChatSessionId === session.id) {
        renderChatMessages();
    }
    document.getElementById('chat-send').disabled = activeSession().pending;
}

async function resolveApproval(idx, approved) {
    const session = activeSession(); // the approval button only exists while its session is on screen
    const msg = session.history[idx];
    if (!msg || msg.resolved) return;

    msg.resolved = true;
    msg.resolvedApproved = approved;
    msg.sqlForApproval = msg.sql;
    msg.awaitingApproval = false;

    session.pending = true;
    session.pendingStatusText = approved ? 'Running the query…' : 'Noting your answer…';
    renderChatMessages();
    renderChatSessionTabs();
    saveChatHistory();
    document.getElementById('chat-send').disabled = activeSession().pending;

    try {
        const finalEvent = await streamChatRequest(
            `${API_BASE}/api/chat/resume`,
            { resumeState: msg.resumeState, approved },
            makeSessionStatusUpdater(session)
        );
        session.history.push(buildAssistantEntry(normalizeChatEvent(finalEvent)));
    } catch (err) {
        session.history.push({ role: 'assistant', content: err.message, error: true });
    } finally {
        finishSessionTurn(session);
    }
}

async function sendChatMessage() {
    const session = activeSession();
    if (session.pending) return;

    if (!session.provider) {
        showToast('Pick an AI provider first', 'error');
        openPicker();
        return;
    }

    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;

    const attachment = pendingAttachment;
    const attachmentNote = attachment
        ? (attachment.type === 'image' ? `\n📎 ${attachment.fileName}` : `\n📎 ${attachment.fileName} (${attachment.rows.length} rows)`)
        : '';

    input.value = '';
    session.history.push({ role: 'user', content: message + attachmentNote });
    autoTitleSessionIfDefault(session, message);
    session.pending = true;
    session.pendingStatusText = 'Reading the database schema…';
    renderChatMessages();
    renderChatSessionTabs();
    saveChatHistory();
    clearAttachment();

    document.getElementById('chat-send').disabled = activeSession().pending;

    try {
        const database = document.getElementById('db-selector').value;
        const historyForApi = session.history
            .slice(0, -1)
            .slice(-6)
            .map(m => ({ role: m.role, content: m.content }));

        const finalEvent = await streamChatRequest(
            `${API_BASE}/api/chat`,
            {
                message, database, history: historyForApi,
                provider: session.provider, model: session.model, mode: session.mode,
                currentTable: previewContext ? `${previewContext.schema}.${previewContext.table}` : null,
                worksheetSql: editor ? editor.getValue() : '',
                role: document.getElementById('role-selector').value,
                fileContext: attachment && attachment.type === 'file'
                    ? { fileName: attachment.fileName, headers: attachment.headers, rows: attachment.rows }
                    : null,
                image: attachment && attachment.type === 'image' ? attachment.dataUrl : null,
            },
            makeSessionStatusUpdater(session)
        );

        session.history.push(buildAssistantEntry(normalizeChatEvent(finalEvent)));
    } catch (err) {
        session.history.push({ role: 'assistant', content: err.message, error: true });
    } finally {
        finishSessionTurn(session);
    }
}

// ═══════════════════════════════════════════
// Chat Skills (saved prompt templates)
// ═══════════════════════════════════════════

const DEFAULT_SKILLS = [
    { id: 'explain-table', name: 'Explain this table', prompt: 'Explain what the table/view I currently have open is for, what its columns mean, and how it likely relates to other tables in this database.' },
    { id: 'find-slow', name: 'Find slow queries', prompt: 'Look at table sizes and row counts and tell me which tables or the kinds of queries against them are likely to be slow, and why.' },
    { id: 'suggest-indexes', name: 'Suggest indexes', prompt: 'Suggest indexes that would likely improve performance for the current table, based on its columns, primary key, and any foreign-key-looking columns.' },
    { id: 'summarize-db', name: 'Summarize this database', prompt: 'Give me a summary of this database: what real-world domain it looks like it models, its main tables, and how they relate to each other.' },
    { id: 'generate-sample-data', name: 'Generate sample data', prompt: 'Generate and insert 20 rows of realistic sample data into the current table, respecting its column types and any foreign key relationships.' },
];

function loadSkills() {
    const saved = localStorage.getItem('snowquery_skills');
    if (saved) {
        try { skills = JSON.parse(saved); return; } catch (e) { /* fall through to defaults */ }
    }
    skills = DEFAULT_SKILLS.map(s => ({ ...s }));
}

function saveSkills() {
    localStorage.setItem('snowquery_skills', JSON.stringify(skills));
}

function toggleSkillsPopover() {
    const pop = document.getElementById('chat-skills-popover');
    if (pop.style.display === 'none') {
        renderSkillsPopover();
        pop.style.display = 'block';
    } else {
        pop.style.display = 'none';
    }
}

function renderSkillsPopover() {
    const pop = document.getElementById('chat-skills-popover');
    pop.innerHTML = '';

    if (skills.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.padding = '8px';
        empty.textContent = 'No skills yet';
        pop.appendChild(empty);
    }

    skills.forEach((skill, idx) => {
        const item = document.createElement('div');
        item.className = 'chat-skill-item';

        const label = document.createElement('span');
        label.textContent = skill.name;
        label.title = skill.prompt;
        item.appendChild(label);

        const delBtn = document.createElement('span');
        delBtn.className = 'chat-skill-item-delete';
        delBtn.innerHTML = '×';
        delBtn.title = 'Delete skill';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            skills.splice(idx, 1);
            saveSkills();
            renderSkillsPopover();
        });
        item.appendChild(delBtn);

        item.addEventListener('click', () => {
            const input = document.getElementById('chat-input');
            input.value = skill.prompt;
            document.getElementById('chat-skills-popover').style.display = 'none';
            input.focus();
        });

        pop.appendChild(item);
    });

    const footer = document.createElement('div');
    footer.className = 'chat-skills-popover-footer';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-secondary btn-sm';
    addBtn.style.width = '100%';
    addBtn.textContent = '+ New skill';
    addBtn.addEventListener('click', addSkill);
    footer.appendChild(addBtn);
    pop.appendChild(footer);
}

function addSkill() {
    const name = prompt('Skill name (short label):');
    if (!name || !name.trim()) return;
    const text = prompt('Prompt text this skill inserts:');
    if (!text || !text.trim()) return;
    skills.push({ id: 'skill_' + Date.now().toString(36), name: name.trim(), prompt: text.trim() });
    saveSkills();
    renderSkillsPopover();
}

// ═══════════════════════════════════════════
// Chat Attachments (CSV/Excel context + images)
// ═══════════════════════════════════════════

function handleAttachFile(file) {
    if (!file) return;

    if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
            pendingAttachment = { type: 'image', dataUrl: reader.result, fileName: file.name };
            renderAttachmentChip();
        };
        reader.onerror = () => showToast('Failed to read that image', 'error');
        reader.readAsDataURL(file);
        return;
    }

    if (/\.xlsx?$/i.test(file.name)) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const workbook = XLSX.read(reader.result, { type: 'array' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
                const headers = (rows[0] || []).map(h => String(h));
                const dataRows = rows.slice(1).filter(r => r.some(v => v !== '' && v !== null && v !== undefined));
                pendingAttachment = { type: 'file', fileName: file.name, headers, rows: dataRows.slice(0, 200) };
                renderAttachmentChip();
            } catch (e) {
                showToast('Could not read that spreadsheet: ' + e.message, 'error');
            }
        };
        reader.onerror = () => showToast('Failed to read that file', 'error');
        reader.readAsArrayBuffer(file);
        return;
    }

    // CSV (or anything else — try as text)
    const reader = new FileReader();
    reader.onload = () => {
        const { headers, rows } = parseCsv(String(reader.result));
        if (headers.length === 0) {
            showToast('Could not read any rows from that file', 'error');
            return;
        }
        pendingAttachment = { type: 'file', fileName: file.name, headers, rows: rows.slice(0, 200) };
        renderAttachmentChip();
    };
    reader.onerror = () => showToast('Failed to read that file', 'error');
    reader.readAsText(file);
}

function renderAttachmentChip() {
    const container = document.getElementById('chat-attachments');
    container.innerHTML = '';

    if (!pendingAttachment) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';

    const chip = document.createElement('div');
    chip.className = 'chat-attachment-chip';

    if (pendingAttachment.type === 'image') {
        const img = document.createElement('img');
        img.src = pendingAttachment.dataUrl;
        chip.appendChild(img);
    }

    const name = document.createElement('span');
    name.className = 'chat-attachment-chip-name';
    name.textContent = pendingAttachment.type === 'image'
        ? pendingAttachment.fileName
        : `${pendingAttachment.fileName} (${pendingAttachment.rows.length} rows)`;
    chip.appendChild(name);

    const remove = document.createElement('span');
    remove.className = 'chat-attachment-chip-remove';
    remove.innerHTML = '×';
    remove.title = 'Remove attachment';
    remove.addEventListener('click', clearAttachment);
    chip.appendChild(remove);

    container.appendChild(chip);
}

function clearAttachment() {
    pendingAttachment = null;
    renderAttachmentChip();
}

// ═══════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Make sortResults available globally
window.sortResults = sortResults;
