// ================================================================
// Regnis V2 — Client (Full SPA Engine)
// ================================================================
'use strict';

// ── State ────────────────────────────────────────────────────
const state = {
    token:        localStorage.getItem('regnis_token')    || localStorage.getItem('nexus_token')    || '',
    myUid:        localStorage.getItem('regnis_uid')      || localStorage.getItem('nexus_uid')      || '',
    myNickname:   localStorage.getItem('regnis_nickname') || localStorage.getItem('nexus_nickname') || '',
    isAdmin:      false,
    profilePhoto: null,

    currentView:          'chat',
    currentRecipient:     'global',
    currentRecipientType: 'global',
    currentRecipientName: '🌐 Global Chat',
    activeFileTab:        'photo',
    activePoolTab:        'all',
    activeUsersFilter:    'all',

    users:         [],
    groups:        [],
    messages:      {},
    chatFiles:     {},
    poolFiles:     [],
    unread:        {},
    notifications: [],
    readReceipts:  {},

    ws:                 null,
    selectedGroupMembers: new Set(),
    pendingUploadFile:  null,
    uploadTargetType:   'chat', // 'chat' or 'pool'
    activeReactionMsgId: null,
    activeCommentFileId: null,
    activeCommentFileType: null,
    adminResetTargetUid: null,
    pendingDlFileId:     null,
    pendingDlFilename:   '',

    typingTimers:       {},
    lastTypingSent:     0
};

const channelKey = (r, t) => `${t}:${r}`;

function getMsgChannelKey(msg) {
    if (msg.recipientType === 'user') {
        const peerUid = msg.senderUid === state.myUid ? msg.recipient : msg.senderUid;
        return channelKey(peerUid, 'user');
    }
    return channelKey(msg.recipient, msg.recipientType);
}

function isMsgForCurrentChannel(msg) {
    if (msg.recipientType === 'user') {
        const peerUid = msg.senderUid === state.myUid ? msg.recipient : msg.senderUid;
        return state.currentRecipientType === 'user' && state.currentRecipient === peerUid;
    }
    return state.currentRecipient === msg.recipient && state.currentRecipientType === msg.recipientType;
}

// ── Debug Logging & Utility Helpers ───────────────────────────
const $ = id => document.getElementById(id);

function debugLog(...args) {
    console.log('%c[Regnis Debug]', 'color: #06b6d4; font-weight: bold;', ...args);
}

function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileCategoryClient(filename) {
    if (!filename) return 'other';
    const ext = '.' + filename.split('.').pop().toLowerCase();
    const photos = ['.jpg','.jpeg','.png','.gif','.webp','.bmp','.svg','.avif'];
    const videos = ['.mp4','.webm','.ogg','.mov','.avi','.mkv','.m4v','.wmv'];
    if (photos.includes(ext)) return 'photo';
    if (videos.includes(ext)) return 'video';
    return 'other';
}

function tryParseJSON(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    fetchStatus();
    requestNotificationPermission();

    // Check if returning user with valid token
    if (state.token) {
        verifyAutoLogin();
    }

    bindEvents();
    setupDragAndDrop();
});

function fetchStatus() {
    fetch('/api/status').then(r => r.json()).then(data => {
        const ips = data.ips || [];
        $('join-host-ip').textContent = ips.length ? ips.join(', ') : window.location.hostname;
        if (data.announcement) showAnnouncement(data.announcement);
    }).catch(() => {
        $('join-host-ip').textContent = window.location.hostname;
    });
}

function verifyAutoLogin() {
    if (!state.token) return;
    fetch('/api/me', { headers: { 'Authorization': `Bearer ${state.token}` } })
        .then(res => {
            if (res.ok) return res.json();
            throw new Error('Token expired');
        })
        .then(userData => {
            state.myUid = userData.uid;
            state.myNickname = userData.nickname;
            state.isAdmin = userData.isAdmin;
            state.profilePhoto = userData.profilePhoto;
            showApp();
            updateHeaderUser();
            initWebSocket();
            loadInitialData();
        })
        .catch(() => {
            // Invalid token
            localStorage.removeItem('regnis_token');
            localStorage.removeItem('regnis_uid');
            localStorage.removeItem('regnis_nickname');
            localStorage.removeItem('nexus_token');
            localStorage.removeItem('nexus_uid');
            localStorage.removeItem('nexus_nickname');
            state.token = '';
            state.myUid = '';
            state.myNickname = '';
        });
}

// ── Browser Notifications ─────────────────────────────────────
function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
        try {
            const p = Notification.requestPermission();
            if (p && typeof p.then === 'function') {
                p.then(permission => {
                    debugLog('Notification permission:', permission);
                }).catch(() => {});
            }
        } catch (e) {}
    }
}

function sendBrowserNotification(title, body, icon) {
    let sent = false;
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            const n = new Notification(title, {
                body,
                icon: icon || '/favicon.ico',
                tag: `regnis_msg_${Date.now()}`
            });
            n.onclick = () => {
                window.focus();
                showView('chat');
                n.close();
            };
            sent = true;
        } catch (e) {
            sent = false;
        }
    }
    if (!sent) {
        showToast(`${title}: ${body}`, 'info');
    }
}

// ── Bind Events ───────────────────────────────────────────────
function bindEvents() {
    // Message input typing listener
    const msgInp = $('msg-input');
    msgInp.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            sendMessage();
        } else {
            handleTypingEvent();
        }
    });

    // Close reaction picker on click outside
    document.addEventListener('click', e => {
        const picker = $('reaction-picker');
        if (!picker.classList.contains('hidden') && !picker.contains(e.target) && !e.target.classList.contains('reaction-btn')) {
            picker.classList.add('hidden');
        }
        const dd = $('profile-dropdown');
        if (!dd.classList.contains('hidden') && !dd.contains(e.target) && !$('profile-btn').contains(e.target)) {
            dd.classList.add('hidden');
        }
        const nd = $('notification-drawer');
        if (!nd.classList.contains('hidden') && !nd.contains(e.target) && !$('notif-bell').contains(e.target)) {
            nd.classList.add('hidden');
        }
    });

    // File inputs
    $('file-input-chat').addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) openUploadPreviewModal(file, 'chat');
        e.target.value = '';
    });
    $('file-input-pool').addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) openUploadPreviewModal(file, 'pool');
        e.target.value = '';
    });
    $('file-input-profile').addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) uploadProfilePhoto(file);
        e.target.value = '';
    });

    $('comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitComment(); });
    $('comment-submit-btn').addEventListener('click', submitComment);
}

// ── Auth Tab Switch ───────────────────────────────────────────
function switchAuthTab(tab) {
    $('tab-login-btn').classList.toggle('active', tab === 'login');
    $('tab-register-btn').classList.toggle('active', tab === 'register');
    $('login-form-area').classList.toggle('hidden', tab !== 'login');
    $('register-form-area').classList.toggle('hidden', tab !== 'register');
    $('login-error').classList.add('hidden');
    $('register-error').classList.add('hidden');
}

// ── Auth Handlers ─────────────────────────────────────────────
async function handleLogin(e) {
    if (e) e.preventDefault();
    const nickname = $('login-nickname').value.trim();
    const password = $('login-password').value;

    $('login-error').classList.add('hidden');

    if (!nickname || !password) {
        showAuthError('login-error', 'Please enter username and password');
        return;
    }

    setAuthLoading(true, 'Logging in...');
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname, password })
        });
        const data = await res.json();
        setAuthLoading(false);

        if (!res.ok) {
            showAuthError('login-error', data.error || 'Login failed');
            return;
        }

        saveAuthSession(data);
        showApp();
        updateHeaderUser();
        initWebSocket();
        loadInitialData();
    } catch (err) {
        console.error('Login error:', err);
        setAuthLoading(false);
        showAuthError('login-error', 'Connection failed. Check server status.');
    }
}

async function handleRegister(e) {
    if (e) e.preventDefault();
    const nickname = $('register-nickname').value.trim();
    const password = $('register-password').value;

    if (!nickname || !password) return showAuthError('register-error', 'Please fill in all required fields');
    if (password.length < 4) return showAuthError('register-error', 'Password must be at least 4 characters');

    setAuthLoading(true, 'Creating account...');
    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname, password })
        });
        const data = await res.json();

        if (!res.ok) {
            setAuthLoading(false);
            return showAuthError('register-error', data.error || 'Registration failed');
        }

        const profileFile = $('profile-input-join').files[0];
        if (data.status === 'pending') {
            setAuthLoading(false);
            showOverlay('pending');
            return;
        }

        saveAuthSession(data);

        if (profileFile) {
            try { await uploadProfilePhotoRaw(profileFile); } catch(e) {}
        }

        setAuthLoading(false);
        showApp();
        updateHeaderUser();
        initWebSocket();
        loadInitialData();
    } catch (err) {
        setAuthLoading(false);
        showAuthError('register-error', 'Connection failed');
    }
}

