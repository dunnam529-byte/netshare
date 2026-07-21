// =============================================================
// Regnis V2 — Server (Express + node:sqlite + WebSocket)
// =============================================================
'use strict';

const { DatabaseSync } = require('node:sqlite');
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

// ── App & HTTP Server ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// ── Debug Logging ─────────────────────────────────────────────
const DEBUG = process.env.DEBUG !== 'false';
function debugLog(prefix, message, extra = null) {
    if (!DEBUG) return;
    const ts = new Date().toLocaleTimeString();
    const formattedPrefix = `\x1b[35m[${prefix}]\x1b[0m`;
    const formattedTime = `\x1b[90m${ts}\x1b[0m`;
    if (extra !== null && extra !== undefined) {
        console.log(`${formattedTime} ${formattedPrefix} ${message}`, extra);
    } else {
        console.log(`${formattedTime} ${formattedPrefix} ${message}`);
    }
}

// ── Upload Directories ────────────────────────────────────────
const uploadsDir    = path.join(__dirname, 'uploads');
const chatDir       = path.join(uploadsDir, 'chat');
const poolDir       = path.join(uploadsDir, 'pool');
const profilesDir   = path.join(uploadsDir, 'profiles');
[uploadsDir, chatDir, poolDir, profilesDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── SQLite Database Setup ─────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'regnis.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Core Tables & Migrations
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    uid           TEXT PRIMARY KEY,
    nickname      TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    profile_photo TEXT,
    is_admin      INTEGER DEFAULT 0,
    is_approved   INTEGER DEFAULT 1,
    created_at    INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS pending_users (
    uid          TEXT PRIMARY KEY,
    nickname     TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    ip           TEXT,
    requested_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    token      TEXT PRIMARY KEY,
    uid        TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups_table (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    uid      TEXT NOT NULL,
    role     TEXT DEFAULT 'member',
    PRIMARY KEY (group_id, uid)
);

CREATE TABLE IF NOT EXISTS messages (
    id             TEXT PRIMARY KEY,
    sender_uid     TEXT NOT NULL,
    sender_name    TEXT NOT NULL,
    text           TEXT NOT NULL,
    recipient      TEXT NOT NULL,
    recipient_type TEXT NOT NULL,
    timestamp      INTEGER NOT NULL,
    edited         INTEGER DEFAULT 0,
    deleted        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL,
    uid        TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    PRIMARY KEY (message_id, uid, emoji)
);

CREATE TABLE IF NOT EXISTS read_receipts (
    channel_key         TEXT NOT NULL,
    uid                 TEXT NOT NULL,
    last_read_timestamp INTEGER NOT NULL,
    PRIMARY KEY (channel_key, uid)
);

CREATE TABLE IF NOT EXISTS chat_files (
    id             TEXT PRIMARY KEY,
    original_name  TEXT NOT NULL,
    saved_name     TEXT NOT NULL,
    sender_uid     TEXT NOT NULL,
    sender_name    TEXT NOT NULL,
    recipient      TEXT NOT NULL,
    recipient_type TEXT NOT NULL,
    category       TEXT NOT NULL,
    timestamp      INTEGER NOT NULL,
    size           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_files (
    id            TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    saved_name    TEXT NOT NULL,
    uploader_uid  TEXT NOT NULL,
    uploader_name TEXT NOT NULL,
    password_hash TEXT,
    category      TEXT NOT NULL,
    timestamp     INTEGER NOT NULL,
    size          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_comments (
    id          TEXT PRIMARY KEY,
    file_id     TEXT NOT NULL,
    file_type   TEXT NOT NULL,
    author_uid  TEXT NOT NULL,
    author_name TEXT NOT NULL,
    text        TEXT NOT NULL,
    timestamp   INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    uid         TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    type        TEXT DEFAULT 'info',
    link_target TEXT,
    timestamp   INTEGER DEFAULT (strftime('%s','now') * 1000),
    is_read     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS announcements (
    id          TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    author_name TEXT NOT NULL,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000),
    active      INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS server_config (
    key   TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO server_config (key, value) VALUES
    ('networkMode',       'public'),
    ('groupChatEnabled',  'true'),
    ('fileSharingEnabled','true'),
    ('blockedIPs',        '');
`);

// ── Auto Schema Migrations ────────────────────────────────────
function addColumnIfNotExists(table, column, typeDef) {
    try {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        const exists = columns.some(col => col.name === column);
        if (!exists) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
        }
    } catch (e) {}
}

addColumnIfNotExists('users', 'password_hash', 'TEXT');
addColumnIfNotExists('pending_users', 'password_hash', 'TEXT');
addColumnIfNotExists('group_members', 'role', "TEXT DEFAULT 'member'");

// Indexes for performance at 100+ scale
db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(recipient, recipient_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_files_channel ON chat_files(recipient, recipient_type);
CREATE INDEX IF NOT EXISTS idx_comments_file ON file_comments(file_id, file_type);
CREATE INDEX IF NOT EXISTS idx_auth_tokens ON auth_tokens(token, expires_at);
CREATE INDEX IF NOT EXISTS idx_notifications_uid ON notifications(uid, is_read);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);
`);

// ── Memory Caches & Rate Limiting ─────────────────────────────
let cachedConfig = null;
function getConfig() {
    if (!cachedConfig) {
        const rows = db.prepare('SELECT key, value FROM server_config').all();
        cachedConfig = {};
        rows.forEach(r => {
            if (r.value === 'true')  cachedConfig[r.key] = true;
            else if (r.value === 'false') cachedConfig[r.key] = false;
            else cachedConfig[r.key] = r.value;
        });
    }
    return cachedConfig;
}

function setConfig(key, value) {
    db.prepare('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)').run(key, String(value));
    cachedConfig = null; // invalidate
}

function isBlocked(ip) {
    const cfg = getConfig();
    if (!cfg.blockedIPs) return false;
    return cfg.blockedIPs.split(',').filter(Boolean).includes(ip);
}

// In-memory rate limiter per IP
const ipRequestCounts = new Map();
function rateLimiter(maxReqsPerMinute = 120) {
    return (req, res, next) => {
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const now = Date.now();
        const record = ipRequestCounts.get(ip) || { count: 0, resetTime: now + 60000 };
        if (now > record.resetTime) {
            record.count = 0;
            record.resetTime = now + 60000;
        }
        record.count++;
        ipRequestCounts.set(ip, record);

        if (record.count > maxReqsPerMinute) {
            return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        }
        next();
    };
}

// ── In-Memory WS State ────────────────────────────────────────
const sessions = new Map();         // wsId → { ws, uid, nickname, ip, isAdmin, isAlive }
const uidToSession = new Map();     // uid → wsId
const pendingWsSessions = new Map();// uid → ws

// ── Helpers & Security Sanitization ───────────────────────────
function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

function getLocalIPs() {
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
        }
    }
    return ips;
}

function getFileCategory(filename) {
    const ext = path.extname(filename).toLowerCase();
    const photos = ['.jpg','.jpeg','.png','.gif','.webp','.bmp','.svg','.avif'];
    const videos = ['.mp4','.webm','.ogg','.mov','.avi','.mkv','.m4v','.wmv'];
    if (photos.includes(ext)) return 'photo';
    if (videos.includes(ext)) return 'video';
    return 'other';
}

const MIME_MAP = {
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
    '.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.avif':'image/avif',
    '.mp4':'video/mp4','.webm':'video/webm','.ogg':'video/ogg',
    '.mov':'video/quicktime','.avi':'video/x-msvideo','.mkv':'video/x-matroska'
};

function getMime(filename) {
    return MIME_MAP[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

// Disallowed executable / script extensions for security
const FORBIDDEN_EXTENSIONS = ['.exe', '.bat', '.cmd', '.sh', '.php', '.pl', '.cgi', '.jar', '.vbs', '.js', '.html', '.htm', '.phtml'];

function validateFileType(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.includes(ext)) {
        return false;
    }
    return true;
}

// ── Multer Storage ────────────────────────────────────────────
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

function makeStorage(destDir) {
    return multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, destDir),
        filename: (_req, file, cb) => {
            const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
            cb(null, `${uuidv4()}_${safe}`);
        }
    });
}

const uploadChat = multer({
    storage: makeStorage(chatDir),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
        if (!validateFileType(file)) return cb(new Error('Disallowed file type for security'));
        cb(null, true);
    }
});

