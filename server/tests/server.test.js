// ================================================================
// Regnis V2 — Comprehensive Server Tests
// ================================================================
'use strict';

process.env.DB_PATH = ':memory:';

const assert    = require('assert');
const path      = require('path');
const fs        = require('fs');
const supertest = require('supertest');
const { expect } = require('chai');

// Load server (uses in-memory SQLite)
const {
    server, app, db,
    sessions, uidToSession, pendingWsSessions,
    getConfig, setConfig
} = require('../server');

const request = supertest(app);

// ── Helpers ───────────────────────────────────────────────────
function clearDB() {
    db.exec(`
        DELETE FROM messages;
        DELETE FROM users;
        DELETE FROM pending_users;
        DELETE FROM groups_table;
        DELETE FROM group_members;
        DELETE FROM chat_files;
        DELETE FROM pool_files;
        DELETE FROM file_comments;
    `);
    db.prepare("UPDATE server_config SET value = 'public'  WHERE key = 'networkMode'").run();
    db.prepare("UPDATE server_config SET value = 'true'    WHERE key = 'groupChatEnabled'").run();
    db.prepare("UPDATE server_config SET value = 'true'    WHERE key = 'fileSharingEnabled'").run();
    db.prepare("UPDATE server_config SET value = ''        WHERE key = 'blockedIPs'").run();
    sessions.clear();
    uidToSession.clear();
    pendingWsSessions.clear();
}

function seedUser(opts = {}) {
    const uid = opts.uid || require('crypto').randomUUID();
    const nickname = opts.nickname || `User_${uid.slice(0,6)}`;
    db.prepare(`INSERT INTO users (uid, nickname, is_admin, is_approved)
                VALUES (?, ?, ?, 1)`)
      .run(uid, nickname, opts.isAdmin ? 1 : 0);
    return { uid, nickname };
}

function seedFile(table, opts = {}) {
    const id = opts.id || require('crypto').randomUUID();
    if (table === 'chat') {
        db.prepare(`INSERT INTO chat_files (id, original_name, saved_name, sender_uid, sender_name, recipient, recipient_type, category, timestamp, size)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, opts.name || 'test.txt', opts.saved || `${id}_test.txt`,
               opts.senderUid, opts.senderName || 'Tester',
               opts.recipient || 'global', opts.recipientType || 'global',
               opts.category || 'other', Date.now(), opts.size || 100);
    } else {
        db.prepare(`INSERT INTO pool_files (id, original_name, saved_name, uploader_uid, uploader_name, password_hash, category, timestamp, size)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, opts.name || 'pool.txt', opts.saved || `${id}_pool.txt`,
               opts.uploaderUid, opts.uploaderName || 'Uploader',
               opts.passwordHash || null, opts.category || 'other', Date.now(), opts.size || 100);
    }
    return id;
}