function saveAuthSession(data) {
    state.token = data.token;
    state.myUid = data.uid;
    state.myNickname = data.nickname;
    state.isAdmin = data.isAdmin;
    state.profilePhoto = data.profilePhoto;

    localStorage.setItem('regnis_token', data.token);
    localStorage.setItem('regnis_uid', data.uid);
    localStorage.setItem('regnis_nickname', data.nickname);
}

function showAuthError(elementId, msg) {
    const el = $(elementId);
    el.textContent = msg;
    el.classList.remove('hidden');
}

function setAuthLoading(loading, text) {
    $('join-loading-text').textContent = text || 'Connecting...';
    $('join-loading').classList.toggle('hidden', !loading);
    $('login-form-area').classList.toggle('hidden', loading || !$('tab-login-btn').classList.contains('active'));
    $('register-form-area').classList.toggle('hidden', loading || !$('tab-register-btn').classList.contains('active'));
}

function handleJoinProfilePreview(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        $('profile-preview-join').innerHTML = `<img src="${e.target.result}" style="width:70px;height:70px;border-radius:50%;object-fit:cover;">`;
    };
    reader.readAsDataURL(file);
}

// ── WebSocket ─────────────────────────────────────────────────
function initWebSocket() {
    if (!state.token && !state.myUid) return;
    debugLog('WebSocket initializing...');
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        debugLog('WebSocket already connected. Sending join...');
        state.ws.send(JSON.stringify({ type: 'join', token: state.token, uid: state.myUid }));
        return;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.ws = new WebSocket(`${proto}//${location.host}`);

    state.ws.onopen = () => {
        debugLog('WebSocket connected. Sending join payload...', { token: state.token, uid: state.myUid });
        state.ws.send(JSON.stringify({ type: 'join', token: state.token, uid: state.myUid }));
    };

    state.ws.onmessage = ({ data }) => {
        try {
            const parsed = JSON.parse(data);
            debugLog('WebSocket message received:', parsed.type, parsed);
            handleWSMessage(parsed);
        } catch (e) {
            console.error('Failed to parse WS message:', e, data);
        }
    };

    state.ws.onerror = (err) => {
        debugLog('WebSocket error:', err);
    };

    state.ws.onclose = (ev) => {
        debugLog('WebSocket closed:', ev.code, ev.reason);
        setTimeout(() => { if (state.token) initWebSocket(); }, 3000);
    };
}

function wsSend(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        debugLog('WebSocket sending:', payload.type, payload);
        state.ws.send(JSON.stringify(payload));
    } else {
        debugLog('WebSocket send skipped (not OPEN):', payload);
        showToast('Connection lost. Reconnecting...', 'warning');
    }
}

// ── WS Message Dispatcher ─────────────────────────────────────
async function handleWSMessage(data) {
    switch (data.type) {

        case 'error': {
            debugLog('WS Server Error:', data.message);
            showToast(data.message || 'WebSocket Error', 'error');
            break;
        }

        case 'welcome': {
            debugLog('Welcome event received:', data);
            state.isAdmin = !!data.isAdmin;
            state.profilePhoto = data.profilePhoto;
            applyServerConfig(data.config);
            if (data.announcement) showAnnouncement(data.announcement);
            showApp();
            updateHeaderUser();
            loadInitialData();
            break;
        }

        case 'access_pending': {
            showOverlay('pending');
            break;
        }

        case 'access_approved': {
            if (data.token) {
                saveAuthSession(data);
                showToast('Access approved! Welcome to network.', 'success');
                initWebSocket();
            }
            break;
        }

        case 'access_rejected': {
            showOverlay('blocked');
            break;
        }

        case 'kicked':
        case 'blocked': {
            localStorage.clear();
            $('blocked-title').textContent = data.type === 'kicked' ? 'Account Kicked' : 'Connection Blocked';
            $('blocked-desc').textContent = data.reason || 'Your access was revoked by Administrator.';
            showOverlay('blocked');
            break;
        }

        case 'password_reset': {
            localStorage.clear();
            showToast(data.reason || 'Your password was reset. Please log in.', 'warning');
            location.reload();
            break;
        }

        case 'user_list': {
            state.users = data.users || [];
            renderSidebar();
            if (state.currentView === 'users') renderUsersGrid();
            updateAdminUsersList();
            break;
        }

        case 'system': {
            const key = channelKey('global', 'global');
            if (!state.messages[key]) state.messages[key] = [];
            state.messages[key].push({ id: `sys_${Date.now()}`, type: 'system', text: data.text, timestamp: data.timestamp || Date.now() });
            if (state.currentRecipient === 'global') renderMessages();
            break;
        }

        case 'read_receipt': {
            if (data.channelKey) {
                state.readReceipts[data.channelKey] = data.timestamp;
                if (state.currentRecipientType === 'user' && state.currentRecipient === data.readerUid) {
                    renderMessages();
                }
            }
            break;
        }

        case 'chat': {
            const msg = data.message;
            const key = getMsgChannelKey(msg);
            if (!state.messages[key]) state.messages[key] = [];

            // Prevent duplicate message processing
            if (state.messages[key].some(m => m.id === msg.id)) {
                break;
            }

            state.messages[key].push(msg);

            const isCurrentChannel = isMsgForCurrentChannel(msg);

            if (isCurrentChannel) {
                appendMessage(msg);
                scrollToBottom();
                if (msg.senderUid !== state.myUid && msg.recipientType === 'user') {
                    wsSend({
                        type: 'read_receipt',
                        recipient: msg.senderUid,
                        timestamp: msg.timestamp
                    });
                }
            } else if (msg.senderUid !== state.myUid) {
                state.unread[key] = (state.unread[key] || 0) + 1;
                renderSidebar();
            }

            if (msg.senderUid !== state.myUid) {
                const isDM = msg.recipientType === 'user' && msg.recipient === state.myUid;
                const myNick = state.myNickname || '';
                const isMention = myNick && msg.text && msg.text.toLowerCase().includes(`@${myNick.toLowerCase()}`);

                if (isDM) {
                    sendBrowserNotification(`💬 New DM from ${msg.senderName}`, msg.text);
                } else if (isMention) {
                    sendBrowserNotification(`🔔 Mentioned by ${msg.senderName} in ${msg.recipientType === 'global' ? 'Global Chat' : 'Group'}`, msg.text);
                }
            }
            break;
        }

        case 'user_typing': {
            const isForMe = data.recipientType === 'user'
                ? (data.recipient === state.myUid && state.currentRecipient === data.senderUid)
                : (data.recipient === state.currentRecipient && data.recipientType === state.currentRecipientType);
            if (isForMe) {
                showTypingIndicator(data.nickname);
            }
            break;
        }

        case 'reaction_updated': {
            for (const k in state.messages) {
                const msg = state.messages[k].find(m => m.id === data.messageId);
                if (msg) {
                    msg.reactions = data.reactions;
                    renderMessageReactionsDOM(data.messageId, data.reactions);
                    break;
                }
            }
            break;
        }

        case 'chat_edited': {
            for (const k in state.messages) {
                const msg = state.messages[k].find(m => m.id === data.messageId);
                if (msg) {
                    msg.text = data.newText;
                    msg.edited = true;
                    const el = document.querySelector(`[data-msg-id="${data.messageId}"] .msg-text-content`);
                    if (el) el.textContent = data.newText;
                    break;
                }
            }
            break;
        }

        case 'chat_deleted': {
            for (const k in state.messages) {
                const msg = state.messages[k].find(m => m.id === data.messageId);
                if (msg) {
                    msg.deleted = true;
                    msg.text = '[Message deleted]';
                    const el = document.querySelector(`[data-msg-id="${data.messageId}"] .msg-text-content`);
                    if (el) el.textContent = '[Message deleted]';
                    break;
                }
            }
            break;
        }

        case 'file_shared': {
            const file = data.file;
            const key = getMsgChannelKey(file);
            if (!state.chatFiles[key]) state.chatFiles[key] = [];

            // Prevent duplicate file message processing
            if (state.chatFiles[key].some(f => f.id === file.id)) {
                break;
            }

            state.chatFiles[key].push(file);

            const isCurrentChannel = isMsgForCurrentChannel(file);
            const senderUid = file.senderUid || file.sender_uid;

            if (isCurrentChannel) {
                appendFileMessage(file);
                scrollToBottom();
                renderChatFiles();
                if (senderUid !== state.myUid && file.recipientType === 'user') {
                    wsSend({
                        type: 'read_receipt',
                        recipient: senderUid,
                        timestamp: file.timestamp
                    });
                }
            }
            break;
        }

        case 'file_deleted': {
            const el = document.querySelector(`[data-file-id="${data.fileId}"]`);
            if (el) el.remove();
            break;
        }

        case 'pool_updated': {
            if (state.currentView === 'pool') loadPoolFiles();
            break;
        }

        case 'comment_added': {
            const pFile = state.poolFiles.find(f => f.id === data.fileId);
            if (pFile) {
                pFile.commentCount = data.commentCount;
            }
            const poolBtnSpan = document.querySelector(`.pool-card[data-file-id="${data.fileId}"] .btn-icon span`);
            if (poolBtnSpan) {
                poolBtnSpan.textContent = data.commentCount;
            }
            const chatBtnSpan = document.querySelector(`.file-msg-card[data-file-id="${data.fileId}"] .comment-count`);
            if (chatBtnSpan) {
                chatBtnSpan.textContent = data.commentCount;
            }
            if (state.activeCommentFileId === data.fileId) {
                apiGet(`/api/file/${data.fileType}/${data.fileId}/comments`)
                    .then(res => res.json())
                    .then(comments => renderCommentsList(comments));
            }
            break;
        }

        case 'group_created': {
            state.groups.push(data.group);
            renderSidebar();
            showToast(`You were added to group "${data.group.name}"`, 'info');
            break;
        }

        case 'group_updated': {
            const idx = state.groups.findIndex(g => g.id === data.groupId || (data.group && g.id === data.group.id));
            if (idx !== -1) {
                if (data.group) state.groups[idx] = data.group;
                if (data.name) state.groups[idx].name = data.name;
                renderSidebar();
            }
            break;
        }

        case 'group_deleted':
        case 'group_removed': {
            state.groups = state.groups.filter(g => g.id !== data.groupId);
            renderSidebar();
            if (state.currentRecipient === data.groupId) {
                selectChannel('global', 'global', '🌐 Global Chat');
            }
            break;
        }

        case 'announcement': {
            showAnnouncement(data.text);
            break;
        }

        case 'notification': {
            state.notifications.unshift(data.notification);
            updateNotificationBadge();
            sendBrowserNotification(data.notification.title, data.notification.body);
            break;
        }

        case 'config_update': {
            applyServerConfig(data.config);
            break;
        }
    }
}