const uploadPool = multer({
    storage: makeStorage(poolDir),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
        if (!validateFileType(file)) return cb(new Error('Disallowed file type for security'));
        cb(null, true);
    }
});

const uploadProfile = multer({
    storage: makeStorage(profilesDir),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ['.jpg','.jpeg','.png','.gif','.webp'];
        cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
    }
});

// ── Token Auth Middleware ──────────────────────────────────────
function createAuthToken(uid) {
    const token = uuidv4();
    const now = Date.now();
    const expiresAt = now + (7 * 24 * 60 * 60 * 1000); // 7 days
    db.prepare('INSERT INTO auth_tokens (token, uid, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, uid, now, expiresAt);
    return token;
}

function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const xUid = req.headers['x-uid'];
    const queryToken = req.query.token;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (queryToken) {
        token = queryToken;
    } else if (xUid) {
        // Fallback compatibility for test suite or direct headers
        const user = db.prepare('SELECT * FROM users WHERE uid = ? AND is_approved = 1').get(xUid);
        if (user) {
            req.user = user;
            return next();
        }
    }

    if (!token) return res.status(401).json({ error: 'Unauthorized: missing authentication token' });

    const tokenRow = db.prepare('SELECT * FROM auth_tokens WHERE token = ? AND expires_at > ?').get(token, Date.now());
    if (!tokenRow) return res.status(401).json({ error: 'Unauthorized: invalid or expired session token' });

    const user = db.prepare('SELECT * FROM users WHERE uid = ? AND is_approved = 1').get(tokenRow.uid);
    if (!user) return res.status(401).json({ error: 'Unauthorized: user not found or pending approval' });

    req.user = user;
    req.token = token;
    next();
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
        next();
    });
}

// ── Express Middleware Setup ──────────────────────────────────
app.use(express.json());
app.use(rateLimiter(180)); // 180 reqs/min rate limit

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-UID');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