function seedMessage(opts = {}) {
    const id = opts.id || require('crypto').randomUUID();
    db.prepare(`INSERT INTO messages (id, sender_uid, sender_name, text, recipient, recipient_type, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, opts.senderUid, opts.senderName || 'Tester', opts.text || 'Hello',
           opts.recipient || 'global', opts.recipientType || 'global', Date.now());
    return id;
}

// ── Test Suite ────────────────────────────────────────────────
describe('Regnis V2 — Server Unit Tests', () => {

    before(done => {
        if (!server.listening) server.listen(0, '127.0.0.1', done);
        else done();
    });

    after(done => {
        if (server.listening) server.close(done);
        else done();
    });

    beforeEach(() => clearDB());

    // ════════════════════════════════════════════════════════════
    // 1. STATUS & CONNECTIVITY
    // ════════════════════════════════════════════════════════════
    describe('Server Status', () => {
        it('1. GET /api/status returns running status', async () => {
            const res = await request.get('/api/status').expect(200);
            expect(res.body.status).to.equal('running');
            expect(res.body).to.have.property('ips').that.is.an('array');
            expect(res.body).to.have.property('config');
            expect(res.body.activeUsersCount).to.be.a('number');
        });

        it('2. GET /api/status returns correct config structure', async () => {
            const res = await request.get('/api/status').expect(200);
            expect(res.body.config).to.have.property('networkMode');
            expect(res.body.config).to.have.property('groupChatEnabled');
            expect(res.body.config).to.have.property('fileSharingEnabled');
        });
    });

    // ════════════════════════════════════════════════════════════
    // 2. REGISTRATION & UNIQUENESS
    // ════════════════════════════════════════════════════════════
    describe('Registration', () => {
        it('3. POST /api/register creates user with unique name and password', async () => {
            const res = await request.post('/api/register')
                .send({ nickname: 'Alice', password: 'password123' }).expect(200);
            expect(res.body.status).to.equal('joined');
            expect(res.body.uid).to.be.a('string').and.have.length.greaterThan(0);
            expect(res.body.token).to.be.a('string').and.have.length.greaterThan(0);
            expect(res.body.nickname).to.equal('Alice');
        });

        it('4. POST /api/register rejects duplicate nickname (409)', async () => {
            seedUser({ nickname: 'Bob' });
            const res = await request.post('/api/register')
                .send({ nickname: 'Bob', password: 'password123' }).expect(409);
            expect(res.body.error).to.include('taken');
        });

        it('5. POST /api/register rejects empty nickname or short password (400)', async () => {
            await request.post('/api/register')
                .send({ nickname: '', password: '123' }).expect(400);
        });

        it('6. POST /api/register returns pending status in private mode', async () => {
            setConfig('networkMode', 'private');
            const res = await request.post('/api/register')
                .send({ nickname: 'Charlie', password: 'password123' }).expect(200);
            expect(res.body.status).to.equal('pending');
            expect(res.body.uid).to.be.a('string');
            const pending = db.prepare('SELECT * FROM pending_users WHERE nickname = ?').get('Charlie');
            expect(pending).to.not.be.null;
            setConfig('networkMode', 'public');
        });

        it('7. POST /api/register rejects duplicate name in pending list (409)', async () => {
            db.prepare('INSERT INTO pending_users (uid, nickname, password_hash, ip) VALUES (?,?,?,?)').run('uid1','Dana','hash','127.0.0.1');
            const res = await request.post('/api/register')
                .send({ nickname: 'Dana', password: 'password123' }).expect(409);
            expect(res.body.error).to.be.a('string');
        });

        it('7b. POST /api/login authenticates user with correct password', async () => {
            await request.post('/api/register').send({ nickname: 'EvePass', password: 'secretpassword' });
            const res = await request.post('/api/login')
                .send({ nickname: 'EvePass', password: 'secretpassword' }).expect(200);
            expect(res.body.success).to.be.true;
            expect(res.body.token).to.be.a('string');
        });
    });

    // ════════════════════════════════════════════════════════════
    // 3. AUTH MIDDLEWARE
    // ════════════════════════════════════════════════════════════
    describe('Auth Middleware', () => {
        it('8. GET /api/all-users without X-UID header returns 401', async () => {
            const res = await request.get('/api/all-users').expect(401);
            expect(res.body.error).to.be.a('string');
        });

        it('9. GET /api/all-users with valid uid returns user list', async () => {
            const { uid } = seedUser({ nickname: 'Eve' });
            const res = await request.get('/api/all-users')
                .set('X-UID', uid).expect(200);
            expect(res.body).to.be.an('array').with.length.greaterThan(0);
            const eve = res.body.find(u => u.nickname === 'Eve');
            expect(eve).to.exist;
            expect(eve).to.have.property('isOnline');
            expect(eve).to.not.have.property('passwordHash'); // sensitive data not returned
        });

        it('10. GET /api/all-users with non-existent uid returns 401', async () => {
            await request.get('/api/all-users')
                .set('X-UID', 'fake-uid-does-not-exist').expect(401);
        });

        it('11. Blocked IP returns 403 on any HTTP request', async () => {
            setConfig('blockedIPs', '127.0.0.1');
            const res = await request.get('/api/status').expect(403);
            expect(res.text).to.include('blocked');
            setConfig('blockedIPs', ''); // cleanup
        });
    });

    // ════════════════════════════════════════════════════════════
    // 4. MESSAGE OPERATIONS
    // ════════════════════════════════════════════════════════════
    describe('Messages', () => {
        it('12. PATCH /api/message/:id edits own message (200)', async () => {
            const { uid } = seedUser({ nickname: 'Frank' });
            const msgId = seedMessage({ senderUid: uid, text: 'Original' });

            const res = await request.patch(`/api/message/${msgId}`)
                .set('X-UID', uid)
                .send({ text: 'Edited!' })
                .expect(200);
            expect(res.body.success).to.be.true;

            const row = db.prepare('SELECT text, edited FROM messages WHERE id = ?').get(msgId);
            expect(row.text).to.equal('Edited!');
            expect(row.edited).to.equal(1);
        });

        it('13. PATCH /api/message/:id cannot edit another user\'s message (403)', async () => {
            const author  = seedUser({ nickname: 'Grace' });
            const other   = seedUser({ nickname: 'Hank' });
            const msgId   = seedMessage({ senderUid: author.uid, text: 'Original' });

            await request.patch(`/api/message/${msgId}`)
                .set('X-UID', other.uid)
                .send({ text: 'Hacked!' })
                .expect(403);
        });

        it('14. DELETE /api/message/:id soft-deletes own message (200)', async () => {
            const { uid } = seedUser({ nickname: 'Iris' });
            const msgId   = seedMessage({ senderUid: uid });

            const res = await request.delete(`/api/message/${msgId}`)
                .set('X-UID', uid).expect(200);
            expect(res.body.success).to.be.true;

            const row = db.prepare('SELECT deleted, text FROM messages WHERE id = ?').get(msgId);
            expect(row.deleted).to.equal(1);
            expect(row.text).to.equal('[Message deleted]');
        });

        it('15. DELETE /api/message/:id cannot delete another user\'s message (403)', async () => {
            const author = seedUser({ nickname: 'Jack' });
            const other  = seedUser({ nickname: 'Kate' });
            const msgId  = seedMessage({ senderUid: author.uid });

            await request.delete(`/api/message/${msgId}`)
                .set('X-UID', other.uid).expect(403);
        });

        it('16. PATCH /api/message/:id returns 404 for non-existent message', async () => {
            const { uid } = seedUser({ nickname: 'Leo' });
            await request.patch('/api/message/nonexistent')
                .set('X-UID', uid).send({ text: 'x' }).expect(404);
        });

        it('17. Admin can delete any message', async () => {
            const admin  = seedUser({ nickname: 'AdminUser', isAdmin: true });
            const other  = seedUser({ nickname: 'Mary' });
            const msgId  = seedMessage({ senderUid: other.uid });

            const res = await request.delete(`/api/message/${msgId}`)
                .set('X-UID', admin.uid).expect(200);
            expect(res.body.success).to.be.true;
        });
    });

    // ════════════════════════════════════════════════════════════
    // 5. FILE OPERATIONS
    // ════════════════════════════════════════════════════════════
    describe('Chat File Operations', () => {
        it('18. DELETE /api/file/chat/:id deletes own chat file (200)', async () => {
            const { uid } = seedUser({ nickname: 'Nina' });
            const fileId  = seedFile('chat', { senderUid: uid });

            const res = await request.delete(`/api/file/chat/${fileId}`)
                .set('X-UID', uid).expect(200);
            expect(res.body.success).to.be.true;

            const row = db.prepare('SELECT id FROM chat_files WHERE id = ?').get(fileId);
            expect(row).to.be.undefined;
        });

        it('19. DELETE /api/file/chat/:id cannot delete another user\'s file (403)', async () => {
            const owner = seedUser({ nickname: 'Owen' });
            const other = seedUser({ nickname: 'Paul' });
            const fileId = seedFile('chat', { senderUid: owner.uid });

            await request.delete(`/api/file/chat/${fileId}`)
                .set('X-UID', other.uid).expect(403);
        });

        it('20. GET /download/chat/:id returns 404 for non-existent file', async () => {
            const { uid } = seedUser({ nickname: 'Quinn' });
            await request.get('/download/chat/nonexistent')
                .set('X-UID', uid).expect(404);
        });

        it('21. GET /download/chat/:id serves existing file', async () => {
            const { uid } = seedUser({ nickname: 'Rose' });
            const fileId  = require('crypto').randomUUID();
            const savedName = `${fileId}_test.txt`;

            // Create physical file
            const filePath = path.join(__dirname, '../uploads/chat', savedName);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, 'Hello Regnis');

            seedFile('chat', { id: fileId, senderUid: uid, saved: savedName, recipient: 'global', recipientType: 'global' });

            const res = await request.get(`/download/chat/${fileId}`)
                .set('X-UID', uid).expect(200);
            expect(res.body.toString()).to.equal('Hello Regnis');

            fs.unlinkSync(filePath);
        });
    });

    describe('Pool File Operations', () => {
        it('22. DELETE /api/file/pool/:id deletes own pool file (200)', async () => {
            const { uid } = seedUser({ nickname: 'Sam' });
            const fileId  = seedFile('pool', { uploaderUid: uid });

            const res = await request.delete(`/api/file/pool/${fileId}`)
                .set('X-UID', uid).expect(200);
            expect(res.body.success).to.be.true;
        });

        it('23. DELETE /api/file/pool/:id cannot delete another user\'s pool file (403)', async () => {
            const owner = seedUser({ nickname: 'Tara' });
            const other = seedUser({ nickname: 'Uma' });
            const fileId = seedFile('pool', { uploaderUid: owner.uid });

            await request.delete(`/api/file/pool/${fileId}`)
                .set('X-UID', other.uid).expect(403);
        });

        it('24. POST /download/pool/:id blocked without password (403)', async () => {
            const bcrypt = require('bcryptjs');
            const { uid }  = seedUser({ nickname: 'Vera' });
            const hash     = bcrypt.hashSync('secret123', 10);
            const fileId   = seedFile('pool', { uploaderUid: uid, passwordHash: hash });

            const res = await request.post(`/download/pool/${fileId}`)
                .set('X-UID', uid).send({}).expect(403);
            expect(res.body.requiresPassword).to.be.true;
        });

        it('25. POST /download/pool/:id blocked with wrong password (403)', async () => {
            const bcrypt = require('bcryptjs');
            const { uid }  = seedUser({ nickname: 'Will' });
            const hash     = bcrypt.hashSync('correctPass', 10);
            const fileId   = seedFile('pool', { uploaderUid: uid, passwordHash: hash });

            const res = await request.post(`/download/pool/${fileId}`)
                .set('X-UID', uid).send({ password: 'wrongPass' }).expect(403);
            expect(res.body.error).to.include('password');
        });

        it('26. GET /api/pool returns file list with password flags', async () => {
            const bcrypt = require('bcryptjs');
            const { uid } = seedUser({ nickname: 'Xena' });
            const hash    = bcrypt.hashSync('pass', 10);
            seedFile('pool', { uploaderUid: uid, uploaderName: 'Xena' });
            seedFile('pool', { uploaderUid: uid, uploaderName: 'Xena', passwordHash: hash, name: 'protected.jpg', category: 'photo' });

            const res = await request.get('/api/pool').set('X-UID', uid).expect(200);
            expect(res.body).to.be.an('array').with.length(2);
            const protected_ = res.body.find(f => f.hasPassword);
            expect(protected_).to.exist;
            const open = res.body.find(f => !f.hasPassword);
            expect(open).to.exist;
        });
    });

    // ════════════════════════════════════════════════════════════
    // 6. FILE COMMENTS
    // ════════════════════════════════════════════════════════════
    describe('File Comments', () => {
        it('27. POST /api/file/:type/:id/comment adds comment (200)', async () => {
            const { uid, nickname } = seedUser({ nickname: 'Yara' });
            const fileId = seedFile('chat', { senderUid: uid });

            const res = await request.post(`/api/file/chat/${fileId}/comment`)
                .set('X-UID', uid)
                .send({ text: 'Great file!' })
                .expect(200);
            expect(res.body.success).to.be.true;
            expect(res.body.commentId).to.be.a('string');

            const row = db.prepare('SELECT * FROM file_comments WHERE file_id = ?').get(fileId);
            expect(row.text).to.equal('Great file!');
            expect(row.author_name).to.equal(nickname);
        });

        it('28. GET /api/file/:type/:id/comments returns comment list', async () => {
            const { uid } = seedUser({ nickname: 'Zoe' });
            const fileId  = seedFile('chat', { senderUid: uid });

            // Seed comment
            db.prepare(`INSERT INTO file_comments (id, file_id, file_type, author_uid, author_name, text, timestamp)
                        VALUES (?,?,?,?,?,?,?)`)
              .run('cmt1', fileId, 'chat', uid, 'Zoe', 'Nice!', Date.now());

            const res = await request.get(`/api/file/chat/${fileId}/comments`)
                .set('X-UID', uid).expect(200);
            expect(res.body).to.be.an('array').with.length(1);
            expect(res.body[0].text).to.equal('Nice!');
            expect(res.body[0].authorName).to.equal('Zoe');
        });

        it('29. POST /api/file/:type/:id/comment returns 404 for non-existent file', async () => {
            const { uid } = seedUser({ nickname: 'Amy' });
            await request.post('/api/file/chat/nonexistent/comment')
                .set('X-UID', uid).send({ text: 'Hello' }).expect(404);
        });

        it('30. POST /api/file/:type/:id/comment returns 400 for invalid file type', async () => {
            const { uid } = seedUser({ nickname: 'Ben' });
            await request.post('/api/file/invalid/someid/comment')
                .set('X-UID', uid).send({ text: 'Hello' }).expect(400);
        });
    });

    // ════════════════════════════════════════════════════════════
    // 7. GROUPS
    // ════════════════════════════════════════════════════════════
    describe('Groups', () => {
        it('31. POST /api/group creates a new group', async () => {
            const { uid }  = seedUser({ nickname: 'Carl' });
            const member   = seedUser({ nickname: 'Diane' });

            const res = await request.post('/api/group')
                .set('X-UID', uid)
                .send({ name: 'Test Team', memberUids: [member.uid] })
                .expect(200);
            expect(res.body.success).to.be.true;
            expect(res.body.group.id).to.be.a('string');
            expect(res.body.group.name).to.equal('Test Team');
            expect(res.body.group.members).to.include(uid);
            expect(res.body.group.members).to.include(member.uid);
        });

        it('32. GET /api/groups returns only groups I belong to', async () => {
            const user1 = seedUser({ nickname: 'Emma' });
            const user2 = seedUser({ nickname: 'Fred' });

            // Create group with user1
            const gid = require('crypto').randomUUID();
            db.prepare('INSERT INTO groups_table (id, name, created_by) VALUES (?,?,?)').run(gid, 'Group A', user1.uid);
            db.prepare('INSERT INTO group_members (group_id, uid) VALUES (?,?)').run(gid, user1.uid);
            // user2 not in the group

            const res = await request.get('/api/groups').set('X-UID', user1.uid).expect(200);
            expect(res.body).to.be.an('array').with.length(1);
            expect(res.body[0].name).to.equal('Group A');

            const res2 = await request.get('/api/groups').set('X-UID', user2.uid).expect(200);
            expect(res2.body).to.be.an('array').with.length(0);
        });

        it('33. GET /api/history for a group I\'m not in returns 403', async () => {
            const user = seedUser({ nickname: 'George' });
            const gid  = require('crypto').randomUUID();
            db.prepare('INSERT INTO groups_table (id, name, created_by) VALUES (?,?,?)').run(gid, 'Secret Group', 'other');

            await request.get(`/api/history?recipient=${gid}&recipientType=group`)
                .set('X-UID', user.uid).expect(403);
        });
    });

    // ════════════════════════════════════════════════════════════
    // 8. ADMIN CONTROLS
    // ════════════════════════════════════════════════════════════
    describe('Admin Controls', () => {
        it('34. POST /api/admin/config toggles config (admin only)', async () => {
            const admin = seedUser({ nickname: 'AdminA', isAdmin: true });

            const res = await request.post('/api/admin/config')
                .set('X-UID', admin.uid)
                .send({ key: 'groupChatEnabled', value: false })
                .expect(200);
            expect(res.body.success).to.be.true;
            expect(res.body.config.groupChatEnabled).to.be.false;
        });

        it('35. POST /api/admin/config is blocked for non-admins (403)', async () => {
            const user = seedUser({ nickname: 'RegUser' });
            await request.post('/api/admin/config')
                .set('X-UID', user.uid)
                .send({ key: 'groupChatEnabled', value: false })
                .expect(403);
        });

        it('36. POST /api/admin/approve/:uid approves pending user', async () => {
            const admin = seedUser({ nickname: 'AdminB', isAdmin: true });
            const pendingUid = require('crypto').randomUUID();
            db.prepare('INSERT INTO pending_users (uid, nickname, ip) VALUES (?,?,?)').run(pendingUid, 'PendingUser', '192.168.1.99');

            const res = await request.post(`/api/admin/approve/${pendingUid}`)
                .set('X-UID', admin.uid).expect(200);
            expect(res.body.success).to.be.true;

            // User should now be in users table
            const user = db.prepare('SELECT uid FROM users WHERE uid = ?').get(pendingUid);
            expect(user).to.exist;

            // Pending should be removed
            const pending = db.prepare('SELECT uid FROM pending_users WHERE uid = ?').get(pendingUid);
            expect(pending).to.be.undefined;
        });

        it('37. POST /api/admin/reject/:uid rejects pending user', async () => {
            const admin = seedUser({ nickname: 'AdminC', isAdmin: true });
            const pendingUid = require('crypto').randomUUID();
            db.prepare('INSERT INTO pending_users (uid, nickname, ip) VALUES (?,?,?)').run(pendingUid, 'RejectedUser', '192.168.1.88');

            const res = await request.post(`/api/admin/reject/${pendingUid}`)
                .set('X-UID', admin.uid).expect(200);
            expect(res.body.success).to.be.true;

            const pending = db.prepare('SELECT uid FROM pending_users WHERE uid = ?').get(pendingUid);
            expect(pending).to.be.undefined;
            const user = db.prepare('SELECT uid FROM users WHERE uid = ?').get(pendingUid);
            expect(user).to.be.undefined;
        });

        it('38. GET /api/pending returns pending users list (admin only)', async () => {
            const admin = seedUser({ nickname: 'AdminD', isAdmin: true });
            db.prepare('INSERT INTO pending_users (uid, nickname, ip) VALUES (?,?,?)').run('p1','Pending1','10.0.0.1');
            db.prepare('INSERT INTO pending_users (uid, nickname, ip) VALUES (?,?,?)').run('p2','Pending2','10.0.0.2');

            const res = await request.get('/api/pending')
                .set('X-UID', admin.uid).expect(200);
            expect(res.body).to.be.an('array').with.length(2);
        });

        it('39. GET /api/pending blocked for non-admin (403)', async () => {
            const user = seedUser({ nickname: 'NormalUser' });
            await request.get('/api/pending').set('X-UID', user.uid).expect(403);
        });

        it('40. GET /api/admin/data accessible from localhost', async () => {
            // supertest uses 127.0.0.1 as clientIP
            const res = await request.get('/api/admin/data').expect(200);
            expect(res.body).to.have.property('config');
            expect(res.body).to.have.property('clients');
            expect(res.body).to.have.property('blockedIPs');
        });
    });

    // ════════════════════════════════════════════════════════════
    // 9. HISTORY
    // ════════════════════════════════════════════════════════════
    describe('Chat History', () => {
        it('41. GET /api/history for global channel returns messages & files', async () => {
            const { uid } = seedUser({ nickname: 'Harry' });
            seedMessage({ senderUid: uid, recipient: 'global', recipientType: 'global' });
            seedMessage({ senderUid: uid, recipient: 'global', recipientType: 'global', text: 'Second message' });
            seedFile('chat', { senderUid: uid, recipient: 'global', recipientType: 'global' });

            const res = await request.get('/api/history?recipient=global&recipientType=global')
                .set('X-UID', uid).expect(200);
            expect(res.body.messages).to.be.an('array').with.length(2);
            expect(res.body.files).to.be.an('array').with.length(1);
        });

        it('42. GET /api/history returns 400 without params', async () => {
            const { uid } = seedUser({ nickname: 'Irene' });
            await request.get('/api/history').set('X-UID', uid).expect(400);
        });

        it('43. File in history includes comment_count field', async () => {
            const { uid } = seedUser({ nickname: 'Jake' });
            const fileId  = seedFile('chat', { senderUid: uid, recipient: 'global', recipientType: 'global' });
            db.prepare('INSERT INTO file_comments (id, file_id, file_type, author_uid, author_name, text, timestamp) VALUES (?,?,?,?,?,?,?)')
              .run('c1', fileId, 'chat', uid, 'Jake', 'Comment!', Date.now());

            const res = await request.get('/api/history?recipient=global&recipientType=global')
                .set('X-UID', uid).expect(200);
            const file = res.body.files.find(f => f.id === fileId);
            expect(file).to.exist;
            expect(file.comment_count).to.equal(1);
        });
    });

    // ════════════════════════════════════════════════════════════
    // 10. CONFIG UTILITIES
    // ════════════════════════════════════════════════════════════
    describe('Config Utilities', () => {
        it('44. getConfig returns correct boolean values', () => {
            setConfig('groupChatEnabled', false);
            const cfg = getConfig();
            expect(cfg.groupChatEnabled).to.be.false;
        });

        it('45. setConfig persists value correctly', () => {
            setConfig('networkMode', 'private');
            const cfg = getConfig();
            expect(cfg.networkMode).to.equal('private');
        });
    });

});