function applyServerConfig(config) {
    if (!config) return;
    state.config = config;
    const modePub = $('mode-public');
    const modePriv = $('mode-private');
    if (modePub && modePriv) {
        modePub.classList.toggle('active', config.networkMode === 'public');
        modePriv.classList.toggle('active', config.networkMode === 'private');
    }
    const chToggle = $('toggle-group-chat');
    if (chToggle) chToggle.checked = !!config.groupChatEnabled;
    const fileToggle = $('toggle-file-sharing');
    if (fileToggle) fileToggle.checked = !!config.fileSharingEnabled;

    const chatBadge = $('chat-disabled-badge');
    if (chatBadge) chatBadge.classList.toggle('hidden', !!config.groupChatEnabled);
    const filesBadge = $('files-disabled-badge');
    if (filesBadge) filesBadge.classList.toggle('hidden', !!config.fileSharingEnabled);
}

async function loadAdminPendingUsers() {
    if (!state.isAdmin) return;
    try {
        const res = await apiGet('/api/pending');
        const pending = await res.json();
        const badge = $('pending-count-badge');
        if (badge) badge.textContent = pending.length;
        const list = $('admin-pending-list');
        if (!list) return;
        if (!pending.length) {
            list.innerHTML = `<div class="text-muted text-sm">No pending requests</div>`;
            return;
        }
        list.innerHTML = '';
        pending.forEach(u => {
            const div = document.createElement('div');
            div.className = 'admin-user-row';
            div.innerHTML = `
                <div style="flex:1;">
                    <div style="font-size:0.85rem;font-weight:600;">${escapeHTML(u.nickname)}</div>
                    <div class="text-xs text-muted">IP: ${escapeHTML(u.ip || 'Unknown')}</div>
                </div>
                <button class="btn btn-primary" style="font-size:0.72rem;padding:4px 8px;" onclick="approvePendingUser('${u.uid}')">Approve</button>
                <button class="btn btn-danger" style="font-size:0.72rem;padding:4px 8px;" onclick="rejectPendingUser('${u.uid}')">Reject</button>
            `;
            list.appendChild(div);
        });
    } catch(e) {}
}

async function approvePendingUser(uid) {
    const res = await apiPost(`/api/admin/approve/${uid}`, {});
    if (res.ok) { loadAdminPendingUsers(); showToast('User approved', 'success'); }
}

async function rejectPendingUser(uid) {
    const res = await apiPost(`/api/admin/reject/${uid}`, {});
    if (res.ok) { loadAdminPendingUsers(); showToast('User rejected', 'info'); }
}

async function setNetworkMode(mode) {
    await apiPost('/api/admin/config', { key: 'networkMode', value: mode });
}

async function toggleConfig(key, val) {
    await apiPost('/api/admin/config', { key, value: val });
}

// ── Show App & Overlays ───────────────────────────────────────
function showApp() {
    $('join-overlay').classList.add('hidden');
    $('pending-overlay').classList.add('hidden');
    $('blocked-overlay').classList.add('hidden');
    $('app').classList.remove('hidden');

    if (state.isAdmin) {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
        loadAdminPendingUsers();
    }
    requestNotificationPermission();
}

function showOverlay(name) {
    $('join-overlay').classList.add('hidden');
    $('pending-overlay').classList.add('hidden');
    $('blocked-overlay').classList.add('hidden');
    $('app').classList.add('hidden');
    $(`${name}-overlay`).classList.remove('hidden');
}

// ── Load Initial Data ─────────────────────────────────────────
async function loadInitialData() {
    await Promise.all([
        loadGroups(),
        loadHistory('global', 'global'),
        loadNotifications()
    ]);
    renderSidebar();
    renderMessages();
    renderChatFiles();
}

async function loadGroups() {
    try {
        const res = await apiGet('/api/groups');
        state.groups = await res.json();
    } catch (e) {}
}

async function loadHistory(recipient, recipientType) {
    const key = channelKey(recipient, recipientType);
    try {
        const res = await apiGet(`/api/history?recipient=${encodeURIComponent(recipient)}&recipientType=${encodeURIComponent(recipientType)}`);
        const data = await res.json();
        state.messages[key] = data.messages || [];
        state.chatFiles[key] = data.files || [];
        if (recipientType === 'user') {
            if (data.readReceipts && data.readReceipts.length > 0) {
                state.readReceipts[key] = data.readReceipts[0].timestamp;
            } else {
                state.readReceipts[key] = 0;
            }
        }
    } catch (e) {
        state.messages[key] = [];
        state.chatFiles[key] = [];
    }
}

async function loadNotifications() {
    try {
        const res = await apiGet('/api/notifications');
        state.notifications = await res.json();
        updateNotificationBadge();
    } catch (e) {}
}

// ── Typing Indicator ──────────────────────────────────────────
function handleTypingEvent() {
    const now = Date.now();
    if (now - state.lastTypingSent > 2000) {
        state.lastTypingSent = now;
        wsSend({ type: 'typing', recipient: state.currentRecipient, recipientType: state.currentRecipientType });
    }
}

function showTypingIndicator(nickname) {
    $('typing-text').textContent = `${nickname} is typing...`;
    $('typing-indicator').classList.remove('hidden');

    if (state.typingTimers[nickname]) clearTimeout(state.typingTimers[nickname]);
    state.typingTimers[nickname] = setTimeout(() => {
        $('typing-indicator').classList.add('hidden');
    }, 3000);
}

// ── Views Management ──────────────────────────────────────────
function showView(view) {
    state.currentView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    $(`view-${view}`).classList.remove('hidden');
    $(`nav-${view}`).classList.add('active');

    if (view === 'pool') loadPoolFiles();
    if (view === 'users') renderUsersGrid();

    wsSend({
        type: 'channel_focus',
        recipient: view === 'chat' ? state.currentRecipient : 'other',
        recipientType: view === 'chat' ? state.currentRecipientType : 'other'
    });
    renderOnlineUsersBar();
}

// ── Sidebar & Channels ────────────────────────────────────────
function renderSidebar() {
    const globalItem = $('global-channel-item');
    if (globalItem) {
        const isGlobalActive = state.currentRecipient === 'global' && state.currentRecipientType === 'global';
        globalItem.classList.toggle('active', isGlobalActive);
    }
    renderGroupsList();
    renderDMList();
    renderOnlineUsersBar();
}

function renderOnlineUsersBar() {
    const container = $('online-users-bar');
    const panel = $('global-active-users-panel');
    if (!container) return;
    container.innerHTML = '';

    const isGlobal = state.currentView === 'chat' && state.currentRecipient === 'global' && state.currentRecipientType === 'global';
    if (!isGlobal) {
        if (panel) panel.classList.add('hidden');
        return;
    }
    if (panel) panel.classList.remove('hidden');

    const activeInGlobal = state.users.filter(u => u.isOnline && (u.currentChannel === 'global' || !u.currentChannel));
    if (!activeInGlobal.length) {
        container.innerHTML = `<div class="text-xs text-muted" style="padding:4px 6px;">No users active</div>`;
        return;
    }

    activeInGlobal.forEach(u => {
        const item = document.createElement('div');
        item.className = 'online-user-item-vertical';
        item.title = `${escapeAttr(u.nickname)} (Active in Global Chat - Click to Message)`;
        item.onclick = () => {
            if (u.uid !== state.myUid) {
                selectChannel(u.uid, 'user', `💬 ${u.nickname}`);
            }
        };
        item.innerHTML = `
            <div class="avatar-wrap">
                ${makeAvatarHtml(u, 'sm')}
                <span class="online-dot"></span>
            </div>
            <span class="online-user-name">${escapeHTML(u.nickname)}</span>
        `;
        container.appendChild(item);
    });
}