app.use((req, res, next) => {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (isBlocked(ip)) return res.status(403).send('Access Denied: Your IP has been blocked.');
    next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// =============================================================
// REST API ROUTES
// =============================================================

// Status
app.get('/api/status', (req, res) => {
    const cfg = getConfig();
    const announcement = db.prepare('SELECT * FROM announcements WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
    res.json({
        status: 'running',
        ips: getLocalIPs(),
        config: cfg,
        announcement: announcement ? announcement.text : null,
        activeUsersCount: sessions.size,
        blockedIPs: cfg.blockedIPs ? cfg.blockedIPs.split(',').filter(Boolean) : []
    });
});

// Register (with Password)
app.post('/api/register', async (req, res) => {
    let { nickname, password } = req.body;
    if (!nickname || !nickname.trim()) return res.status(400).json({ error: 'Nickname is required' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    nickname = sanitizeText(nickname).substring(0, 30);
    const clientIP = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

    if (db.prepare('SELECT uid FROM users WHERE nickname = ?').get(nickname))
        return res.status(409).json({ error: 'This display name is already taken.' });
    if (db.prepare('SELECT uid FROM pending_users WHERE nickname = ?').get(nickname))
        return res.status(409).json({ error: 'This display name is pending approval.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const uid = uuidv4();
    const cfg = getConfig();

    if (cfg.networkMode === 'private') {
        db.prepare('INSERT INTO pending_users (uid, nickname, password_hash, ip) VALUES (?, ?, ?, ?)')
          .run(uid, nickname, passwordHash, clientIP);
        broadcastToAdmins({ type: 'pending_user', uid, nickname });
        return res.json({ status: 'pending', uid, nickname });
    }

    const isLocalhost = ['127.0.0.1', '::1', 'localhost'].includes(clientIP);
    const countUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const isAdmin = (isLocalhost || countUsers === 0) ? 1 : 0;

    db.prepare('INSERT INTO users (uid, nickname, password_hash, is_admin, is_approved) VALUES (?, ?, ?, ?, 1)')
      .run(uid, nickname, passwordHash, isAdmin);

    const token = createAuthToken(uid);
    return res.json({ status: 'joined', token, uid, nickname, isAdmin: !!isAdmin });
});

// Login (Password Verification)
app.post('/api/login', async (req, res) => {
    let { nickname, password } = req.body;
    if (!nickname || !password) return res.status(400).json({ error: 'Nickname and password required' });

    nickname = nickname.trim();
    const user = db.prepare('SELECT * FROM users WHERE nickname = ?').get(nickname);

    if (!user) {
        const pending = db.prepare('SELECT * FROM pending_users WHERE nickname = ?').get(nickname);
        if (pending) return res.status(403).json({ error: 'Your account is pending administrator approval.' });
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.is_approved) return res.status(403).json({ error: 'Your account is pending approval or disabled.' });

    // Handle legacy migration if password_hash was null
    if (!user.password_hash) {
        const hash = await bcrypt.hash(password, 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE uid = ?').run(hash, user.uid);
    } else {
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = createAuthToken(user.uid);
    return res.json({
        success: true,
        token,
        uid: user.uid,
        nickname: user.nickname,
        isAdmin: !!user.is_admin,
        profilePhoto: user.profile_photo
    });
});

// Self Profile
app.get('/api/me', requireAuth, (req, res) => {
    res.json({
        uid: req.user.uid,
        nickname: req.user.nickname,
        isAdmin: !!req.user.is_admin,
        profilePhoto: req.user.profile_photo
    });
});

// User List
app.get('/api/all-users', requireAuth, (req, res) => {
    const users = db.prepare('SELECT uid, nickname, profile_photo, is_admin, created_at FROM users WHERE is_approved = 1 ORDER BY nickname').all();
    res.json(users.map(u => ({
        uid: u.uid,
        nickname: u.nickname,
        profilePhoto: u.profile_photo,
        isAdmin: !!u.is_admin,
        isOnline: uidToSession.has(u.uid),
        createdAt: u.created_at
    })));
});

// Groups List & Management
app.get('/api/groups', requireAuth, (req, res) => {
    const myUid = req.user.uid;
    const groups = db.prepare(`
        SELECT g.*, GROUP_CONCAT(gm2.uid) as member_uids
        FROM groups_table g
        JOIN group_members gm ON g.id = gm.group_id AND gm.uid = ?
        LEFT JOIN group_members gm2 ON g.id = gm2.group_id
        GROUP BY g.id
    `).all(myUid);

    res.json(groups.map(g => ({
        id: g.id,
        name: g.name,
        createdBy: g.created_by,
        createdAt: g.created_at,
        members: g.member_uids ? g.member_uids.split(',').filter(Boolean) : []
    })));
});

app.post('/api/group', requireAuth, (req, res) => {
    let { name, memberUids } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });

    name = sanitizeText(name).substring(0, 50);
    const groupId = uuidv4();
    const members = [...new Set([req.user.uid, ...(Array.isArray(memberUids) ? memberUids : [])])];

    db.prepare('INSERT INTO groups_table (id, name, created_by) VALUES (?, ?, ?)').run(groupId, name, req.user.uid);
    const insertMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, uid, role) VALUES (?, ?, ?)');
    members.forEach(uid => insertMember.run(groupId, uid, uid === req.user.uid ? 'admin' : 'member'));

    const group = { id: groupId, name, createdBy: req.user.uid, members };
    members.forEach(uid => sendToUser(uid, { type: 'group_created', group }));

    res.json({ success: true, group });
});

// Group Admin Operations (Rename, Add/Remove member, Leave, Delete)
app.patch('/api/group/:id', requireAuth, (req, res) => {
    const groupId = req.params.id;
    let { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

    const member = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND uid = ?').get(groupId, req.user.uid);
    if (!member) return res.status(403).json({ error: 'Not a member of this group' });

    name = sanitizeText(name).substring(0, 50);
    db.prepare('UPDATE groups_table SET name = ? WHERE id = ?').run(name, groupId);

    const members = db.prepare('SELECT uid FROM group_members WHERE group_id = ?').all(groupId);
    members.forEach(m => sendToUser(m.uid, { type: 'group_updated', groupId, name }));

    res.json({ success: true });
});

app.post('/api/group/:id/members', requireAuth, (req, res) => {
    const groupId = req.params.id;
    const { uids } = req.body;
    if (!Array.isArray(uids) || !uids.length) return res.status(400).json({ error: 'uids array required' });

    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND uid = ?').get(groupId, req.user.uid);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const insertMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, uid, role) VALUES (?, ?, ?)');
    uids.forEach(uid => insertMember.run(groupId, uid, 'member'));

    const allMembers = db.prepare('SELECT uid FROM group_members WHERE group_id = ?').all(groupId).map(m => m.uid);
    const group = db.prepare('SELECT * FROM groups_table WHERE id = ?').get(groupId);

    allMembers.forEach(uid => sendToUser(uid, {
        type: 'group_updated',
        group: { id: group.id, name: group.name, createdBy: group.created_by, members: allMembers }
    }));

    res.json({ success: true });
});

app.delete('/api/group/:id/members/:targetUid', requireAuth, (req, res) => {
    const { id: groupId, targetUid } = req.params;
    const group = db.prepare('SELECT created_by FROM groups_table WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    if (group.created_by !== req.user.uid && req.user.uid !== targetUid && !req.user.is_admin) {
        return res.status(403).json({ error: 'Only group creator can kick members' });
    }

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND uid = ?').run(groupId, targetUid);
    sendToUser(targetUid, { type: 'group_removed', groupId });

    const allMembers = db.prepare('SELECT uid FROM group_members WHERE group_id = ?').all(groupId).map(m => m.uid);
    allMembers.forEach(uid => sendToUser(uid, { type: 'group_members_updated', groupId, members: allMembers }));

    res.json({ success: true });
});

app.delete('/api/group/:id', requireAuth, (req, res) => {
    const groupId = req.params.id;
    const group = db.prepare('SELECT created_by FROM groups_table WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.created_by !== req.user.uid && !req.user.is_admin) {
        return res.status(403).json({ error: 'Only creator can delete group' });
    }

    const members = db.prepare('SELECT uid FROM group_members WHERE group_id = ?').all(groupId).map(m => m.uid);
    db.prepare('DELETE FROM groups_table WHERE id = ?').run(groupId);
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);

    members.forEach(uid => sendToUser(uid, { type: 'group_deleted', groupId }));
    res.json({ success: true });
});

// Chat History with Read Receipts & Reactions
app.get('/api/history', requireAuth, (req, res) => {
    const { recipient, recipientType } = req.query;
    if (!recipient || !recipientType) return res.status(400).json({ error: 'recipient and recipientType required' });

    if (recipientType === 'group') {
        const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND uid = ?').get(recipient, req.user.uid);
        if (!member && !req.user.is_admin) return res.status(403).json({ error: 'Not a member of this group' });
    }

    const channelKey = `${recipientType}:${recipient}`;
    db.prepare('INSERT OR REPLACE INTO read_receipts (channel_key, uid, last_read_timestamp) VALUES (?, ?, ?)')
      .run(channelKey, req.user.uid, Date.now());

    let msgs = [];
    let files = [];

    if (recipientType === 'user') {
        msgs = db.prepare(`
            SELECT * FROM messages
            WHERE recipient_type = 'user'
              AND ((sender_uid = ? AND recipient = ?) OR (sender_uid = ? AND recipient = ?))
            ORDER BY timestamp ASC LIMIT 300
        `).all(req.user.uid, recipient, recipient, req.user.uid);

        files = db.prepare(`
            SELECT cf.*, (SELECT COUNT(*) FROM file_comments fc WHERE fc.file_id = cf.id AND fc.file_type = 'chat') AS comment_count
            FROM chat_files cf
            WHERE cf.recipient_type = 'user'
              AND ((cf.sender_uid = ? AND cf.recipient = ?) OR (cf.sender_uid = ? AND cf.recipient = ?))
            ORDER BY cf.timestamp ASC
        `).all(req.user.uid, recipient, recipient, req.user.uid);
    } else {
        msgs = db.prepare('SELECT * FROM messages WHERE recipient = ? AND recipient_type = ? ORDER BY timestamp ASC LIMIT 300').all(recipient, recipientType);

        files = db.prepare(`
            SELECT cf.*, (SELECT COUNT(*) FROM file_comments fc WHERE fc.file_id = cf.id AND fc.file_type = 'chat') AS comment_count
            FROM chat_files cf WHERE cf.recipient = ? AND cf.recipient_type = ? ORDER BY cf.timestamp ASC
        `).all(recipient, recipientType);
    }

    // Fetch reactions for these messages
    const msgIds = msgs.map(m => m.id);
    const reactionsMap = {};
    if (msgIds.length > 0) {
        const placeholders = msgIds.map(() => '?').join(',');
        const reactionRows = db.prepare(`SELECT message_id, uid, emoji FROM message_reactions WHERE message_id IN (${placeholders})`).all(...msgIds);
        reactionRows.forEach(r => {
            if (!reactionsMap[r.message_id]) reactionsMap[r.message_id] = [];
            reactionsMap[r.message_id].push({ uid: r.uid, emoji: r.emoji });
        });
    }

    const formattedMsgs = msgs.map(m => ({
        id: m.id,
        senderUid: m.sender_uid,
        senderName: m.sender_name,
        text: m.text,
        recipient: m.recipient,
        recipientType: m.recipient_type,
        timestamp: m.timestamp,
        edited: !!m.edited,
        deleted: !!m.deleted,
        reactions: reactionsMap[m.id] || []
    }));

    const formattedFiles = files.map(f => ({
        id: f.id,
        originalName: f.original_name,
        savedName: f.saved_name,
        senderUid: f.sender_uid,
        senderName: f.sender_name,
        recipient: f.recipient,
        recipientType: f.recipient_type,
        category: f.category,
        timestamp: f.timestamp,
        size: f.size,
        commentCount: f.comment_count,
        comment_count: f.comment_count
    }));

    // Fetch last read receipts for DM read receipts
    let readReceipts = [];
    if (recipientType === 'user') {
        const otherUid = recipient;
        const otherReceipt = db.prepare('SELECT last_read_timestamp FROM read_receipts WHERE channel_key = ? AND uid = ?')
                               .get(`user:${req.user.uid}`, otherUid);
        if (otherReceipt) readReceipts.push({ uid: otherUid, timestamp: otherReceipt.last_read_timestamp });

        // Notify other user in real-time that current user has read their messages
        sendToUser(otherUid, {
            type: 'read_receipt',
            readerUid: req.user.uid,
            channelKey: `user:${req.user.uid}`,
            timestamp: Date.now()
        });
    }

    res.json({ messages: formattedMsgs, files: formattedFiles, readReceipts });
});

// Search Messages
app.get('/api/search', requireAuth, (req, res) => {
    const { q } = req.query;
    if (!q || !q.trim()) return res.json({ messages: [], files: [] });

    const query = `%${q.trim()}%`;
    const msgs = db.prepare(`
        SELECT * FROM messages
        WHERE text LIKE ? AND deleted = 0
        ORDER BY timestamp DESC LIMIT 50
    `).all(query);

    const files = db.prepare(`
        SELECT * FROM chat_files
        WHERE original_name LIKE ?
        ORDER BY timestamp DESC LIMIT 50
    `).all(query);

    res.json({ messages: msgs, files });
});

// Message Reactions
app.post('/api/message/:id/react', requireAuth, (req, res) => {
    const msgId = req.params.id;
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji required' });

    const msg = db.prepare('SELECT recipient, recipient_type FROM messages WHERE id = ?').get(msgId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const existing = db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND uid = ? AND emoji = ?')
                       .get(msgId, req.user.uid, emoji);

    if (existing) {
        db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND uid = ? AND emoji = ?').run(msgId, req.user.uid, emoji);
    } else {
        db.prepare('INSERT INTO message_reactions (message_id, uid, emoji) VALUES (?, ?, ?)').run(msgId, req.user.uid, emoji);
    }

    const allReactions = db.prepare('SELECT uid, emoji FROM message_reactions WHERE message_id = ?').all(msgId);

    broadcastToChannel(msg.recipient, msg.recipient_type, req.user.uid, {
        type: 'reaction_updated', messageId: msgId, reactions: allReactions
    });

    res.json({ success: true, reactions: allReactions });
});

// File Sharing & File Pool Routes (with File Rename support)
app.post('/upload/chat', requireAuth, uploadChat.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const cfg = getConfig();
    if (!cfg.fileSharingEnabled) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'File sharing is disabled' });
    }

    let { recipient, recipientType, customName } = req.body;
    if (!recipient || !recipientType) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'recipient and recipientType required' });
    }

    const originalName = (customName && customName.trim()) ? sanitizeText(customName.trim()) : req.file.originalname;
    const fileId   = uuidv4();
    const category = getFileCategory(originalName);
    const ts       = Date.now();

    db.prepare(`
        INSERT INTO chat_files (id, original_name, saved_name, sender_uid, sender_name, recipient, recipient_type, category, timestamp, size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, originalName, req.file.filename, req.user.uid, req.user.nickname, recipient, recipientType, category, ts, req.file.size);

    const fileInfo = {
        id: fileId, originalName, savedName: req.file.filename,
        senderUid: req.user.uid, senderName: req.user.nickname,
        recipient, recipientType, category, timestamp: ts, size: req.file.size, commentCount: 0
    };

    broadcastToChannel(recipient, recipientType, req.user.uid, {
        type: 'file_shared', fileType: 'chat', file: fileInfo
    });

    res.json({ success: true, file: fileInfo });
});

app.post('/upload/pool', requireAuth, uploadPool.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const cfg = getConfig();
    if (!cfg.fileSharingEnabled) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'File sharing is disabled' });
    }

    let { password, customName } = req.body;
    let passwordHash = null;
    if (password && password.trim()) {
        passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    const originalName = (customName && customName.trim()) ? sanitizeText(customName.trim()) : req.file.originalname;
    const fileId   = uuidv4();
    const category = getFileCategory(originalName);
    const ts       = Date.now();

    db.prepare(`
        INSERT INTO pool_files (id, original_name, saved_name, uploader_uid, uploader_name, password_hash, category, timestamp, size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, originalName, req.file.filename, req.user.uid, req.user.nickname, passwordHash, category, ts, req.file.size);

    broadcast({ type: 'pool_updated' });
    res.json({ success: true, id: fileId });
});

