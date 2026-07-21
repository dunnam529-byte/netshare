const SERVER_URL = localStorage.getItem('regnis_server_url') || localStorage.getItem('nexus_server_url') || 'http://localhost:8080';
const WS_URL = SERVER_URL.replace(/^http/, 'ws');

// DOM Elements
const serverDot = document.getElementById('server-dot');
const serverText = document.getElementById('server-text');
const hostIpsBanner = document.getElementById('host-ips-banner');

const toggleChatBtn = document.getElementById('toggle-chat-btn');
const toggleFilesBtn = document.getElementById('toggle-files-btn');

const countUsers = document.getElementById('count-users');
const countMessages = document.getElementById('count-messages');
const countBlocked = document.getElementById('count-blocked');

const manualBlockIpInput = document.getElementById('manual-block-ip-input');
const blockManualIpBtn = document.getElementById('block-manual-ip-btn');

const usersTableBody = document.getElementById('users-table-body');
const logsContainer = document.getElementById('logs-container');

let ws;
let serverOnline = false;

// Initialize WebSocket to local server as Admin role
function connectAdminSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        serverOnline = true;
        updateServerBadge(true);

        // Notify server that we are connected as an Admin client
        ws.send(JSON.stringify({
            type: 'join',
            nickname: 'Host_Admin',
            isAdmin: true
        }));

        addLogEntry('System WebSocket link established. Synchronizing streams...', 'system');
        fetchServerState();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'welcome':
                    applyServerConfig(data.config);
                    break;
                case 'user_list':
                    renderUsersTable(data.users);
                    countBlocked.textContent = data.blockedIPs.length;
                    break;
                case 'chat':
                    if (data.recipient === 'Group') {
                        addLogEntry(`[CHAT] ${data.sender}: ${data.text}`, 'chat');
                    } else {
                        addLogEntry(`[DIRECT CHAT] ${data.sender} -> Node: ${data.text}`, 'chat');
                    }
                    incrementMetric(countMessages);
                    break;
                case 'file_shared':
                    addLogEntry(`[FILE SHARED] ${data.file.sender} shared "${data.file.originalName}" (${formatBytes(data.file.size)})`, 'file');
                    break;
                case 'system_log':
                    addLogEntry(data.text, 'system');
                    break;
                case 'config_update':
                    applyServerConfig(data.config);
                    break;
            }
        } catch (e) {
            console.error('Failed to parse admin message:', e);
        }
    };

    ws.onclose = () => {
        serverOnline = false;
        updateServerBadge(false);
        addLogEntry('System WebSocket link severed. Attempting reconnection in 5s...', 'error');
        setTimeout(connectAdminSocket, 5000);
    };

    ws.onerror = (err) => {
        console.error('Admin Socket error:', err);
    };
}

// REST fetch server state (fallback + stats loading)
async function fetchServerState() {
    try {
        const response = await fetch(`${SERVER_URL}/api/admin/data`);
        if (!response.ok) throw new Error('Query error');

        const data = await response.json();

        // Render users
        renderUsersTable(data.clients);

        // Render logs from server history
        logsContainer.innerHTML = '';
        data.messages.forEach(m => {
            const label = m.recipient === 'Group' ? '[CHAT]' : '[DIRECT CHAT]';
            addLogEntry(`${label} ${m.sender}: ${m.text}`, 'chat');
        });

        data.files.forEach(f => {
            addLogEntry(`[FILE SHARED] ${f.sender} shared "${f.originalName}" (${formatBytes(f.size)})`, 'file');
        });

        // Set metrics
        countUsers.textContent = data.clients.filter(c => !c.isAdmin).length;
        countMessages.textContent = data.messages.length;
        countBlocked.textContent = data.blockedIPs.length;

        // IPs banner
        const currentUrlObj = new URL(SERVER_URL);
        const currentPort = currentUrlObj.port || (currentUrlObj.protocol === 'https:' ? '443' : '80');
        if (data.ips && data.ips.length > 0) {
            hostIpsBanner.textContent = 'Active host addresses: ' + data.ips.map(ip => `http://${ip}:${currentPort}`).join(', ');
        } else {
            hostIpsBanner.textContent = `Active host addresses: http://localhost:${currentPort}`;
        }

        applyServerConfig(data.config);
    } catch (e) {
        console.error('Failed to query companion server data:', e);
    }
}

// User elements & lists rendering
function renderUsersTable(clients) {
    usersTableBody.innerHTML = '';

    const activeClients = clients.filter(c => !c.isAdmin);

    if (activeClients.length === 0) {
        usersTableBody.innerHTML = `
            <tr>
                <td colspan="4" class="text-center text-muted">No clients detected on host subnet.</td>
            </tr>
        `;
        countUsers.textContent = '0';
        return;
    }

    countUsers.textContent = activeClients.length;

    activeClients.forEach(client => {
        const tr = document.createElement('tr');

        tr.innerHTML = `
            <td><strong>${escapeHTML(client.nickname)}</strong></td>
            <td><code>${client.ip}</code></td>
            <td><span class="status-label" style="color: #00f2fe">Online</span></td>
            <td class="text-right">
                <button class="cyber-btn-red" data-ip="${client.ip}">BLOCK IP</button>
            </td>
        `;

        // Attach blocking listener
        const blockBtn = tr.querySelector('.cyber-btn-red');
        blockBtn.addEventListener('click', () => {
            blockIP(client.ip);
        });

        usersTableBody.appendChild(tr);
    });
}

// Admin settings and config
function applyServerConfig(config) {
    toggleChatBtn.checked = config.groupChatEnabled;
    toggleFilesBtn.checked = config.fileSharingEnabled;
}

// Server toggle trigger event handlers
toggleChatBtn.addEventListener('change', () => {
    if (!serverOnline) return;
    ws.send(JSON.stringify({
        type: 'admin_action',
        action: 'toggle_group_chat'
    }));
});

toggleFilesBtn.addEventListener('change', () => {
    if (!serverOnline) return;
    ws.send(JSON.stringify({
        type: 'admin_action',
        action: 'toggle_file_sharing'
    }));
});

// Manual IP block listener
blockManualIpBtn.addEventListener('click', () => {
    const ip = manualBlockIpInput.value.trim();
    if (!ip) return;
    blockIP(ip);
    manualBlockIpInput.value = '';
});

// Post Block requests
function blockIP(ip) {
    if (!serverOnline) {
        alert('Cannot execute action. Companion server is offline.');
        return;
    }
    ws.send(JSON.stringify({
        type: 'admin_action',
        action: 'block',
        ip: ip
    }));
    addLogEntry(`Sent command to block IP: ${ip}`, 'system');

    // Quick reload
    setTimeout(fetchServerState, 500);
}

// Logger helpers
function addLogEntry(text, type = 'system') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const d = new Date();
    const timeStr = d.toLocaleTimeString([], { hour12: false });

    entry.textContent = `[${timeStr}] ${text}`;
    logsContainer.appendChild(entry);

    // Auto scroll logs
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

function updateServerBadge(isOnline) {
    if (isOnline) {
        serverDot.className = 'dot online';
        serverText.textContent = 'ACTIVE';
        serverText.style.color = '#00f2fe';
    } else {
        serverDot.className = 'dot offline';
        serverText.textContent = 'OFFLINE';
        serverText.style.color = '#ff3333';
        hostIpsBanner.textContent = 'Start Node server locally.';
    }
}

function incrementMetric(elem) {
    let val = parseInt(elem.textContent) || 0;
    elem.textContent = val + 1;
}

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Start connection
connectAdminSocket();