function renderGroupsList() {
    const container = $('groups-list');
    container.innerHTML = '';

    state.groups.forEach(group => {
        const key = channelKey(group.id, 'group');
        const isActive = state.currentRecipient === group.id && state.currentRecipientType === 'group';
        const unread = state.unread[key] || 0;

        const div = document.createElement('div');
        div.className = `channel-item ${isActive ? 'active' : ''}`;
        div.onclick = () => selectChannel(group.id, 'group', `🔒 ${group.name}`);
        div.innerHTML = `
            <div class="channel-icon-wrap"><div class="group-icon">G</div></div>
            <div class="channel-info">
                <span class="channel-name">${escapeHTML(group.name)}</span>
            </div>
            ${unread ? `<span class="unread-badge">${unread}</span>` : ''}
        `;
        container.appendChild(div);
    });
}

function renderDMList() {
    const container = $('dm-list');
    if (!container) return;
    container.innerHTML = '';

    const filterQuery = ($('dm-search-input')?.value || '').trim().toLowerCase();

    let peers = state.users.filter(u => u.uid !== state.myUid);
    if (filterQuery) {
        peers = peers.filter(u => u.nickname.toLowerCase().includes(filterQuery));
    }

    if (!peers.length) {
        container.innerHTML = `<div class="text-muted text-xs" style="padding: 6px 10px;">${filterQuery ? 'No matching users' : 'No other users'}</div>`;
        return;
    }

    peers.forEach(user => {
        const key = channelKey(user.uid, 'user');
        const isActive = state.currentRecipient === user.uid && state.currentRecipientType === 'user';
        const unread = state.unread[key] || 0;

        const div = document.createElement('div');
        div.className = `dm-item ${isActive ? 'active' : ''}`;
        div.onclick = () => selectChannel(user.uid, 'user', `💬 ${user.nickname}`);
        div.innerHTML = `
            <div class="avatar-wrap">
                ${makeAvatarHtml(user, 'sm')}
                <span class="${user.isOnline ? 'online-dot' : 'offline-dot'}"></span>
            </div>
            <span style="flex:1;font-size:0.85rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${escapeHTML(user.nickname)} ${user.isAdmin ? '<span class="text-xs" style="color:var(--accent-purple);font-weight:600;">(Admin)</span>' : ''}
            </span>
            ${unread ? `<span class="unread-badge">${unread}</span>` : ''}
        `;
        container.appendChild(div);
    });
}

async function selectChannel(recipient, recipientType, name) {
    debugLog(`Channel selected: recipient=${recipient}, type=${recipientType}, name=${name}`);
    state.currentRecipient = recipient;
    state.currentRecipientType = recipientType;
    state.currentRecipientName = name;

    const key = channelKey(recipient, recipientType);
    delete state.unread[key];

    $('chat-prefix').textContent = recipientType === 'user' ? '@' : '#';
    $('chat-title').textContent = name.replace(/^[^\w]*/, '').trim();
    $('group-settings-btn').classList.toggle('hidden', recipientType !== 'group');

    wsSend({
        type: 'channel_focus',
        recipient,
        recipientType
    });

    await loadHistory(recipient, recipientType);
    renderSidebar();
    renderMessages();
    renderChatFiles();
    renderOnlineUsersBar();
    scrollToBottom();
}

// ── Message Rendering & Reactions ────────────────────────────
function renderMessages() {
    const area = $('messages-area');
    area.innerHTML = '';

    const key = channelKey(state.currentRecipient, state.currentRecipientType);
    const msgs = state.messages[key] || [];
    const files = state.chatFiles[key] || [];

    const allItems = [...msgs, ...files.map(f => ({ ...f, _isFile: true }))]
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    if (!allItems.length) {
        area.innerHTML = `<div class="messages-empty"><div class="empty-icon">💬</div><p>No messages yet.</p></div>`;
        return;
    }

    allItems.forEach(item => {
        const isSystem = item.type === 'system' || item.senderUid === 'system' || item.sender_uid === 'system';
        if (isSystem && item.text && (item.text.includes('joined the network') || item.text.includes('left the network'))) {
            return;
        }
        if (item._isFile) {
            area.appendChild(buildFileMessageEl(item));
        } else if (isSystem) {
            const div = document.createElement('div');
            div.className = 'msg-system';
            div.innerHTML = `<span>${escapeHTML(item.text)}</span> <span class="system-time">${formatTime(item.timestamp)}</span>`;
            area.appendChild(div);
        } else {
            area.appendChild(buildMessageEl(item));
        }
    });

    scrollToBottom();
}

function appendMessage(msg) {
    const area = $('messages-area');
    const empty = area.querySelector('.messages-empty');
    if (empty) empty.remove();
    const isSystem = msg.type === 'system' || msg.senderUid === 'system' || msg.sender_uid === 'system';
    if (isSystem) {
        if (msg.text && (msg.text.includes('joined the network') || msg.text.includes('left the network'))) {
            return;
        }
        const div = document.createElement('div');
        div.className = 'msg-system';
        div.innerHTML = `<span>${escapeHTML(msg.text)}</span> <span class="system-time">${formatTime(msg.timestamp)}</span>`;
        area.appendChild(div);
    } else {
        area.appendChild(buildMessageEl(msg));
    }
}

function appendFileMessage(file) {
    const area = $('messages-area');
    const empty = area.querySelector('.messages-empty');
    if (empty) empty.remove();
    area.appendChild(buildFileMessageEl(file));
}

function getMessageReadReceiptHtml(item) {
    const isMe = (item.senderUid || item.sender_uid) === state.myUid;
    if (state.currentRecipientType !== 'user' || !isMe) {
        return '';
    }
    const key = channelKey(state.currentRecipient, state.currentRecipientType);
    const lastRead = state.readReceipts[key] || 0;
    const isSeen = lastRead >= item.timestamp;
    return `<span class="read-receipt ${isSeen ? 'seen' : ''}">✓✓</span>`;
}

function buildMessageEl(msg) {
    const isMe = msg.senderUid === state.myUid;
    const user = state.users.find(u => u.uid === msg.senderUid);

    const div = document.createElement('div');
    div.className = `msg-group ${isMe ? 'outgoing' : 'incoming'}`;
    div.dataset.msgId = msg.id;

    const reactionsHtml = buildReactionsPillsHtml(msg.reactions || []);

    div.innerHTML = `
        <div class="msg-avatar">${makeAvatarHtml(user || { nickname: msg.senderName }, 'sm')}</div>
        <div class="msg-content">
            <div class="msg-sender">${isMe ? 'You' : escapeHTML(msg.senderName)}</div>
            <div class="msg-bubble ${msg.deleted ? 'deleted' : ''}">
                <span class="msg-text-content">${escapeHTML(msg.text)}</span>
                ${msg.edited && !msg.deleted ? '<span class="msg-edited-tag">(edited)</span>' : ''}
            </div>
            <div class="msg-reactions-list" id="reactions-${msg.id}">${reactionsHtml}</div>
            <div class="msg-meta">
                <span class="msg-time">${formatTime(msg.timestamp)}</span>
                ${getMessageReadReceiptHtml(msg)}
                <div class="msg-actions">
                    ${!msg.deleted ? `
                    <button class="msg-action-btn reaction-btn" title="Add reaction" onclick="openReactionPicker(event, '${msg.id}')">😊</button>
                    ` : ''}
                    ${isMe && !msg.deleted ? `
                    <button class="msg-action-btn" title="Edit message" onclick="startEditMessage('${msg.id}')">✏️</button>
                    <button class="msg-action-btn" title="Delete message" onclick="deleteMessage('${msg.id}')">🗑️</button>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
    return div;
}