// Optimized File Pool List (Sort / Filter / Search)
app.get('/api/pool', requireAuth, (req, res) => {
    const { sort, search, category } = req.query;
    let sql = `
        SELECT pf.*, (SELECT COUNT(*) FROM file_comments fc WHERE fc.file_id = pf.id AND fc.file_type = 'pool') AS comment_count
        FROM pool_files pf
        WHERE 1=1
    `;
    const params = [];

    if (category && category !== 'all') {
        sql += ' AND category = ?';
        params.push(category);
    }
    if (search && search.trim()) {
        sql += ' AND original_name LIKE ?';
        params.push(`%${search.trim()}%`);
    }

    if (sort === 'name') sql += ' ORDER BY original_name ASC';
    else if (sort === 'size') sql += ' ORDER BY size DESC';
    else sql += ' ORDER BY timestamp DESC'; // default

    const files = db.prepare(sql).all(...params);
    res.json(files.map(f => ({
        id: f.id,
        originalName: f.original_name,
        uploaderName: f.uploader_name,
        uploaderUid: f.uploader_uid,
        category: f.category,
        timestamp: f.timestamp,
        size: f.size,
        hasPassword: !!f.password_hash,
        commentCount: f.comment_count
    })));
});

// Download & Previews
app.get('/download/chat/:id', requireAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM chat_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = path.join(chatDir, file.saved_name);
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'File no longer exists on host' });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
});

