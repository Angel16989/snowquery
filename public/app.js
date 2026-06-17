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

// ═══════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    initEditor();
    initWorksheets();
    initNavigation();
    initResizer();
    initEventListeners();
    checkConnection();
    loadDatabases();
    loadDbSelector();
    checkSetupStatus();

    // Show the worksheets view with sidebar collapsed by default
    switchView('worksheets');
});

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