function buildFileMessageEl(file) {
    const senderUid = file.senderUid || file.sender_uid;
    const senderName = file.senderName || file.sender_name || 'User';
    const originalName = file.originalName || file.original_name || 'file';
    const isMe = senderUid === state.myUid;
    const cat = file.category;
    const ext = originalName ? originalName.split('.').pop().toUpperCase() : '?';
    const commentCount = file.commentCount || file.comment_count || 0;
    const user = state.users.find(u => u.uid === senderUid);

    let previewHtml = '';
    const tokenParam = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
    if (cat === 'photo') {
        previewHtml = `<img src="/preview/chat/${file.id}${tokenParam}" loading="lazy" alt="">`;
    } else if (cat === 'video') {
        previewHtml = `<video src="/preview/chat/${file.id}${tokenParam}" controls preload="none"></video>`;
    } else {
        previewHtml = `<div class="msg-file-ext-preview"><div class="ext-badge">.${ext}</div></div>`;
    }

    const div = document.createElement('div');
    div.className = `msg-group ${isMe ? 'outgoing' : 'incoming'}`;
    div.dataset.fileId = file.id;
    div.innerHTML = `
        <div class="msg-avatar">${makeAvatarHtml(user || { nickname: senderName }, 'sm')}</div>
        <div class="msg-content">
            <div class="msg-sender">${isMe ? 'You' : escapeHTML(senderName)}</div>
            <div class="msg-file">
                <div class="msg-file-preview">${previewHtml}</div>
                <div class="msg-file-info">
                    <span class="msg-file-name" title="${escapeHTML(originalName)}">${escapeHTML(originalName)}</span>
                    <div class="msg-file-actions">
                        <button class="comment-btn" data-file-id="${file.id}" onclick="openComments('${file.id}','chat')">
                            💬 <span class="comment-count">${commentCount}</span>
                        </button>
                        <button class="file-dl-btn" onclick="downloadChatFile('${file.id}','${escapeAttr(originalName)}')">↓</button>
                        ${isMe || state.isAdmin ? `<button class="file-del-btn" onclick="deleteChatFile('${file.id}')">🗑</button>` : ''}
                    </div>
                </div>
            </div>
            <div class="msg-meta">
                <span class="msg-time">${formatTime(file.timestamp)}</span>
                ${getMessageReadReceiptHtml(file)}
            </div>
        </div>
    `;
    return div;
}

// ── Reactions UI & Logic ──────────────────────────────────────
function openReactionPicker(e, msgId) {
    e.stopPropagation();
    state.activeReactionMsgId = msgId;
    const picker = $('reaction-picker');
    const rect = e.target.getBoundingClientRect();
    picker.style.top = `${rect.top - 40}px`;
    picker.style.left = `${rect.left}px`;
    picker.classList.remove('hidden');
}

async function addReaction(emoji) {
    $('reaction-picker').classList.add('hidden');
    const msgId = state.activeReactionMsgId;
    if (!msgId) return;

    try {
        const res = await apiPost(`/api/message/${msgId}/react`, { emoji });
        const data = await res.json();
        if (res.ok) renderMessageReactionsDOM(msgId, data.reactions);
    } catch (e) {}
}

function buildReactionsPillsHtml(reactions) {
    if (!reactions || !reactions.length) return '';
    const grouped = {};
    reactions.forEach(r => {
        if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, hasMe: false };
        grouped[r.emoji].count++;
        if (r.uid === state.myUid) grouped[r.emoji].hasMe = true;
    });

    return Object.keys(grouped).map(emoji => `
        <span class="reaction-pill ${grouped[emoji].hasMe ? 'active' : ''}" onclick="toggleReactionDirect('${emoji}')">
            ${emoji} <span>${grouped[emoji].count}</span>
        </span>
    `).join('');
}

function renderMessageReactionsDOM(msgId, reactions) {
    const el = document.getElementById(`reactions-${msgId}`);
    if (el) el.innerHTML = buildReactionsPillsHtml(reactions);
}

function toggleReactionDirect(emoji) {
    if (state.activeReactionMsgId) addReaction(emoji);
}

// ── Send Message ──────────────────────────────────────────────
function sendMessage() {
    const input = $('msg-input');
    const text = input.value.trim();
    if (!text) return;

    wsSend({
        type: 'chat_message',
        text,
        recipient: state.currentRecipient,
        recipientType: state.currentRecipientType
    });
    input.value = '';
}

function scrollToBottom() {
    const area = $('messages-area');
    area.scrollTop = area.scrollHeight;
}

// ── Drag & Drop File Upload ───────────────────────────────────
function setupDragAndDrop() {
    const zone = $('chat-drop-zone');
    const overlay = $('drag-drop-overlay');

    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());

    zone.addEventListener('dragenter', e => {
        e.preventDefault();
        overlay.classList.remove('hidden');
    });

    overlay.addEventListener('dragleave', e => {
        e.preventDefault();
        overlay.classList.add('hidden');
    });

    overlay.addEventListener('drop', e => {
        e.preventDefault();
        overlay.classList.add('hidden');
        const file = e.dataTransfer.files[0];
        if (file) openUploadPreviewModal(file, 'chat');
    });
}

// ── Upload Preview & Custom File Name Modal ───────────────────
function openChatFileUploadDialog() {
    $('file-input-chat').click();
}
function openPoolUploadModalDialog() {
    $('file-input-pool').click();
}

function openUploadPreviewModal(file, targetType) {
    state.pendingUploadFile = file;
    state.uploadTargetType = targetType;

    $('upload-modal-title').textContent = targetType === 'chat' ? '📎 Share File to Chat' : '🗂️ Upload to File Pool';
    $('upload-custom-name').value = file.name;
    $('pool-pass-group').classList.toggle('hidden', targetType !== 'pool');
    $('pool-password-input').value = '';

    const preview = $('upload-file-preview-box');
    const cat = getFileCategoryClient(file.name);

    if (cat === 'photo') {
        const reader = new FileReader();
        reader.onload = e => { preview.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;">`; };
        reader.readAsDataURL(file);
    } else if (cat === 'video') {
        const url = URL.createObjectURL(file);
        preview.innerHTML = `<video src="${url}" style="width:100%;height:100%;object-fit:cover;"></video>`;
    } else {
        const ext = file.name.split('.').pop().toUpperCase();
        preview.innerHTML = `<div class="ext-badge">.${ext}</div>`;
    }

    $('pool-modal-progress-wrap').classList.add('hidden');
    openModal('modal-upload-preview');
}

function submitFileUpload() {
    const file = state.pendingUploadFile;
    if (!file) return;

    const customName = $('upload-custom-name').value.trim();
    const btn = $('upload-confirm-btn');
    btn.disabled = true;

    $('pool-modal-progress-wrap').classList.remove('hidden');

    const formData = new FormData();
    formData.append('file', file);
    if (customName) formData.append('customName', customName);

    let url = '/upload/chat';
    if (state.uploadTargetType === 'chat') {
        formData.append('recipient', state.currentRecipient);
        formData.append('recipientType', state.currentRecipientType);
    } else {
        url = '/upload/pool';
        const pass = $('pool-password-input').value;
        if (pass) formData.append('password', pass);
    }

    debugLog('UPLOAD STARTING:', { fileName: file.name, size: file.size, targetType: state.uploadTargetType, url });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.setRequestHeader('X-UID', state.myUid);

    xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
            const pct = Math.round(e.loaded / e.total * 100);
            $('pool-modal-pct').textContent = `${pct}%`;
            $('pool-modal-fill').style.width = `${pct}%`;
            debugLog(`UPLOAD PROGRESS: ${pct}%`);
        }
    };

    xhr.onload = () => {
        btn.disabled = false;
        closeModal('modal-upload-preview');
        if (xhr.status === 200) {
            debugLog('UPLOAD SUCCESS:', xhr.responseText);
            showToast('File uploaded successfully!', 'success');
            if (state.uploadTargetType === 'pool') loadPoolFiles();
        } else {
            const err = tryParseJSON(xhr.responseText);
            debugLog('UPLOAD FAILED status=', xhr.status, err);
            showToast(err?.error || `Upload failed (${xhr.status})`, 'error');
        }
    };
    xhr.onerror = (e) => {
        btn.disabled = false;
        closeModal('modal-upload-preview');
        debugLog('UPLOAD NETWORK ERROR:', e);
        showToast('Network error during upload', 'error');
    };
    xhr.send(formData);
}

// ── File Pool (Sorting, Filtering, Search) ───────────────────
let poolSearchTimer = null;
function debouncePoolSearch() {
    clearTimeout(poolSearchTimer);
    poolSearchTimer = setTimeout(renderPool, 300);
}

async function loadPoolFiles() {
    const search = $('pool-search-input')?.value || '';
    const sort = $('pool-sort-select')?.value || 'recent';
    const cat = state.activePoolTab;

    try {
        const res = await apiGet(`/api/pool?search=${encodeURIComponent(search)}&sort=${sort}&category=${cat}`);
        state.poolFiles = await res.json();
        renderPoolDOM();
    } catch (e) {}
}

function renderPool() { loadPoolFiles(); }

