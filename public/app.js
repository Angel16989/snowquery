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
let chatHistory = [];
let chatPending = false;
let aiSettings = { consented: false, provider: null, providerName: null, model: null, modelLabel: null, mode: 'plan' };
let providersScanCache = null;

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
            completeSingle: false,
            completeOnSingleClick: false,
        },
    });

    // Auto-complete on typing
    editor.on('inputRead', (cm, change) => {
        if (change.text[0] && /[a-zA-Z_.]/.test(change.text[0])) {
            const cursor = cm.getCursor();
            const token = cm.getTokenAt(cursor);
            if (token.string.length >= 2) {
                cm.showHint({ completeSingle: false });
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
    renderWorksheetTabs();
}

function saveCurrentWorksheet() {
    const ws = worksheets.find(w => w.id === activeWorksheetId);
    if (ws) {
        ws.sql = editor.getValue();
        ws.database = document.getElementById('db-selector').value;
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
        const response = await fetch(`${API_BASE}/api/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql, database }),
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
        chatHistory = [];
        localStorage.removeItem('snowquery_chat');
        renderChatMessages();
    });

    // Save Settings
    document.getElementById('save-settings').addEventListener('click', saveSettings);
    document.getElementById('setup-database').addEventListener('click', setupLearningDatabase);
    document.getElementById('setting-database').addEventListener('change', checkSetupStatus);

    // Database selector change
    document.getElementById('db-selector').addEventListener('change', () => {
        saveCurrentWorksheet();
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

function initChat() {
    const savedChat = localStorage.getItem('snowquery_chat');
    if (savedChat) {
        try { chatHistory = JSON.parse(savedChat); } catch (e) { chatHistory = []; }
    }
    const savedSettings = localStorage.getItem('snowquery_ai_settings');
    if (savedSettings) {
        try { aiSettings = { ...aiSettings, ...JSON.parse(savedSettings) }; } catch (e) { /* keep defaults */ }
    }
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

function toggleChatPanel() {
    const panel = document.getElementById('chat-floating-panel');
    const isOpen = panel.classList.toggle('open');
    document.getElementById('chat-fab').classList.toggle('active', isOpen);
    if (isOpen) {
        applyChatLayout();
        setTimeout(() => document.getElementById('chat-input')?.focus(), 200);
    }
}

function closeChatPanel() {
    document.getElementById('chat-floating-panel').classList.remove('open');
    document.getElementById('chat-fab').classList.remove('active');
}

function saveChatHistory() {
    localStorage.setItem('snowquery_chat', JSON.stringify(chatHistory));
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

    const providerRow = document.createElement('div');
    providerRow.className = 'chat-ai-provider-row';

    const badge = document.createElement('div');
    if (aiSettings.provider) {
        badge.className = 'chat-ai-badge';
        badge.innerHTML = `<strong>${escapeHtml(aiSettings.providerName)}</strong>${aiSettings.modelLabel ? ` &middot; ${escapeHtml(aiSettings.modelLabel)}` : ''}`;
    } else {
        badge.className = 'chat-ai-badge muted';
        badge.textContent = 'No AI selected';
    }
    providerRow.appendChild(badge);

    const changeBtn = document.createElement('button');
    changeBtn.className = 'btn btn-secondary btn-sm';
    changeBtn.textContent = aiSettings.provider ? 'Change' : 'Select AI';
    changeBtn.addEventListener('click', openPicker);
    providerRow.appendChild(changeBtn);

    bar.appendChild(providerRow);

    const modeRow = document.createElement('div');
    modeRow.className = 'chat-mode-row';
    CHAT_MODES.forEach(m => {
        const btn = document.createElement('button');
        btn.className = `chat-mode-btn${aiSettings.mode === m.id ? ' active' : ''}`;
        btn.textContent = m.label;
        btn.title = m.title;
        btn.addEventListener('click', () => {
            aiSettings.mode = m.id;
            saveAiSettings();
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
    closeBtn.textContent = aiSettings.provider ? 'Cancel' : 'Close';
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
    aiSettings.provider = p.id;
    aiSettings.providerName = p.name;
    aiSettings.model = modelId;
    aiSettings.modelLabel = modelLabel;
    saveAiSettings();
    renderAiBar();
    closePicker();
    showToast(`Using ${p.name}${modelLabel ? ' (' + modelLabel + ')' : ''}`, 'success');
}

// ── Messages ──

function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    if (chatHistory.length === 0) {
        container.innerHTML = '<div class="empty-state">Pick an AI above, then ask about the current database — e.g. "which table has the most rows?"</div>';
        return;
    }

    container.innerHTML = '';
    chatHistory.forEach((msg, idx) => {
        container.appendChild(buildChatBubble(msg, idx));
    });
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

async function resolveApproval(idx, approved) {
    const msg = chatHistory[idx];
    if (!msg || msg.resolved) return;

    msg.resolved = true;
    msg.resolvedApproved = approved;
    msg.sqlForApproval = msg.sql;
    msg.awaitingApproval = false;
    renderChatMessages();
    saveChatHistory();

    chatPending = true;
    const container = document.getElementById('chat-messages');
    const pendingBubble = buildPendingBubble(approved ? 'Running the query…' : 'Noting your answer…');
    container.appendChild(pendingBubble);
    container.scrollTop = container.scrollHeight;

    try {
        const finalEvent = await streamChatRequest(
            `${API_BASE}/api/chat/resume`,
            { resumeState: msg.resumeState, approved },
            (text) => updatePendingBubble(pendingBubble, text)
        );
        chatHistory.push(buildAssistantEntry(normalizeChatEvent(finalEvent)));
    } catch (err) {
        chatHistory.push({ role: 'assistant', content: err.message, error: true });
    } finally {
        chatPending = false;
        renderChatMessages();
        saveChatHistory();
    }
}

async function sendChatMessage() {
    if (chatPending) return;

    if (!aiSettings.provider) {
        showToast('Pick an AI provider first', 'error');
        openPicker();
        return;
    }

    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    chatHistory.push({ role: 'user', content: message });
    renderChatMessages();
    saveChatHistory();

    chatPending = true;
    const container = document.getElementById('chat-messages');
    const pendingBubble = buildPendingBubble('Reading the database schema…');
    container.appendChild(pendingBubble);
    container.scrollTop = container.scrollHeight;

    const sendBtn = document.getElementById('chat-send');
    sendBtn.disabled = true;

    try {
        const database = document.getElementById('db-selector').value;
        const historyForApi = chatHistory
            .slice(0, -1)
            .slice(-6)
            .map(m => ({ role: m.role, content: m.content }));

        const finalEvent = await streamChatRequest(
            `${API_BASE}/api/chat`,
            {
                message, database, history: historyForApi,
                provider: aiSettings.provider, model: aiSettings.model, mode: aiSettings.mode,
            },
            (text) => updatePendingBubble(pendingBubble, text)
        );

        chatHistory.push(buildAssistantEntry(normalizeChatEvent(finalEvent)));
    } catch (err) {
        chatHistory.push({ role: 'assistant', content: err.message, error: true });
    } finally {
        chatPending = false;
        sendBtn.disabled = false;
        renderChatMessages();
        saveChatHistory();
    }
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