app.get('/preview/chat/:id', (req, res) => {
    const file = db.prepare('SELECT * FROM chat_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(chatDir, file.saved_name);
    if (!fs.existsSync(filePath)) return res.status(410).end();
    res.sendFile(filePath);
});

app.get('/download/pool/:id', requireAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM pool_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.password_hash) {
        return res.status(403).json({ error: 'Password required' });
    }
    const filePath = path.join(poolDir, file.saved_name);
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'File no longer exists on host' });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
});

app.post('/download/pool/:id', requireAuth, async (req, res) => {
    const file = db.prepare('SELECT * FROM pool_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (file.password_hash) {
        const { password } = req.body;
        if (!password) return res.status(403).json({ error: 'Password required', requiresPassword: true });
        const valid = await bcrypt.compare(password, file.password_hash);
        if (!valid) return res.status(403).json({ error: 'Invalid password' });
    }

    const filePath = path.join(poolDir, file.saved_name);
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'File no longer exists on host' });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
});

app.get('/preview/pool/:id', (req, res) => {
    const token = (req.headers['authorization'] || '').substring(7) || req.query.token;
    const xUid = req.headers['x-uid'];
    let user = null;
    if (token) {
        const tokenRow = db.prepare('SELECT uid FROM auth_tokens WHERE token = ? AND expires_at > ?').get(token, Date.now());
        if (tokenRow) user = db.prepare('SELECT * FROM users WHERE uid = ? AND is_approved = 1').get(tokenRow.uid);
    }
    if (!user && xUid) {
        user = db.prepare('SELECT * FROM users WHERE uid = ? AND is_approved = 1').get(xUid);
    }

    const file = db.prepare('SELECT * FROM pool_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.password_hash && !user) {
        return res.status(403).json({ error: 'Password required' });
    }

    const filePath = path.join(poolDir, file.saved_name);
    if (!fs.existsSync(filePath)) return res.status(410).end();
    res.sendFile(filePath);
});

// Delete Files
app.delete('/api/file/chat/:id', requireAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM chat_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.sender_uid !== req.user.uid && !req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });

    const filePath = path.join(chatDir, file.saved_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    db.prepare('DELETE FROM chat_files WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM file_comments WHERE file_id = ? AND file_type = ?').run(req.params.id, 'chat');

    broadcastToChannel(file.recipient, file.recipient_type, req.user.uid, {
        type: 'file_deleted', fileId: req.params.id, fileType: 'chat'
    });
    res.json({ success: true });
});

app.delete('/api/file/pool/:id', requireAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM pool_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.uploader_uid !== req.user.uid && !req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });

    const filePath = path.join(poolDir, file.saved_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    db.prepare('DELETE FROM pool_files WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM file_comments WHERE file_id = ? AND file_type = ?').run(req.params.id, 'pool');

    broadcast({ type: 'pool_updated' });
    res.json({ success: true });
});

// Edit & Delete Message
app.patch('/api/message/:id', requireAuth, (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });

    const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0').get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.sender_uid !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });

    const newText = sanitizeText(text).substring(0, 1000);
    db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(newText, req.params.id);

    broadcastToChannel(msg.recipient, msg.recipient_type, req.user.uid, {
        type: 'chat_edited', messageId: req.params.id, newText
    });
    res.json({ success: true });
});