function renderPoolDOM() {
    const container = $('pool-container');
    container.innerHTML = '';

    if (!state.poolFiles.length) {
        container.innerHTML = `<div class="files-empty" style="grid-column:1/-1;">No files found in the pool.</div>`;
        return;
    }

    state.poolFiles.forEach(file => {
        const isOwn = file.uploaderUid === state.myUid;
        const ext = file.originalName.split('.').pop().toUpperCase();
        const isBlurred = !!file.hasPassword;

        let previewHtml = '';
        const tokenParam = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
        if (file.category === 'photo') {
            previewHtml = `<img src="/preview/pool/${file.id}${tokenParam}" loading="lazy" alt="">`;
        } else if (file.category === 'video') {
            previewHtml = `<video src="/preview/pool/${file.id}${tokenParam}" preload="none"></video>`;
        } else {
            previewHtml = `<div class="ext-badge">.${ext}</div>`;
        }

        const card = document.createElement('div');
        card.className = 'pool-card';
        card.dataset.fileId = file.id;
        card.innerHTML = `
            <div class="pool-card-preview ${isBlurred && file.category !== 'other' ? 'blurred' : ''}">
                ${previewHtml}
                ${isBlurred ? `<div class="lock-overlay"><span class="lock-icon">🔒</span><span>Password Protected</span></div>` : ''}
            </div>
            <div class="pool-card-body">
                <div class="pool-card-name" title="${escapeHTML(file.originalName)}">${escapeHTML(file.originalName)}</div>
                <div class="pool-card-meta">
                    By <strong>${escapeHTML(file.uploaderName)}</strong> · ${formatBytes(file.size)}
                </div>
                <div class="pool-card-actions">
                    <button class="btn-download" onclick="downloadPoolFile('${file.id}','${escapeAttr(file.originalName)}',${isBlurred})">
                        ${isBlurred ? '🔒 Download' : '↓ Download'}
                    </button>
                    <button class="btn-icon" onclick="openComments('${file.id}','pool')" title="Comments">
                        💬 <span>${file.commentCount || 0}</span>
                    </button>
                    ${isOwn || state.isAdmin ? `
                    <button class="btn-danger-icon" onclick="deletePoolFile('${file.id}')" title="Delete File">🗑</button>
                    ` : ''}
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function selectPoolTab(btn, tab) {
    document.querySelectorAll('.pool-tabs .file-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activePoolTab = tab;
    loadPoolFiles();
}

// ── Search Overlay & Message Linking ──────────────────────────
function openSearchModal() {
    $('global-search-input').value = '';
    $('search-results-list').innerHTML = `<div class="text-muted text-center" style="padding:20px;">Type to search messages & files</div>`;
    openModal('modal-search');
}

let searchTimer = null;
function debounceGlobalSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(performGlobalSearch, 300);
}

async function performGlobalSearch() {
    const q = $('global-search-input').value.trim();
    if (!q) return;

    const res = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const list = $('search-results-list');
    list.innerHTML = '';

    if (!data.messages.length && !data.files.length) {
        list.innerHTML = `<div class="text-muted text-center" style="padding:20px;">No results found</div>`;
        return;
    }

    data.messages.forEach(m => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.onclick = () => jumpToMessage(m.recipient, m.recipient_type, m.id);
        item.innerHTML = `
            <div style="font-weight:600;font-size:0.8rem;color:var(--accent-cyan);">${escapeHTML(m.sender_name)}</div>
            <div style="font-size:0.85rem;margin:2px 0;">${escapeHTML(m.text)}</div>
            <div class="text-xs text-muted">${formatDate(m.timestamp)}</div>
        `;
        list.appendChild(item);
    });
}

async function jumpToMessage(recipient, recipientType, msgId) {
    closeModal('modal-search');
    showView('chat');
    await selectChannel(recipient, recipientType, recipient);
    const target = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.background = 'rgba(124,58,237,0.3)';
        setTimeout(() => target.style.background = '', 2000);
    }
}

// ── Group Management ──────────────────────────────────────────
function openGroupManagementModal() {
    const group = state.groups.find(g => g.id === state.currentRecipient);
    if (!group) return;

    $('mgmt-group-name').value = group.name;
    const list = $('mgmt-members-list');
    list.innerHTML = '';

    group.members.forEach(uid => {
        const user = state.users.find(u => u.uid === uid);
        const item = document.createElement('div');
        item.className = 'member-option';
        item.innerHTML = `
            ${makeAvatarHtml(user || { nickname: 'Member' }, 'sm')}
            <span style="flex:1;font-size:0.85rem;">${escapeHTML(user ? user.nickname : uid)}</span>
            ${group.createdBy === state.myUid && uid !== state.myUid ? `
            <button class="btn btn-danger" style="font-size:0.7rem;padding:2px 6px;" onclick="kickGroupMember('${group.id}','${uid}')">Kick</button>
            ` : ''}
        `;
        list.appendChild(item);
    });

    openModal('modal-group-mgmt');
}

async function updateGroupName() {
    const name = $('mgmt-group-name').value.trim();
    if (!name) return;
    const res = await apiPatch(`/api/group/${state.currentRecipient}`, { name });
    if (res.ok) { closeModal('modal-group-mgmt'); showToast('Group renamed', 'success'); }
}

async function kickGroupMember(groupId, targetUid) {
    const res = await apiDelete(`/api/group/${groupId}/members/${targetUid}`);
    if (res.ok) { openGroupManagementModal(); showToast('Member removed', 'info'); }
}

async function leaveCurrentGroup() {
    if (!confirm('Leave this group?')) return;
    const res = await apiDelete(`/api/group/${state.currentRecipient}/members/${state.myUid}`);
    if (res.ok) closeModal('modal-group-mgmt');
}

async function deleteCurrentGroup() {
    if (!confirm('Delete this entire group?')) return;
    const res = await apiDelete(`/api/group/${state.currentRecipient}`);
    if (res.ok) closeModal('modal-group-mgmt');
}

// ── Admin Panel Features (Kick, Reset Password, Storage) ──────
function updateAdminUsersList() {
    if (!state.isAdmin) return;
    const list = $('admin-users-list');
    if (!list) return;
    list.innerHTML = '';

    state.users.forEach(u => {
        const row = document.createElement('div');
        row.className = 'admin-user-row';
        row.innerHTML = `
            ${makeAvatarHtml(u, 'sm')}
            <div style="flex:1;">
                <div style="font-size:0.85rem;font-weight:500;">${escapeHTML(u.nickname)}</div>
                <div class="admin-user-ip">${u.isOnline ? '● Online' : '○ Offline'}</div>
            </div>
            ${!u.isAdmin ? `
            <button class="btn btn-outline" style="font-size:0.72rem;padding:4px 8px;" onclick="openAdminResetPasswordModal('${u.uid}','${escapeAttr(u.nickname)}')">Reset Pass</button>
            <button class="btn btn-danger" style="font-size:0.72rem;padding:4px 8px;" onclick="adminKickUser('${u.uid}')">Kick</button>
            ` : ''}
        `;
        list.appendChild(row);
    });
    loadDiskUsage();
}

async function loadDiskUsage() {
    try {
        const res = await apiGet('/api/admin/disk-usage');
        const d = await res.json();
        $('disk-total-val').textContent = formatBytes(d.totalSize);
        $('disk-chat-val').textContent = `Chat: ${formatBytes(d.chatSize)}`;
        $('disk-pool-val').textContent = `Pool: ${formatBytes(d.poolSize)}`;
        $('disk-profile-val').textContent = `Profiles: ${formatBytes(d.profileSize)}`;
        $('disk-progress-fill').style.width = '100%';
    } catch (e) {}
}

async function adminKickUser(uid) {
    if (!confirm('Kick this user session?')) return;
    const res = await apiPost(`/api/admin/kick/${uid}`, {});
    if (res.ok) showToast('User kicked', 'info');
}

function openAdminResetPasswordModal(uid, nickname) {
    state.adminResetTargetUid = uid;
    $('reset-target-name').textContent = nickname;
    $('admin-new-pass-input').value = '';
    openModal('modal-admin-reset-pass');
}

async function confirmAdminPasswordReset() {
    const newPassword = $('admin-new-pass-input').value;
    if (!newPassword || newPassword.length < 4) return showToast('Password must be min 4 chars', 'warning');

    const res = await apiPost('/api/admin/reset-password', { uid: state.adminResetTargetUid, newPassword });
    if (res.ok) {
        closeModal('modal-admin-reset-pass');
        showToast('User password reset successfully!', 'success');
    }
}

async function postAnnouncement() {
    const text = $('admin-announcement-input').value.trim();
    if (!text) return;
    const res = await apiPost('/api/admin/announcement', { text });
    if (res.ok) {
        $('admin-announcement-input').value = '';
        showToast('Announcement posted!', 'success');
    }
}

function showAnnouncement(text) {
    $('announcement-text').textContent = text;
    $('announcement-banner').classList.remove('hidden');
}
function closeAnnouncement() {
    $('announcement-banner').classList.add('hidden');
}

// ── Notifications Drawer ──────────────────────────────────────
function toggleNotificationDrawer() {
    const drawer = $('notification-drawer');
    const isOpening = drawer.classList.contains('hidden');
    drawer.classList.toggle('hidden');
    if (isOpening && 'Notification' in window && Notification.permission === 'default') {
        if ($('notif-perm-banner')) $('notif-perm-banner').classList.remove('hidden');
    }
}

function requestNotificationPermissionUser() {
    if (!('Notification' in window)) {
        showToast('Browser notifications not supported on this browser', 'warning');
        return;
    }
    Notification.requestPermission().then(permission => {
        debugLog('User requested notification permission:', permission);
        if (permission === 'granted') {
            showToast('Desktop notifications enabled!', 'success');
            if ($('notif-perm-banner')) $('notif-perm-banner').classList.add('hidden');
        } else {
            if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                showToast('Chrome blocks HTTP IP popups. Use http://localhost:8080 or Chrome flags.', 'warning');
            } else {
                showToast('Notification permission denied by browser settings.', 'error');
            }
        }
    }).catch(() => {
        showToast('Unable to request notification permission.', 'error');
    });
}

function updateNotificationBadge() {
    const badge = $('notif-badge');
    const unreadCount = state.notifications.filter(n => !n.is_read).length;
    badge.textContent = unreadCount;
    badge.classList.toggle('hidden', unreadCount === 0);

    const list = $('notifications-list');
    if (!state.notifications.length) {
        list.innerHTML = `<div class="text-muted text-sm text-center" style="padding:12px;">No notifications</div>`;
        return;
    }
    list.innerHTML = '';
    state.notifications.forEach(n => {
        const item = document.createElement('div');
        item.className = 'notif-item';
        item.innerHTML = `
            <div style="font-weight:600;color:var(--accent-purple);">${escapeHTML(n.title)}</div>
            <div>${escapeHTML(n.body)}</div>
            <div class="text-xs text-muted" style="margin-top:2px;">${formatTime(n.timestamp)}</div>
        `;
        list.appendChild(item);
    });
}

async function clearNotifications() {
    await apiPost('/api/notifications/read', {});
    state.notifications.forEach(n => n.is_read = 1);
    updateNotificationBadge();
}

// ── UI Helpers & Modals ───────────────────────────────────────
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
function closeModalOverlay(event, id) { if (event.target.id === id) closeModal(id); }

function makeAvatarHtml(user, size) {
    const cls = `avatar-${size}`;
    const photo = user?.profilePhoto || user?.profile_photo;
    const letter = (user?.nickname || '?')[0].toUpperCase();
    if (photo) {
        return `<div class="${cls}"><img src="/profile/${photo}" alt=""></div>`;
    }
    return `<div class="${cls}"><span>${letter}</span></div>`;
}

function showToast(msg, type = 'info') {
    const container = $('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHTML(msg)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ── REST API Fetch Wrapper ────────────────────────────────────
function apiGet(path) {
    return fetch(path, { headers: { 'Authorization': `Bearer ${state.token}`, 'X-UID': state.myUid } });
}
function apiPost(path, body) {
    return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}`, 'X-UID': state.myUid },
        body: JSON.stringify(body)
    });
}
function apiPatch(path, body) {
    return fetch(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}`, 'X-UID': state.myUid },
        body: JSON.stringify(body)
    });
}
function apiDelete(path) {
    return fetch(path, { method: 'DELETE', headers: { 'Authorization': `Bearer ${state.token}`, 'X-UID': state.myUid } });
}

function triggerProfilePhotoUpload() {
    $('profile-dropdown').classList.add('hidden');
    $('file-input-profile').click();
}

async function uploadProfilePhotoRaw(file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('photo', file);
    try {
        const res = await fetch('/api/profile/photo', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.token}`, 'X-UID': state.myUid },
            body: formData
        });
        const data = await res.json();
        if (res.ok && data.filename) {
            state.profilePhoto = data.filename;
        }
    } catch (e) {}
}

