let SERVER_URL = localStorage.getItem('regnis_server_url') || localStorage.getItem('nexus_server_url') || 'http://localhost:8080';

// DOM elements
const statusBadge = document.getElementById('status-badge');
const statusInfo = document.getElementById('status-info');
const networkIps = document.getElementById('network-ips');
const launchAdminBtn = document.getElementById('launch-admin-btn');
const serverUrlInput = document.getElementById('server-url-input');
const saveServerUrlBtn = document.getElementById('save-server-url-btn');

if (serverUrlInput) {
    serverUrlInput.value = SERVER_URL;
}

saveServerUrlBtn.addEventListener('click', () => {
    let url = serverUrlInput.value.trim();
    if (!url) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
    }
    localStorage.setItem('regnis_server_url', url);
    SERVER_URL = url;
    fetchServerStatus();
});

// Fetch server status on popup load
async function fetchServerStatus() {
    try {
        const response = await fetch(`${SERVER_URL}/api/status`);
        if (!response.ok) throw new Error('Unhealthy status');

        const data = await response.json();

        // Update status badge
        statusBadge.textContent = 'ACTIVE';
        statusBadge.className = 'status-badge status-online';

        // Update status info
        statusInfo.innerHTML = `Running with <strong>${data.activeUsersCount}</strong> active network nodes.`;

        // Update active host LAN IPs
        networkIps.innerHTML = '';
        const currentUrlObj = new URL(SERVER_URL);
        const currentPort = currentUrlObj.port || (currentUrlObj.protocol === 'https:' ? '443' : '80');
        if (data.ips && data.ips.length > 0) {
            data.ips.forEach(ip => {
                const li = document.createElement('li');
                li.textContent = `http://${ip}:${currentPort}`;
                networkIps.appendChild(li);
            });
        } else {
            networkIps.innerHTML = `<li>http://localhost:${currentPort}</li>`;
        }
    } catch (err) {
        // Handle server offline state
        const currentUrlObj = new URL(SERVER_URL);
        const currentPort = currentUrlObj.port || (currentUrlObj.protocol === 'https:' ? '443' : '80');
        statusBadge.textContent = 'OFFLINE';
        statusBadge.className = 'status-badge status-offline';
        statusInfo.textContent = `Regnis Host Server is not running on port ${currentPort}. Start Node server locally.`;

        networkIps.innerHTML = '<li>No LAN IP detected</li>';
    }
}

// Open Admin Panel tab when button is clicked
launchAdminBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') });
});

// Run
fetchServerStatus();