app.delete('/api/message/:id', requireAuth, (req, res) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.sender_uid !== req.user.uid && !req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });

    db.prepare('UPDATE messages SET deleted = 1, text = ? WHERE id = ?').run('[Message deleted]', req.params.id);

    broadcastToChannel(msg.recipient, msg.recipient_type, req.user.uid, {
        type: 'chat_deleted', messageId: req.params.id
    });
    res.json({ success: true });
});

// Comments
app.get('/api/file/:type/:id/comments', requireAuth, (req, res) => {
    const { type, id } = req.params;
    if (!['chat','pool'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const comments = db.prepare('SELECT * FROM file_comments WHERE file_id = ? AND file_type = ? ORDER BY timestamp ASC').all(id, type);
    res.json(comments.map(c => ({ id: c.id, authorName: c.author_name, text: c.text, timestamp: c.timestamp })));
});

app.post('/api/file/:type/:id/comment', requireAuth, (req, res) => {
    const { type, id } = req.params;
    let { text } = req.body;
    if (!['chat','pool'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    if (!text || !text.trim()) return res.status(400).json({ error: 'Comment required' });

    const table = type === 'chat' ? 'chat_files' : 'pool_files';
    const file = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    text = sanitizeText(text).substring(0, 500);
    const commentId = uuidv4();
    const ts = Date.now();
    db.prepare('INSERT INTO file_comments (id, file_id, file_type, author_uid, author_name, text, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(commentId, id, type, req.user.uid, req.user.nickname, text, ts);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM file_comments WHERE file_id = ? AND file_type = ?').get(id, type).cnt;
    broadcast({ type: 'comment_added', fileId: id, fileType: type, commentCount: count });
    res.json({ success: true, commentId, timestamp: ts });
});

// Notifications
app.get('/api/notifications', requireAuth, (req, res) => {
    const notifs = db.prepare('SELECT * FROM notifications WHERE uid = ? ORDER BY timestamp DESC LIMIT 50').all(req.user.uid);
    res.json(notifs);
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE uid = ?').run(req.user.uid);
    res.json({ success: true });
});

// Profile Photo Upload
app.post('/api/profile/photo', requireAuth, uploadProfile.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No photo provided' });

    const user = db.prepare('SELECT profile_photo FROM users WHERE uid = ?').get(req.user.uid);
    if (user && user.profile_photo) {
        const old = path.join(profilesDir, user.profile_photo);
        if (fs.existsSync(old)) { try { fs.unlinkSync(old); } catch(e) {} }
    }

    db.prepare('UPDATE users SET profile_photo = ? WHERE uid = ?').run(req.file.filename, req.user.uid);
    debouncedBroadcastUserList();
    res.json({ success: true, filename: req.file.filename });
});

// Profile Photo Download
app.get('/profile/:filename', (req, res) => {
    const safe = path.basename(req.params.filename);
    const filePath = path.join(profilesDir, safe);
    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', getMime(safe));
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.status(404).end();
    }
});

// Admin Panel Routes
app.get('/api/pending', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT * FROM pending_users ORDER BY requested_at DESC').all());
});

app.post('/api/admin/approve/:uid', requireAdmin, (req, res) => {
    const pending = db.prepare('SELECT * FROM pending_users WHERE uid = ?').get(req.params.uid);
    if (!pending) return res.status(404).json({ error: 'Pending user not found' });

    db.prepare('INSERT INTO users (uid, nickname, password_hash, is_admin, is_approved) VALUES (?, ?, ?, 0, 1)')
      .run(pending.uid, pending.nickname, pending.password_hash);
    db.prepare('DELETE FROM pending_users WHERE uid = ?').run(pending.uid);

    const ws = pendingWsSessions.get(pending.uid);
    if (ws && ws.readyState === WebSocket.OPEN) {
        const token = createAuthToken(pending.uid);
        ws.send(JSON.stringify({ type: 'access_approved', token, uid: pending.uid, nickname: pending.nickname }));
    }
    pendingWsSessions.delete(pending.uid);

    broadcastToAdmins({ type: 'pending_users_update' });
    debouncedBroadcastUserList();
    res.json({ success: true });
});

app.post('/api/admin/reject/:uid', requireAdmin, (req, res) => {
    const pending = db.prepare('SELECT * FROM pending_users WHERE uid = ?').get(req.params.uid);
    if (!pending) return res.status(404).json({ error: 'Pending user not found' });

    db.prepare('DELETE FROM pending_users WHERE uid = ?').run(req.params.uid);
    const ws = pendingWsSessions.get(pending.uid);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'access_rejected' }));
        ws.close();
    }
    pendingWsSessions.delete(pending.uid);

    broadcastToAdmins({ type: 'pending_users_update' });
    res.json({ success: true });
});

app.post('/api/admin/kick/:uid', requireAdmin, (req, res) => {
    const targetUid = req.params.uid;
    const wsId = uidToSession.get(targetUid);
    if (wsId) {
        const session = sessions.get(wsId);
        if (session) {
            session.ws.send(JSON.stringify({ type: 'kicked', reason: 'You have been kicked by Administrator' }));
            session.ws.close();
            sessions.delete(wsId);
        }
        uidToSession.delete(targetUid);
    }
    db.prepare('DELETE FROM auth_tokens WHERE uid = ?').run(targetUid);
    debouncedBroadcastUserList();
    res.json({ success: true });
});

app.post('/api/admin/reset-password', requireAdmin, async (req, res) => {
    const { uid, newPassword } = req.body;
    if (!uid || !newPassword) return res.status(400).json({ error: 'uid and newPassword required' });

    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE uid = ?').run(hash, uid);
    db.prepare('DELETE FROM auth_tokens WHERE uid = ?').run(uid); // revoke tokens

    const wsId = uidToSession.get(uid);
    if (wsId) {
        const session = sessions.get(wsId);
        if (session) {
            session.ws.send(JSON.stringify({ type: 'password_reset', reason: 'Your password was reset by Admin. Please log in again.' }));
            session.ws.close();
        }
    }
    res.json({ success: true });
});