async function uploadProfilePhoto(file) {
    await uploadProfilePhotoRaw(file);
    updateHeaderUser();
    showToast('Profile photo updated!', 'success');
}

function updateHeaderUser() {
    if ($('header-username')) $('header-username').textContent = state.myNickname;
    if ($('dropdown-name')) $('dropdown-name').textContent = state.myNickname;
    if ($('header-avatar-text')) $('header-avatar-text').textContent = state.myNickname[0]?.toUpperCase() || '?';
    if ($('dropdown-avatar-text')) $('dropdown-avatar-text').textContent = state.myNickname[0]?.toUpperCase() || '?';

    if (state.profilePhoto) {
        const imgHtml = `<img src="/profile/${state.profilePhoto}" alt="Profile">`;
        if ($('header-avatar')) $('header-avatar').innerHTML = imgHtml;
        if ($('dropdown-avatar')) $('dropdown-avatar').innerHTML = imgHtml;
    }
}

function openAdminPanel() {
    updateAdminUsersList();
    openModal('modal-admin');
}

function leaveNetwork() {
    localStorage.clear();
    location.reload();
}

function openProfileMenu() {
    $('profile-dropdown').classList.toggle('hidden');
}

function selectFileTab(btn, tab) {
    document.querySelectorAll('.files-panel .file-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeFileTab = tab;
    renderChatFiles();
}

function renderChatFiles() {
    const container = $('chat-files-container');
    if (!container) return;
    container.innerHTML = '';

    const key = channelKey(state.currentRecipient, state.currentRecipientType);
    const files = (state.chatFiles[key] || []).filter(f => f.category === state.activeFileTab);

    if (!files.length) {
        container.innerHTML = `<div class="files-empty">No ${state.activeFileTab}s shared.</div>`;
        return;
    }

    files.forEach(file => {
        const item = document.createElement('div');
        item.className = 'panel-file-item';
        item.innerHTML = `
            <div style="font-size:0.82rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(file.originalName)}</div>
            <div class="text-xs text-muted" style="display:flex;justify-content:space-between;margin-top:2px;">
                <span>${formatBytes(file.size)}</span>
                <a href="/download/chat/${file.id}" target="_blank">Download</a>
            </div>
        `;
        container.appendChild(item);
    });
}

function filterUsers(mode) {
    state.activeUsersFilter = mode;
    if ($('filter-all')) $('filter-all').classList.toggle('active', mode === 'all');
    if ($('filter-online')) $('filter-online').classList.toggle('active', mode === 'online');
    renderUsersGrid();
}

function renderUsersGrid() {
    const container = $('users-grid');
    if (!container) return;
    container.innerHTML = '';

    const searchQuery = ($('users-search-input')?.value || '').trim().toLowerCase();

    let list = [...state.users];
    if (state.activeUsersFilter === 'online') list = list.filter(u => u.isOnline);

    if (searchQuery) {
        list = list.filter(u => u.nickname.toLowerCase().includes(searchQuery));
    }

    if (!list.length) {
        container.innerHTML = `<div class="files-empty" style="grid-column:1/-1;">${searchQuery ? 'No matching users found.' : 'No users found.'}</div>`;
        return;
    }

    list.forEach(u => {
        const isMe = u.uid === state.myUid;
        const card = document.createElement('div');
        card.className = 'user-card';
        card.innerHTML = `
            <div class="avatar-wrap">
                ${makeAvatarHtml(u, 'lg')}
                <span class="${u.isOnline ? 'online-dot' : 'offline-dot'}"></span>
            </div>
            <div style="font-weight:600;font-size:0.95rem;display:flex;align-items:center;justify-content:center;gap:4px;flex-wrap:wrap;">
                <span>${escapeHTML(u.nickname)}</span>
                ${u.isAdmin ? '<span style="font-size:0.65rem;background:rgba(124,58,237,0.2);color:var(--accent-purple);padding:2px 6px;border-radius:4px;font-weight:600;">ADMIN</span>' : ''}
                ${isMe ? '<span style="font-size:0.65rem;background:rgba(6,182,212,0.2);color:var(--accent-cyan);padding:2px 6px;border-radius:4px;font-weight:600;">YOU</span>' : ''}
            </div>
            <div class="text-xs text-muted">${u.isOnline ? '🟢 Online' : '⚪ Offline'}</div>
            ${!isMe ? `
            <button class="btn btn-primary" style="font-size:0.75rem;padding:6px 12px;width:100%;" onclick="selectChannel('${u.uid}','user','💬 ${escapeAttr(u.nickname)}');showView('chat');">
                Message
            </button>
            ` : `
            <button class="btn btn-outline" style="font-size:0.75rem;padding:6px 12px;width:100%;" disabled>
                Your Profile
            </button>
            `}
        `;
        container.appendChild(card);
    });
}

function openCreateGroupModal() {
    if ($('group-name-input')) $('group-name-input').value = '';
    state.selectedGroupMembers.clear();
    renderSelectedGroupMembers();
    filterMemberSearch();
    openModal('modal-create-group');
}

function filterMemberSearch() {
    const q = ($('member-search')?.value || '').toLowerCase();
    const container = $('member-list');
    if (!container) return;
    container.innerHTML = '';

    const peers = state.users.filter(u => u.uid !== state.myUid);
    peers.filter(u => u.nickname.toLowerCase().includes(q)).forEach(u => {
        const isSelected = state.selectedGroupMembers.has(u.uid);
        const div = document.createElement('div');
        div.className = `member-option ${isSelected ? 'selected' : ''}`;
        div.onclick = () => toggleGroupMemberSelection(u.uid);
        div.innerHTML = `
            ${makeAvatarHtml(u, 'sm')}
            <span style="flex:1;font-size:0.85rem;">${escapeHTML(u.nickname)} ${u.isAdmin ? '(Admin)' : ''}</span>
            <span>${isSelected ? '✓' : '＋'}</span>
        `;
        container.appendChild(div);
    });
}

function toggleGroupMemberSelection(uid) {
    if (state.selectedGroupMembers.has(uid)) state.selectedGroupMembers.delete(uid);
    else state.selectedGroupMembers.add(uid);
    filterMemberSearch();
    renderSelectedGroupMembers();
}

function renderSelectedGroupMembers() {
    const container = $('selected-members');
    if (!container) return;
    container.innerHTML = '';

    state.selectedGroupMembers.forEach(uid => {
        const u = state.users.find(x => x.uid === uid);
        if (u) {
            const pill = document.createElement('span');
            pill.className = 'reaction-pill active';
            pill.innerHTML = `${escapeHTML(u.nickname)} <button style="border:none;background:none;color:#fff;cursor:pointer;" onclick="toggleGroupMemberSelection('${uid}')">✕</button>`;
            container.appendChild(pill);
        }
    });
}

async function createGroup() {
    const name = $('group-name-input').value.trim();
    if (!name) return showToast('Group name required', 'warning');

    const memberUids = Array.from(state.selectedGroupMembers);
    const res = await apiPost('/api/group', { name, memberUids });
    if (res.ok) {
        closeModal('modal-create-group');
        showToast(`Group "${name}" created!`, 'success');
    }
}

async function openComments(fileId, fileType) {
    state.activeCommentFileId = fileId;
    state.activeCommentFileType = fileType;
    if ($('comment-input')) $('comment-input').value = '';
    $('comments-list').innerHTML = `<div class="text-muted text-center">Loading comments...</div>`;
    openModal('modal-comments');

    const res = await apiGet(`/api/file/${fileType}/${fileId}/comments`);
    const comments = await res.json();
    renderCommentsList(comments);
}

function renderCommentsList(comments) {
    const list = $('comments-list');
    if (!comments.length) {
        list.innerHTML = `<div class="text-muted text-sm text-center">No comments yet. Be the first to comment!</div>`;
        return;
    }
    list.innerHTML = '';
    comments.forEach(c => {
        const div = document.createElement('div');
        div.className = 'notif-item';
        div.innerHTML = `
            <div style="font-weight:600;font-size:0.8rem;color:var(--accent-cyan);">${escapeHTML(c.authorName)}</div>
            <div style="font-size:0.85rem;margin:2px 0;">${escapeHTML(c.text)}</div>
            <div class="text-xs text-muted">${formatTime(c.timestamp)}</div>
        `;
        list.appendChild(div);
    });
}

async function submitComment() {
    const text = $('comment-input').value.trim();
    if (!text || !state.activeCommentFileId) return;

    const res = await apiPost(`/api/file/${state.activeCommentFileType}/${state.activeCommentFileId}/comment`, { text });
    if (res.ok) {
        $('comment-input').value = '';
        openComments(state.activeCommentFileId, state.activeCommentFileType);
    }
}

function downloadChatFile(id, filename) {
    triggerDirectDownload(`/download/chat/${id}`, filename);
}

function downloadPoolFile(id, filename, hasPassword) {
    if (hasPassword) {
        state.pendingDlFileId = id;
        state.pendingDlFilename = filename;
        $('dl-password-input').value = '';
        $('dl-password-error').classList.add('hidden');
        openModal('modal-password');
    } else {
        triggerDirectDownload(`/download/pool/${id}`, filename);
    }
}

async function confirmPasswordDownload() {
    const password = $('dl-password-input').value;
    if (!password) return;

    const res = await apiPost(`/download/pool/${state.pendingDlFileId}`, { password });
    if (res.ok) {
        closeModal('modal-password');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = state.pendingDlFilename || 'file';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
        $('dl-password-error').classList.remove('hidden');
    }
}

function triggerDirectDownload(url, filename) {
    fetch(url, {
        headers: { 'Authorization': `Bearer ${state.token}`, 'X-UID': state.myUid }
    }).then(res => {
        if (!res.ok) throw new Error('Download failed');
        return res.blob();
    }).then(blob => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u;
        a.download = filename || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
    }).catch(err => {
        showToast('Download failed', 'error');
    });
}