app.post('/api/admin/announcement', requireAdmin, (req, res) => {
    let { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Announcement text required' });

    text = sanitizeText(text);
    db.prepare('UPDATE announcements SET active = 0').run();
    const id = uuidv4();
    db.prepare('INSERT INTO announcements (id, text, author_name) VALUES (?, ?, ?)').run(id, text, req.user.nickname);

    broadcast({ type: 'announcement', id, text, authorName: req.user.nickname });
    res.json({ success: true });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
    const { key, value } = req.body;
    const allowed = ['networkMode', 'groupChatEnabled', 'fileSharingEnabled'];
    if (!allowed.includes(key)) return res.status(400).json({ error: 'Invalid config key' });

    setConfig(key, value);
    const cfg = getConfig();
    broadcast({ type: 'config_update', config: cfg });
    res.json({ success: true, config: cfg });
});

app.post('/api/admin/block', requireAdmin, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP required' });

    const cfg = getConfig();
    const current = cfg.blockedIPs ? cfg.blockedIPs.split(',').filter(Boolean) : [];
    if (!current.includes(ip)) current.push(ip);
    setConfig('blockedIPs', current.join(','));

    for (const [wsId, session] of sessions.entries()) {
        if (session.ip === ip) {
            session.ws.send(JSON.stringify({ type: 'blocked' }));
            session.ws.close();
            sessions.delete(wsId);
            uidToSession.delete(session.uid);
        }
    }
    debouncedBroadcastUserList();
    res.json({ success: true });
});

app.get('/api/admin/disk-usage', requireAdmin, (req, res) => {
    function dirSize(d) {
        let size = 0;
        if (!fs.existsSync(d)) return 0;
        const files = fs.readdirSync(d);
        files.forEach(f => {
            const stat = fs.statSync(path.join(d, f));
            if (stat.isFile()) size += stat.size;
        });
        return size;
    }

    const chatSize = dirSize(chatDir);
    const poolSize = dirSize(poolDir);
    const profileSize = dirSize(profilesDir);
    const totalSize = chatSize + poolSize + profileSize;

    res.json({ chatSize, poolSize, profileSize, totalSize });
});

// Legacy admin data endpoint
app.get('/api/admin/data', (req, res) => {
    const clientIP = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const isLocalhost = ['127.0.0.1','::1','localhost'].includes(clientIP);
    if (!isLocalhost) return res.status(403).json({ error: 'Admin from localhost only' });

    const cfg = getConfig();
    res.json({
        clients: Array.from(sessions.values()).map(s => ({
            id: s.uid, nickname: s.nickname, ip: s.ip, isAdmin: s.isAdmin
        })),
        config: cfg,
        blockedIPs: cfg.blockedIPs ? cfg.blockedIPs.split(',').filter(Boolean) : []
    });
});

// SPA Fallback
app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================================
// WEBSOCKET SIGNALING & HEARTBEAT
// =============================================================
server.on('upgrade', (request, socket, head) => {
    const clientIP = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (isBlocked(clientIP)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});

// Heartbeat interval to prune dead sockets (runs every 30s)
const pingInterval = setInterval(() => {
    for (const [wsId, session] of sessions.entries()) {
        if (session.isAlive === false) {
            session.ws.terminate();
            sessions.delete(wsId);
            uidToSession.delete(session.uid);
            debouncedBroadcastUserList();
            continue;
        }
        session.isAlive = false;
        session.ws.ping();
    }
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

wss.on('connection', (ws, request) => {
    const clientIP = (request.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const wsId     = uuidv4();

    ws.isAlive = true;
    ws.on('pong', () => {
        const session = sessions.get(wsId);
        if (session) session.isAlive = true;
    });

    ws.send(JSON.stringify({ type: 'connected', wsId }));

    ws.on('message', async (raw) => {
        if (isBlocked(clientIP)) {
            ws.send(JSON.stringify({ type: 'blocked' }));
            ws.close();
            return;
        }

        let data;
        try { data = JSON.parse(raw); } catch { return; }

        switch (data.type) {

            case 'join': {
                const { token, uid } = data;
                let user = null;

                if (token) {
                    const tokenRow = db.prepare('SELECT uid FROM auth_tokens WHERE token = ? AND expires_at > ?').get(token, Date.now());
                    if (tokenRow) {
                        user = db.prepare('SELECT * FROM users WHERE uid = ? AND is_approved = 1').get(tokenRow.uid);
                    }
                }
                if (!user && uid) {
                    user = db.prepare('SELECT * FROM users WHERE uid = ? AND is_approved = 1').get(uid);
                }

                if (!user) {
                    debugLog('WS', `Join failed for token=${token}, uid=${uid}`);
                    const pending = uid ? db.prepare('SELECT * FROM pending_users WHERE uid = ?').get(uid) : null;
                    if (pending) {
                        pendingWsSessions.set(uid, ws);
                        ws.send(JSON.stringify({ type: 'access_pending' }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Authentication required. Please log in.' }));
                    }
                    break;
                }

                debugLog('WS', `User joined: nickname=${user.nickname}, uid=${user.uid}, isAdmin=${!!user.is_admin}`);

                const session = { ws, uid: user.uid, nickname: user.nickname, ip: clientIP, isAdmin: !!user.is_admin, isAlive: true };
                sessions.set(wsId, session);
                uidToSession.set(user.uid, wsId);

                const activeAnnouncement = db.prepare('SELECT * FROM announcements WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();

                ws.send(JSON.stringify({
                    type: 'welcome',
                    uid: user.uid,
                    nickname: user.nickname,
                    isAdmin: !!user.is_admin,
                    profilePhoto: user.profile_photo,
                    config: getConfig(),
                    announcement: activeAnnouncement ? activeAnnouncement.text : null
                }));

                debouncedBroadcastUserList();
                break;
            }

            case 'chat_message': {
                const session = sessions.get(wsId);
                if (!session) break;
                const cfg = getConfig();
                let { text, recipient, recipientType } = data;
                if (!text || !text.trim()) break;

                if (recipientType === 'global' && !cfg.groupChatEnabled) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Group chat is disabled by admin.' }));
                    break;
                }

                if (recipientType === 'group') {
                    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND uid = ?').get(recipient, session.uid);
                    if (!member && !session.isAdmin) break;
                }

                const msgId   = uuidv4();
                const msgTs   = Date.now();
                const cleanText = sanitizeText(text).substring(0, 1000);

                db.prepare('INSERT INTO messages (id, sender_uid, sender_name, text, recipient, recipient_type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
                  .run(msgId, session.uid, session.nickname, cleanText, recipient, recipientType, msgTs);

                // Handle @mentions
                const mentionMatches = cleanText.match(/@([a-zA-Z0-9_-]+)/g);
                if (mentionMatches) {
                    const mentionedNames = [...new Set(mentionMatches.map(m => m.substring(1)))];
                    mentionedNames.forEach(name => {
                        const targetUser = db.prepare('SELECT uid FROM users WHERE nickname = ?').get(name);
                        if (targetUser && targetUser.uid !== session.uid) {
                            const notifId = uuidv4();
                            const notifTitle = `Mentioned by ${session.nickname}`;
                            const notifBody = cleanText.substring(0, 100);
                            db.prepare('INSERT INTO notifications (id, uid, title, body, type, link_target, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
                              .run(notifId, targetUser.uid, notifTitle, notifBody, 'mention', `${recipientType}:${recipient}:${msgId}`, msgTs);

                            sendToUser(targetUser.uid, {
                                type: 'notification',
                                notification: { id: notifId, title: notifTitle, body: notifBody, type: 'mention', timestamp: msgTs }
                            });
                        }
                    });
                }

                broadcastToChannel(recipient, recipientType, session.uid, {
                    type: 'chat',
                    message: {
                        id: msgId,
                        senderUid: session.uid,
                        senderName: session.nickname,
                        text: cleanText,
                        recipient, recipientType,
                        timestamp: msgTs,
                        edited: false, deleted: false,
                        reactions: []
                    }
                });
                break;
            }

            case 'typing': {
                const session = sessions.get(wsId);
                if (!session) break;
                const { recipient, recipientType } = data;
                broadcastToChannel(recipient, recipientType, session.uid, {
                    type: 'user_typing',
                    uid: session.uid,
                    nickname: session.nickname,
                    recipient, recipientType
                }, false); // don't send back to self
                break;
            }

            case 'channel_focus': {
                const session = sessions.get(wsId);
                if (session) {
                    session.currentRecipient = data.recipient;
                    session.currentRecipientType = data.recipientType;
                    debouncedBroadcastUserList();
                }
                break;
            }

            case 'read_receipt': {
                const session = sessions.get(wsId);
                if (!session) break;
                const { recipient, timestamp } = data;
                if (!recipient || !timestamp) break;

                // Update recipient's perspective receipt: B (session.uid) reading B's channel user:A
                db.prepare('INSERT OR REPLACE INTO read_receipts (channel_key, uid, last_read_timestamp) VALUES (?, ?, ?)')
                  .run(`user:${recipient}`, session.uid, timestamp);

                // Notify recipient (A) that B has read up to timestamp
                sendToUser(recipient, {
                    type: 'read_receipt',
                    readerUid: session.uid,
                    channelKey: `user:${session.uid}`,
                    timestamp
                });
                break;
            }
        }
    });

    ws.on('close', () => {
        const session = sessions.get(wsId);
        if (session) {
            sessions.delete(wsId);
            uidToSession.delete(session.uid);
            debouncedBroadcastUserList();
        }
    });
});

// ── Broadcasters ──────────────────────────────────────────────
let userListTimer = null;
function debouncedBroadcastUserList() {
    if (userListTimer) return;
    userListTimer = setTimeout(() => {
        userListTimer = null;
        broadcastUserList();
    }, 150);
}

function broadcast(payload) {
    const raw = JSON.stringify(payload);
    for (const s of sessions.values()) {
        if (s.ws.readyState === WebSocket.OPEN) s.ws.send(raw);
    }
}

function broadcastToAdmins(payload) {
    const raw = JSON.stringify(payload);
    for (const s of sessions.values()) {
        if (s.isAdmin && s.ws.readyState === WebSocket.OPEN) s.ws.send(raw);
    }
}

function sendToUser(uid, payload) {
    const wsId = uidToSession.get(uid);
    if (!wsId) return;
    const session = sessions.get(wsId);
    if (session && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify(payload));
    }
}

function broadcastUserList() {
    const users = db.prepare('SELECT uid, nickname, profile_photo, is_admin FROM users WHERE is_approved = 1').all();
    broadcast({
        type: 'user_list',
        users: users.map(u => {
            const wsId = uidToSession.get(u.uid);
            const sess = wsId ? sessions.get(wsId) : null;
            return {
                uid: u.uid,
                nickname: u.nickname,
                profilePhoto: u.profile_photo,
                isAdmin: !!u.is_admin,
                isOnline: !!sess,
                currentChannel: sess ? (sess.currentRecipient || 'global') : null
            };
        })
    });
}

function broadcastToChannel(recipient, recipientType, senderUid, payload, includeSelf = true) {
    if (recipientType === 'global') {
        for (const s of sessions.values()) {
            if (includeSelf || s.uid !== senderUid) {
                if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(payload));
            }
        }
    } else if (recipientType === 'user') {
        sendToUser(recipient, payload);
        if (includeSelf) sendToUser(senderUid, payload);
        broadcastToAdmins(payload);
    } else if (recipientType === 'group') {
        const members = db.prepare('SELECT uid FROM group_members WHERE group_id = ?').all(recipient);
        members.forEach(m => {
            if (includeSelf || m.uid !== senderUid) sendToUser(m.uid, payload);
        });
    }
}

// ── Global Express Error Handler ──────────────────────────────
app.use((err, _req, res, _next) => {
    debugLog('ERROR', `Express Route Error: ${err.message || err}`);
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File size exceeds maximum allowed limit (500 MB).' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    res.status(err.status || 400).json({ error: err.message || 'An unexpected server error occurred.' });
});

// ── Server Listen ─────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log('\x1b[36m╔══════════════════════════════════════╗\x1b[0m');
        console.log('\x1b[36m║      Regnis V2 — SERVER RUNNING      ║\x1b[0m');
        console.log('\x1b[36m╚══════════════════════════════════════╝\x1b[0m');
        console.log(`\x1b[32m  Local:   http://localhost:${PORT}\x1b[0m`);
        getLocalIPs().forEach(ip => console.log(`\x1b[32m  Network: http://${ip}:${PORT}\x1b[0m`));
        console.log('\x1b[33m  SQLite:  ' + DB_PATH + '\x1b[0m');
    });
}

module.exports = {
    server, app, db,
    sessions, uidToSession, pendingWsSessions,
    broadcast, broadcastUserList, broadcastToChannel, sendToUser,
    getConfig, setConfig, getLocalIPs,
    chatDir, poolDir, profilesDir
};