async function deleteChatFile(id) {
    if (!confirm('Delete this file?')) return;
    const res = await apiDelete(`/api/file/chat/${id}`);
    if (res.ok) {
        const el = document.querySelector(`[data-file-id="${id}"]`);
        if (el) el.remove();
        showToast('File deleted', 'info');
    }
}

async function deletePoolFile(id) {
    if (!confirm('Delete this pool file?')) return;
    const res = await apiDelete(`/api/file/pool/${id}`);
    if (res.ok) {
        loadPoolFiles();
        showToast('File deleted', 'info');
    }
}

async function startEditMessage(id) {
    const el = document.querySelector(`[data-msg-id="${id}"] .msg-text-content`);
    if (!el) return;
    const oldText = el.textContent;
    const newText = prompt('Edit message:', oldText);
    if (newText !== null && newText.trim() && newText.trim() !== oldText) {
        const res = await apiPatch(`/api/message/${id}`, { text: newText.trim() });
        if (res.ok) showToast('Message updated', 'success');
    }
}

async function deleteMessage(id) {
    if (!confirm('Delete this message?')) return;
    const res = await apiDelete(`/api/message/${id}`);
    if (res.ok) showToast('Message deleted', 'info');
}



// ── @Mention Autocomplete Dropdown ────────────────────────────
let selectedMentionIndex = 0;

function handleMsgInputMention(e) {
    const input = $('msg-input');
    if (!input) return;
    const val = input.value;
    const cursorPos = input.selectionStart;

    const textBeforeCursor = val.substring(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@([a-zA-Z0-9_-]*)$/);

    if (!mentionMatch) {
        hideMentionAutocomplete();
        return;
    }

    const query = mentionMatch[1].toLowerCase();
    const matches = state.users.filter(u => u.uid !== state.myUid && u.nickname.toLowerCase().startsWith(query));

    if (!matches.length) {
        hideMentionAutocomplete();
        return;
    }

    selectedMentionIndex = 0;
    renderMentionAutocomplete(matches, mentionMatch[0]);
}

function renderMentionAutocomplete(matches, fullMatch) {
    const container = $('mention-autocomplete');
    if (!container) return;
    container.innerHTML = '';
    container.classList.remove('hidden');

    matches.forEach((user, idx) => {
        const item = document.createElement('div');
        item.className = `mention-item ${idx === selectedMentionIndex ? 'active' : ''}`;
        item.onmousedown = (e) => {
            e.preventDefault();
            insertMention(user.nickname, fullMatch);
        };
        item.innerHTML = `
            ${makeAvatarHtml(user, 'sm')}
            <span style="font-weight:600;">@${escapeHTML(user.nickname)}</span>
            ${user.isAdmin ? '<span style="font-size:0.65rem;color:var(--accent-purple);margin-left:auto;">Admin</span>' : ''}
        `;
        container.appendChild(item);
    });
}

function insertMention(nickname, fullMatch) {
    const input = $('msg-input');
    if (!input) return;
    const val = input.value;
    const cursorPos = input.selectionStart;
    const textBeforeCursor = val.substring(0, cursorPos);
    const textAfterCursor = val.substring(cursorPos);

    const newBefore = textBeforeCursor.substring(0, textBeforeCursor.length - fullMatch.length) + `@${nickname} `;
    input.value = newBefore + textAfterCursor;
    input.selectionStart = input.selectionEnd = newBefore.length;
    input.focus();
    hideMentionAutocomplete();
}

function hideMentionAutocomplete() {
    const container = $('mention-autocomplete');
    if (container) container.classList.add('hidden');
    selectedMentionIndex = 0;
}

function handleMsgInputKeyDown(e) {
    const container = $('mention-autocomplete');
    const isVisible = container && !container.classList.contains('hidden');

    if (isVisible) {
        const items = container.querySelectorAll('.mention-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedMentionIndex = (selectedMentionIndex + 1) % items.length;
            items.forEach((it, i) => it.classList.toggle('active', i === selectedMentionIndex));
            return;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedMentionIndex = (selectedMentionIndex - 1 + items.length) % items.length;
            items.forEach((it, i) => it.classList.toggle('active', i === selectedMentionIndex));
            return;
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            if (items[selectedMentionIndex]) {
                items[selectedMentionIndex].dispatchEvent(new MouseEvent('mousedown'));
            }
            return;
        } else if (e.key === 'Escape') {
            hideMentionAutocomplete();
            return;
        }
    }

    if (e.key === 'Enter') {
        sendMessage();
    }
}
