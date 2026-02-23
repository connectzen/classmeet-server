require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@insforge/sdk');
const roomManager = require('./rooms');
const db = require('./db');

// Multer: store uploads in memory for streaming to InsForge Storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const PORT = process.env.PORT || 3001;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const insforge = createClient({
    baseUrl: process.env.INSFORGE_BASE_URL,
    anonKey: process.env.INSFORGE_ANON_KEY,
});

const app = express();
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: CLIENT_URL, methods: ['GET', 'POST'] },
});

// Teacher grace-period timers: roomCode → setTimeout handle
const teacherGraceTimers = new Map();
const TEACHER_GRACE_MS = 30_000;

// User ID to Socket ID mapping for direct messaging
const userSockets = new Map();
// Dedicated map for chat-specific sockets (set via chat:register only)
const chatSockets = new Map();

// ── Ensure per-pair chat_permissions table exists ─────────────────────────
db.query(`
    CREATE TABLE IF NOT EXISTS chat_permissions (
        student_id     TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        student_name   TEXT DEFAULT '',
        student_email  TEXT DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (student_id, target_user_id)
    )
`).catch(err => console.error('[init] chat_permissions table error:', err.message));

// ── Cascade-delete all content produced by a user (called before Auth deletion) ──
async function cascadeDeleteUserContent(userId) {
    const baseUrl = process.env.INSFORGE_BASE_URL;
    const apiKey  = process.env.INSFORGE_API_KEY;

    // 1. Find all messages with media files sent by this user
    const { rows: mediaMessages } = await db.query(
        `SELECT id, media_url, conversation_id FROM chat_messages WHERE sender_id = $1 AND media_url IS NOT NULL`,
        [userId]
    );

    // 2. Delete each file from storage
    for (const msg of mediaMessages) {
        const parts = (msg.media_url || '').split('/api/storage/buckets/chat-media/objects/');
        const key = parts[1];
        if (key && baseUrl && apiKey) {
            try {
                await fetch(`${baseUrl}/api/storage/buckets/chat-media/objects/${key}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                });
            } catch (e) { console.warn('[cascade] storage delete failed:', e.message); }
        }
    }

    // 3. Soft-delete all their messages (tombstone — content stays visible as "removed")
    const { rows: tombstoned } = await db.query(
        `UPDATE chat_messages
         SET is_deleted = TRUE, content = NULL, media_url = NULL, media_name = NULL, media_type = NULL
         WHERE sender_id = $1
         RETURNING id, conversation_id`,
        [userId]
    );

    // 4. Notify open chat rooms so live users see tombstones immediately
    const affectedConvs = new Set(tombstoned.map(r => r.conversation_id));
    for (const convId of affectedConvs) {
        const tombstoneIds = tombstoned.filter(r => r.conversation_id === convId).map(r => r.id);
        io.to(`chat:${convId}`).emit('chat:messagesTombstoned', { conversationId: convId, messageIds: tombstoneIds });
    }
}

// ─── REST ────────────────────────────────────────────────────────────────

// Admin user IDs from env (comma-separated)
const ADMIN_USER_IDS = new Set(
    (process.env.ADMIN_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)
);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/is-admin/:userId', (req, res) => {
    res.json({ isAdmin: ADMIN_USER_IDS.has(req.params.userId) });
});

app.get('/api/user-role/:userId', async (req, res) => {
    const { userId } = req.params;
    if (ADMIN_USER_IDS.has(userId)) {
        return res.json({ role: 'admin' });
    }
    try {
        const { rows } = await db.query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
        if (rows.length > 0) {
            return res.json({ role: rows[0].role });
        }
        return res.json({ role: 'pending' }); // Default: pending approval
    } catch (err) {
        console.error('[REST] Error fetching user role:', err);
        res.status(500).json({ error: 'Failed to fetch user role' });
    }
});

app.get('/api/teachers', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT user_id, name, email, created_at
            FROM user_roles
            WHERE role = 'teacher'
            ORDER BY created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/teachers', async (req, res) => {
    const { name, email, tempPassword } = req.body;
    if (!name || !email || !tempPassword) return res.status(400).json({ error: 'Name, email, and tempPassword are required' });
    
    try {
        // 1. Create user in InsForge Auth
        const { data: authData, error: authError } = await insforge.auth.signUp({
            email,
            password: tempPassword,
            options: {
                data: { name }
            }
        });
        
        if (authError) throw authError;
        
        // Sign out immediately so the server doesn't stay logged in as the new user
        await insforge.auth.signOut();
        
        const userId = authData.user.id;
        
        // 2. Insert into user_roles
        await db.query(
            "INSERT INTO user_roles (user_id, role, name, email) VALUES ($1, 'teacher', $2, $3)",
            [userId, name, email]
        );

        io.emit('admin:refresh', { type: 'teachers' });
        res.json({ id: userId, name, email });
    } catch (err) {
        console.error('[REST] Error creating teacher:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/teachers/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Cascade-delete all chat content (storage files + tombstone messages)
        await cascadeDeleteUserContent(id);

        // 2. Remove from user_roles + rooms
        await db.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'teacher'", [id]);

        // 3. Delete from InsForge Auth (admin endpoint)
        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey = process.env.INSFORGE_API_KEY;
        if (baseUrl && apiKey) {
            try {
                const authRes = await fetch(`${baseUrl}/api/auth/users`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: [id] }),
                });
                if (!authRes.ok) {
                    const errBody = await authRes.text();
                    console.warn('[REST] Auth user delete failed:', errBody);
                }
            } catch (authErr) {
                console.warn('[REST] Could not delete auth user:', authErr.message);
            }
        }

        io.emit('admin:refresh', { type: 'teachers' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/students', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT ur.user_id, ur.name, ur.email, ur.created_at,
                   COUNT(se.id)::int AS enrollment_count,
                   COALESCE(ur.chat_allowed, false) AS chat_allowed
            FROM user_roles ur
            LEFT JOIN student_enrollments se ON se.user_id = ur.user_id::text
            WHERE ur.role = 'student'
            GROUP BY ur.user_id, ur.name, ur.email, ur.created_at, ur.chat_allowed
            ORDER BY ur.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Per-student enrollment list (for admin expand)
app.get('/api/students/:userId/enrollments', async (req, res) => {
    const { userId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT room_id, room_code, room_name, enrolled_at FROM student_enrollments WHERE user_id = $1 ORDER BY enrolled_at DESC`,
            [userId]
        );
        // Annotate each with is_active by checking rooms table
        const roomIds = rows.map(r => r.room_id);
        let activeSet = new Set();
        if (roomIds.length > 0) {
            const placeholders = roomIds.map((_, i) => `$${i + 1}`).join(',');
            const { rows: activeRooms } = await db.query(
                `SELECT id FROM rooms WHERE id IN (${placeholders})`, roomIds
            );
            activeSet = new Set(activeRooms.map(r => r.id));
        }
        res.json(rows.map(r => ({ ...r, is_active: activeSet.has(r.room_id) })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove a specific enrollment
app.delete('/api/students/:userId/enrollments/:roomId', async (req, res) => {
    const { userId, roomId } = req.params;
    try {
        await db.query('DELETE FROM student_enrollments WHERE user_id = $1 AND room_id = $2', [userId, roomId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a student completely (user_roles + enrollments + InsForge Auth)
app.delete('/api/students/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Cascade-delete all chat content (storage files + tombstone messages)
        await cascadeDeleteUserContent(id);

        // 2. Remove enrollments + role
        await db.query("DELETE FROM student_enrollments WHERE user_id = $1", [id]);
        await db.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'student'", [id]);

        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey  = process.env.INSFORGE_API_KEY;
        if (baseUrl && apiKey) {
            try {
                const authRes = await fetch(`${baseUrl}/api/auth/users`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: [id] }),
                });
                if (!authRes.ok) console.warn('[REST] Student auth delete failed:', await authRes.text());
            } catch (authErr) {
                console.warn('[REST] Could not delete student auth user:', authErr.message);
            }
        }
        io.emit('admin:refresh', { type: 'students' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Chat Access Requests ─────────────────────────────────────────────────

// Student requests access to chat with a specific teacher/admin
app.post('/api/chat/request-access', async (req, res) => {
    const { userId, userName, email, targetUserId } = req.body;
    if (!userId || !targetUserId) return res.status(400).json({ error: 'userId and targetUserId required' });
    try {
        await db.query(
            `INSERT INTO chat_permissions (student_id, target_user_id, student_name, student_email, status)
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT (student_id, target_user_id) DO UPDATE
               SET status        = CASE WHEN chat_permissions.status = 'allowed' THEN 'allowed' ELSE 'pending' END,
                   student_name  = EXCLUDED.student_name,
                   student_email = EXCLUDED.student_email,
                   created_at    = CASE WHEN chat_permissions.status = 'allowed' THEN chat_permissions.created_at ELSE NOW() END`,
            [userId, targetUserId, userName || '', email || '']
        );
        io.emit('admin:refresh', { type: 'chatRequests' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get pending chat requests; optionally filter by targetUserId (teacher/admin passes their own ID)
app.get('/api/chat/requests', async (req, res) => {
    const { targetUserId } = req.query;
    try {
        const { rows } = await db.query(
            targetUserId
                ? `SELECT student_id, student_name, student_email, status, created_at, target_user_id FROM chat_permissions WHERE status = 'pending' AND target_user_id = $1 ORDER BY created_at ASC`
                : `SELECT student_id, student_name, student_email, status, created_at, target_user_id FROM chat_permissions WHERE status = 'pending' ORDER BY created_at ASC`,
            targetUserId ? [targetUserId] : []
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all per-pair permissions for a student
app.get('/api/chat/permissions/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT target_user_id, status FROM chat_permissions WHERE student_id = $1`,
            [userId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check a student's chat access
app.get('/api/chat/access/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT COALESCE(chat_allowed, false) AS chat_allowed FROM user_roles WHERE user_id = $1`,
            [userId]
        );
        const chatAllowed = rows.length > 0 ? rows[0].chat_allowed : false;
        // Also fetch request status from new table
        const { rows: reqRows } = await db.query(
            `SELECT target_user_id, status FROM chat_permissions WHERE student_id = $1`,
            [userId]
        );
        res.json({ chatAllowed, permissions: reqRows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Allow a student to chat (per-pair)
app.put('/api/chat/allow/:userId', async (req, res) => {
    const { userId } = req.params;
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
    try {
        await db.query(
            `INSERT INTO chat_permissions (student_id, target_user_id, status)
             VALUES ($1, $2, 'allowed')
             ON CONFLICT (student_id, target_user_id) DO UPDATE SET status = 'allowed'`,
            [userId, targetUserId]
        );
        const sockId = chatSockets.get(userId) || userSockets.get(userId);
        if (sockId) io.to(sockId).emit('chat:accessGranted', { by: targetUserId });
        io.emit('admin:refresh', { type: 'chatRequests' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Revoke a student's chat access (per-pair — end chat)
app.put('/api/chat/revoke/:userId', async (req, res) => {
    const { userId } = req.params;
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
    try {
        await db.query(
            `UPDATE chat_permissions SET status = 'none' WHERE student_id = $1 AND target_user_id = $2`,
            [userId, targetUserId]
        );
        const sockId = chatSockets.get(userId) || userSockets.get(userId);
        if (sockId) io.to(sockId).emit('chat:accessRevoked', { by: targetUserId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Decline a student's chat request (per-pair)
app.put('/api/chat/decline/:userId', async (req, res) => {
    const { userId } = req.params;
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
    try {
        await db.query(
            `UPDATE chat_permissions SET status = 'declined' WHERE student_id = $1 AND target_user_id = $2`,
            [userId, targetUserId]
        );
        const sockId = chatSockets.get(userId) || userSockets.get(userId);
        if (sockId) io.to(sockId).emit('chat:accessDeclined', { by: targetUserId });
        io.emit('admin:refresh', { type: 'chatRequests' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/all-users', async (req, res) => {
    try {
        const { rows } = await db.query("SELECT user_id as id, name, email, role FROM user_roles");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Pending (not-yet-approved) users ──────────────────────────────────────
app.get('/api/pending-users', async (req, res) => {
    try {
        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey  = process.env.INSFORGE_API_KEY;
        if (!baseUrl || !apiKey) return res.status(500).json({ error: 'Missing InsForge config' });

        // Fetch all auth users from InsForge admin endpoint
        const authRes = await fetch(`${baseUrl}/api/auth/users?limit=1000`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!authRes.ok) {
            const errBody = await authRes.text();
            return res.status(500).json({ error: 'Failed to fetch auth users: ' + errBody });
        }
        const authData = await authRes.json();
        const authUsers = Array.isArray(authData) ? authData : (authData.users || authData.data || []);

        // Get all user_ids already assigned a role
        const { rows: roleRows } = await db.query('SELECT user_id FROM user_roles');
        const assignedIds = new Set(roleRows.map(r => r.user_id));

        // Filter out admins and already-assigned users
        const pending = authUsers
            .filter(u => !ADMIN_USER_IDS.has(u.id) && !assignedIds.has(u.id))
            .map(u => ({
                id:         u.id,
                name:       u.profile?.name || u.name || '',
                email:      u.email || '',
                created_at: u.created_at || u.createdAt || null,
            }));

        res.json(pending);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Approve a pending user ────────────────────────────────────────────────
app.post('/api/approve-user/:userId', async (req, res) => {
    const { userId } = req.params;
    const { name, email, role = 'student' } = req.body;
    try {
        await db.query(
            `INSERT INTO user_roles (user_id, role, name, email)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`,
            [userId, role, name || '', email || '']
        );
        io.emit('admin:refresh', { type: 'pending' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/messages/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const { rows } = await db.query(
            "SELECT * FROM messages WHERE receiver_id = $1 ORDER BY created_at DESC",
            [userId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages', async (req, res) => {
    const { fromUserId, fromName, toUserId, toRole, subject, body } = req.body;
    if (!fromUserId || !body) return res.status(400).json({ error: 'Missing fields' });
    
    try {
        let receivers = [];
        if (toUserId) {
            receivers.push(toUserId);
        } else if (toRole === 'all') {
            const { rows } = await db.query("SELECT user_id FROM user_roles");
            receivers = rows.map(r => r.user_id);
        } else if (toRole) {
            const { rows } = await db.query("SELECT user_id FROM user_roles WHERE role = $1", [toRole]);
            receivers = rows.map(r => r.user_id);
        }

        if (receivers.length === 0) {
            return res.status(400).json({ error: 'No recipients found' });
        }

        const values = [];
        const params = [];
        let paramIndex = 1;

        for (const receiverId of receivers) {
            values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
            params.push(fromUserId, fromName || 'Admin', receiverId, subject || '', body);
        }

        const query = `
            INSERT INTO messages (sender_id, sender_name, receiver_id, subject, content)
            VALUES ${values.join(', ')}
            RETURNING *
        `;

        const { rows } = await db.query(query, params);
        
        // Emit to receivers if online
        for (const msg of rows) {
            const receiverSocketId = userSockets.get(msg.receiver_id);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('new-message', msg);
            }
        }
        
        res.json({ success: true, count: rows.length });
    } catch (err) {
        console.error('[REST] Error sending message:', err);
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/messages/:messageId/read', async (req, res) => {
    const { messageId } = req.params;
    try {
        await db.query("UPDATE messages SET is_read = TRUE WHERE id = $1", [messageId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sent messages by admin user
app.get('/api/messages/sent/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const { rows } = await db.query(
            "SELECT * FROM messages WHERE sender_id = $1 ORDER BY created_at DESC",
            [userId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── CHAT API ────────────────────────────────────────────────────────────

// Upload media to InsForge Storage and return URL
app.post('/api/chat/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey  = process.env.INSFORGE_API_KEY;
        const ext     = req.file.originalname.split('.').pop() || 'bin';
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

        // Step 1 — get upload strategy
        const stratRes = await fetch(`${baseUrl}/api/storage/buckets/chat-media/upload-strategy`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, contentType: req.file.mimetype, size: req.file.size }),
        });
        if (!stratRes.ok) return res.status(500).json({ error: 'Strategy failed: ' + await stratRes.text() });
        const strategy = await stratRes.json();

        const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
        let publicUrl;

        if (strategy.method === 'direct') {
            // Local storage — PUT multipart
            const uploadUrl = strategy.uploadUrl.startsWith('http') ? strategy.uploadUrl : `${baseUrl}${strategy.uploadUrl}`;
            const form = new FormData();
            form.append('file', fileBlob, req.file.originalname);
            const upRes = await fetch(uploadUrl, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: form,
            });
            if (!upRes.ok) return res.status(500).json({ error: 'Upload failed: ' + await upRes.text() });
            publicUrl = uploadUrl;
        } else {
            // S3 — POST to presigned URL with all fields
            const form = new FormData();
            for (const [k, v] of Object.entries(strategy.fields || {})) form.append(k, String(v));
            form.append('file', fileBlob, req.file.originalname);
            const upRes = await fetch(strategy.uploadUrl, { method: 'POST', body: form });
            if (!upRes.ok) return res.status(500).json({ error: 'S3 upload failed: ' + await upRes.text() });
            // Confirm if required
            if (strategy.confirmRequired && strategy.confirmUrl) {
                const confirmUrl = strategy.confirmUrl.startsWith('http') ? strategy.confirmUrl : `${baseUrl}${strategy.confirmUrl}`;
                await fetch(confirmUrl, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ size: req.file.size, contentType: req.file.mimetype }),
                });
            }
            publicUrl = `${baseUrl}/api/storage/buckets/chat-media/objects/${strategy.key}`;
        }

        res.json({ url: publicUrl, name: req.file.originalname, type: req.file.mimetype, key: strategy.key });
    } catch (err) {
        console.error('[chat/upload]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Delete a chat message (+ clean up storage file if any)
app.delete('/api/chat/messages/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await db.query('SELECT * FROM chat_messages WHERE id = $1', [id]);
        if (!rows.length) return res.status(404).json({ error: 'Message not found' });
        const msg = rows[0];

        // Delete media from storage
        if (msg.media_url) {
            const baseUrl = process.env.INSFORGE_BASE_URL;
            const apiKey  = process.env.INSFORGE_API_KEY;
            const parts = msg.media_url.split('/api/storage/buckets/chat-media/objects/');
            const key = parts[1];
            if (key) {
                try {
                    await fetch(`${baseUrl}/api/storage/buckets/chat-media/objects/${key}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${apiKey}` },
                    });
                } catch (e) { console.warn('[chat:delete] storage cleanup failed:', e.message); }
            }
        }

        await db.query('DELETE FROM chat_messages WHERE id = $1', [id]);
        res.json({ success: true, conversationId: msg.conversation_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete an entire conversation (and all its messages + storage files)
app.delete('/api/chat/conversations/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Delete storage files for all media messages in this conversation
        const { rows: mediaMessages } = await db.query(
            `SELECT media_url FROM chat_messages WHERE conversation_id = $1 AND media_url IS NOT NULL`, [id]
        );
        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey  = process.env.INSFORGE_API_KEY;
        for (const msg of mediaMessages) {
            const parts = (msg.media_url || '').split('/api/storage/buckets/chat-media/objects/');
            const key = parts[1];
            if (key && baseUrl && apiKey) {
                try {
                    await fetch(`${baseUrl}/api/storage/buckets/chat-media/objects/${key}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${apiKey}` },
                    });
                } catch (e) { console.warn('[conv:delete] storage cleanup failed:', e.message); }
            }
        }
        // Delete messages, participants, then the conversation
        await db.query('DELETE FROM chat_messages WHERE conversation_id = $1',    [id]);
        await db.query('DELETE FROM chat_participants WHERE conversation_id = $1', [id]);
        await db.query('DELETE FROM chat_conversations WHERE id = $1',             [id]);

        // Notify all clients in this conversation room
        io.to(`chat:${id}`).emit('chat:conversationDeleted', { conversationId: id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List conversations for a user (DMs they started + groups they're in)
app.get('/api/chat/conversations/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        // Get all conversation IDs this user participates in
        const { rows: convRows } = await db.query(
            `SELECT cp.conversation_id, c.type, c.name, c.created_at,
                    (SELECT row_to_json(m.*) FROM chat_messages m
                     WHERE m.conversation_id = cp.conversation_id
                     ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                    (SELECT COUNT(*) FROM chat_messages m
                     WHERE m.conversation_id = cp.conversation_id
                       AND m.is_read = FALSE
                       AND m.sender_id != $1) AS unread_count
             FROM chat_participants cp
             JOIN chat_conversations c ON c.id = cp.conversation_id
             WHERE cp.user_id = $1
             ORDER BY c.created_at DESC`,
            [userId]
        );

        // For DMs, fetch the other participant's info
        const enriched = await Promise.all(convRows.map(async (conv) => {
            if (conv.type === 'dm') {
                const { rows: others } = await db.query(
                    `SELECT user_id, user_name, user_role FROM chat_participants
                     WHERE conversation_id = $1 AND user_id != $2 LIMIT 1`,
                    [conv.conversation_id, userId]
                );
                return { ...conv, other_user: others[0] || null };
            }
            return conv;
        }));

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get messages in a conversation (paginated, newest last)
app.get('/api/chat/messages/:conversationId', async (req, res) => {
    const { conversationId } = req.params;
    const limit  = parseInt(req.query.limit  || '50');
    const before = req.query.before; // ISO timestamp for pagination
    try {
        let q = `SELECT * FROM chat_messages WHERE conversation_id = $1`;
        const params = [conversationId];
        if (before) { q += ` AND created_at < $2`; params.push(before); }
        q += ` ORDER BY created_at ASC LIMIT $${params.length + 1}`;
        params.push(limit);
        const { rows } = await db.query(q, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get or create a DM conversation between two users
app.post('/api/chat/conversations/dm', async (req, res) => {
    const { userId, userRole, userName, otherId, otherRole, otherName } = req.body;
    if (!userId || !otherId) return res.status(400).json({ error: 'userId and otherId required' });
    try {
        // Check if a DM already exists between these two users
        const { rows: existing } = await db.query(
            `SELECT cp1.conversation_id FROM chat_participants cp1
             JOIN chat_participants cp2 ON cp1.conversation_id = cp2.conversation_id
             JOIN chat_conversations c ON c.id = cp1.conversation_id
             WHERE cp1.user_id = $1 AND cp2.user_id = $2 AND c.type = 'dm'
             LIMIT 1`,
            [userId, otherId]
        );
        if (existing.length > 0) return res.json({ id: existing[0].conversation_id });

        // Create new DM
        const { rows: newConv } = await db.query(
            `INSERT INTO chat_conversations (type) VALUES ('dm') RETURNING id`
        );
        const convId = newConv[0].id;
        await db.query(
            `INSERT INTO chat_participants (conversation_id, user_id, user_name, user_role) VALUES
             ($1,$2,$3,$4),($1,$5,$6,$7)`,
            [convId, userId, userName || '', userRole || '', otherId, otherName || '', otherRole || '']
        );
        res.json({ id: convId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Join a broadcast/group (idempotent)
app.post('/api/chat/conversations/:convId/join', async (req, res) => {
    const { convId } = req.params;
    const { userId, userName, userRole } = req.body;
    try {
        await db.query(
            `INSERT INTO chat_participants (conversation_id, user_id, user_name, user_role)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [convId, userId, userName || '', userRole || '']
        );
        const { rows: msgs } = await db.query(
            `SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 50`,
            [convId]
        );
        res.json({ id: convId, messages: msgs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Persist a chat message
app.post('/api/chat/messages', async (req, res) => {
    const { conversationId, senderId, senderName, senderRole, content, mediaUrl, mediaType, mediaName } = req.body;
    if (!conversationId || !senderId) return res.status(400).json({ error: 'conversationId and senderId required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO chat_messages (conversation_id, sender_id, sender_name, sender_role, content, media_url, media_type, media_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [conversationId, senderId, senderName || '', senderRole || 'student',
             content || null, mediaUrl || null, mediaType || null, mediaName || null]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add/toggle reaction
app.patch('/api/chat/messages/:id/react', async (req, res) => {
    const { id } = req.params;
    const { userId, emoji } = req.body;
    try {
        const { rows } = await db.query('SELECT reactions FROM chat_messages WHERE id = $1', [id]);
        if (!rows.length) return res.status(404).json({ error: 'Message not found' });
        const reactions = rows[0].reactions || {};
        if (!reactions[emoji]) reactions[emoji] = [];
        const idx = reactions[emoji].indexOf(userId);
        if (idx >= 0) reactions[emoji].splice(idx, 1);
        else reactions[emoji].push(userId);
        if (reactions[emoji].length === 0) delete reactions[emoji];
        await db.query('UPDATE chat_messages SET reactions = $1 WHERE id = $2', [JSON.stringify(reactions), id]);
        res.json({ reactions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mark messages as read
app.patch('/api/chat/conversations/:convId/read', async (req, res) => {
    const { convId } = req.params;
    const { userId } = req.body;
    try {
        await db.query(
            `UPDATE chat_messages SET is_read = TRUE WHERE conversation_id = $1 AND sender_id != $2`,
            [convId, userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:code', async (req, res) => {
    const { code } = req.params;
    console.log(`[REST] GET /api/rooms/${code}`);

    const { data, error } = await insforge.database
        .from('rooms')
        .select('id, code, name, host_id, max_participants')
        .eq('code', code)
        .eq('is_active', true)
        .maybeSingle();

    console.log(`[REST] result — data:`, data ? data.code : null, '| error:', error?.message);

    if (error) return res.status(500).json({ error: `Database error: ${error.message}` });
    if (!data) return res.status(404).json({ error: 'Room not found or inactive' });

    const currentCount = roomManager.getParticipantCount(code);
    const teacherPresent = !!roomManager.getTeacherSocketId(code);
    res.json({ ...data, currentParticipants: currentCount, teacherPresent });
});

// Teacher's active classes
app.get('/api/rooms/by-host/:hostId', async (req, res) => {
    const { hostId } = req.params;
    const { data, error } = await insforge.database
        .from('rooms')
        .select('id, code, name, host_id, max_participants, created_at')
        .eq('host_id', hostId)
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const rooms = (data || []).map((r) => ({
        ...r,
        currentParticipants: roomManager.getParticipantCount(r.code),
        teacherPresent: !!roomManager.getTeacherSocketId(r.code),
    }));
    res.json(rooms);
});

// Delete (deactivate) a class — teacher only
app.delete('/api/rooms/:roomId', async (req, res) => {
    const { roomId } = req.params;
    const { hostId } = req.body;
    console.log(`[REST] DELETE /api/rooms/${roomId} by hostId:${hostId}`);
    // Find the room
    const { data: room, error: findErr } = await insforge.database
        .from('rooms')
        .select('id, code, host_id')
        .eq('id', roomId)
        .maybeSingle();
    console.log(`[REST] Found room:`, room ? `${room.code} (host: ${room.host_id})` : 'null', '| error:', findErr?.message);
    if (findErr || !room) return res.status(404).json({ error: 'Room not found' });
    if (room.host_id !== hostId) {
        console.log(`[REST] Authorization failed: room host_id=${room.host_id} !== requestor hostId=${hostId}`);
        return res.status(403).json({ error: 'Not authorized' });
    }
    await endRoom(room.code, roomId);
    console.log(`[REST] Room ${room.code} deleted successfully`);
    res.json({ success: true });
});

// Save student enrollment (upsert — safe to call on every rejoin)
app.post('/api/enrollments', async (req, res) => {
    const { userId, roomId, roomCode, roomName } = req.body;
    if (!userId || !roomId) return res.status(400).json({ error: 'userId and roomId required' });
    try {
        await db.query(
            `INSERT INTO student_enrollments (user_id, room_id, room_code, room_name)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, room_id) DO UPDATE SET room_name = EXCLUDED.room_name`,
            [userId, roomId, roomCode, roomName]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[Enrollment] upsert failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get enrolled active classes for a student
app.get('/api/enrollments/:userId', async (req, res) => {
    const { userId } = req.params;
    const { data, error } = await insforge.database
        .from('student_enrollments')
        .select('room_id, room_code, room_name, enrolled_at')
        .eq('user_id', userId)
        .order('enrolled_at', { ascending: false });
    if (error) {
        console.warn('[Enrollment] fetch failed:', error.message);
        return res.status(500).json({ error: error.message });
    }
    const codes = (data || []).map((e) => e.room_code);
    if (codes.length === 0) return res.json([]);

    // Filter to only rooms that are still active in the DB
    const { data: active, error: roomErr } = await insforge.database
        .from('rooms')
        .select('id, code, name, host_id, max_participants')
        .in('code', codes)
        .eq('is_active', true);
    if (roomErr) return res.status(500).json({ error: roomErr.message });

    const activeMap = new Map((active || []).map((r) => [r.code, r]));
    const result = (data || [])
        .filter((e) => activeMap.has(e.room_code))
        .map((e) => {
            const room = activeMap.get(e.room_code);
            return {
                ...room,
                currentParticipants: roomManager.getParticipantCount(e.room_code),
                teacherPresent: !!roomManager.getTeacherSocketId(e.room_code),
            };
        });
    res.json(result);
});

// Create room (server-side to avoid client-auth/RLS issues)
app.post('/api/rooms', async (req, res) => {
    const { code, name, hostId } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });

    console.log(`[REST] POST /api/rooms — code:${code} name:${name}`);

    const { data, error } = await insforge.database
        .from('rooms')
        .insert([{ code, name, host_id: hostId || null }])
        .select();

    console.log(`[REST] insert result — data:`, data?.[0]?.id, '| error:', error?.message);

    if (error || !data?.[0]) {
        return res.status(500).json({ error: error?.message || 'Failed to create room' });
    }
    res.json(data[0]);
});

// ─── HELPERS ─────────────────────────────────────────────────────────────

async function endRoom(roomCode, roomId) {
    try {
        // Use direct pg connection to bypass RLS — server has superuser access
        const result = await db.query('DELETE FROM rooms WHERE id = $1', [roomId]);
        if (result.rowCount > 0) {
            console.log(`[endRoom] Successfully deleted room ${roomCode} from database`);
        } else {
            console.warn(`[endRoom] Room ${roomCode} (${roomId}) not found in database`);
        }
    } catch (err) {
        console.error('Failed to delete room:', err);
    }
    io.to(roomCode).emit('room-ended');
    console.log(`[Room ${roomCode}] terminated.`);
}

// ─── SOCKET.IO ───────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log(`[+] ${socket.id}`);

    // ── Register User for Direct Messages ──────────────────────────────────
    socket.on('register-user', (userId) => {
        if (userId) {
            userSockets.set(userId, socket.id);
            console.log(`[Socket] Registered user ${userId} to socket ${socket.id}`);
        }
    });

    // ── Join Room ──────────────────────────────────────────────────────────
    socket.on('join-room', ({ roomCode, roomId, roomName, name, role }, callback) => {
        console.log(`[Socket] join-room: ${name} (${role}) -> ${roomCode}`);
        const currentCount = roomManager.getParticipantCount(roomCode);
        if (currentCount >= 5) return callback({ error: 'Room is full (max 5 participants)' });

        roomManager.addParticipant(roomCode, socket.id, { name, role, roomId });
        socket.join(roomCode);

        // If this is the teacher and no spotlight is set yet, spotlight defaults to themselves
        if (role === 'teacher' && !roomManager.getSpotlight(roomCode)) {
            roomManager.setSpotlight(roomCode, socket.id);
        }

        // If teacher rejoined, cancel any no-teacher grace timer
        if (role === 'teacher' && teacherGraceTimers.has(roomCode)) {
            clearTimeout(teacherGraceTimers.get(roomCode));
            teacherGraceTimers.delete(roomCode);
            // Notify students the teacher is back
            socket.to(roomCode).emit('teacher-joined');
        }

        const existingParticipants = roomManager
            .getParticipants(roomCode)
            .filter((p) => p.socketId !== socket.id);

        const currentSpotlight = roomManager.getSpotlight(roomCode);
        const teacherPresent = !!roomManager.getTeacherSocketId(roomCode);

        socket.to(roomCode).emit('participant-joined', { socketId: socket.id, name, role });
        console.log(`[Room ${roomCode}] ${name} joined. Total: ${currentCount + 1}`);

        // If student joins and no teacher present, start a grace timer for this student
        if (role === 'student' && !teacherPresent) {
            console.log(`[Room ${roomCode}] Student joined with no teacher — grace timer started`);
            if (!teacherGraceTimers.has(roomCode)) {
                io.to(roomCode).emit('teacher-disconnected', { graceSeconds: TEACHER_GRACE_MS / 1000 });
                const timer = setTimeout(async () => {
                    teacherGraceTimers.delete(roomCode);
                    console.log(`[Room ${roomCode}] Grace expired (no teacher) — ending room`);
                    if (roomId) await endRoom(roomCode, roomId);
                    else io.to(roomCode).emit('room-ended');
                }, TEACHER_GRACE_MS);
                teacherGraceTimers.set(roomCode, timer);
            }
        }

        callback({ success: true, roomId, roomName: roomName || roomCode, existingParticipants, currentSpotlight, teacherPresent });
    });

    // ── WebRTC Signaling ───────────────────────────────────────────────────
    socket.on('signal', ({ to, signal }) => {
        io.to(to).emit('signal', { from: socket.id, signal });
    });

    // ── Mute/Unmute participant (teacher only) ─────────────────────────────
    socket.on('mute-participant', ({ targetSocketId, muted }) => {
        io.to(targetSocketId).emit('force-mute', { muted, byTeacher: true });
        // Notify room about mute state change (for UI indicators)
        const info = roomManager.getParticipantInfo(socket.id);
        if (info) {
            const roomCode = roomManager.getParticipantRoom(socket.id);
            socket.to(roomCode).emit('participant-mute-changed', { socketId: targetSocketId, muted });
        }
    });

    // ── Spotlight Change (teacher → broadcast to all) ───────────────────────
    socket.on('spotlight-change', ({ roomCode, spotlightSocketId }) => {
        roomManager.setSpotlight(roomCode, spotlightSocketId);
        io.to(roomCode).emit('spotlight-changed', { spotlightSocketId });
    });

    // ── Chat Message ───────────────────────────────────────────────────────
    socket.on('chat-message', async ({ roomCode, roomId, name, message }) => {
        const payload = { socketId: socket.id, name, message, timestamp: new Date().toISOString() };
        io.to(roomCode).emit('chat-message', payload);
        try {
            await insforge.database.from('messages').insert([{ room_id: roomId, sender_name: name, content: message }]);
        } catch (err) { console.error('Failed to persist message:', err); }
    });

    // ── End Room (teacher intentional) ────────────────────────────────────
    socket.on('end-room', async ({ roomCode, roomId }) => {
        if (teacherGraceTimers.has(roomCode)) {
            clearTimeout(teacherGraceTimers.get(roomCode));
            teacherGraceTimers.delete(roomCode);
        }
        await endRoom(roomCode, roomId);
    });

    // ── Chat System ────────────────────────────────────────────────────────
    socket.on('chat:join', ({ conversationId }) => {
        socket.join(`chat:${conversationId}`);
    });

    socket.on('chat:leave', ({ conversationId }) => {
        socket.leave(`chat:${conversationId}`);
    });

    socket.on('chat:send', async ({ conversationId, senderId, senderName, senderRole, content, mediaUrl, mediaType, mediaName }) => {
        try {
            const { rows } = await db.query(
                `INSERT INTO chat_messages (conversation_id, sender_id, sender_name, sender_role, content, media_url, media_type, media_name)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
                [conversationId, senderId, senderName || '', senderRole || 'student',
                 content || null, mediaUrl || null, mediaType || null, mediaName || null]
            );
            const msg = rows[0];
            io.to(`chat:${conversationId}`).emit('chat:message', msg);
            // Also push to user sockets not currently in the conversation room
            const { rows: participants } = await db.query(
                `SELECT user_id FROM chat_participants WHERE conversation_id = $1 AND user_id != $2`,
                [conversationId, senderId]
            );
            for (const p of participants) {
                const socketId = userSockets.get(p.user_id);
                if (socketId) io.to(socketId).emit('chat:notification', { conversationId, message: msg });
            }
        } catch (err) {
            console.error('[chat:send] error:', err.message);
        }
    });

    socket.on('chat:typing', ({ conversationId, senderName }) => {
        socket.to(`chat:${conversationId}`).emit('chat:typing', { senderName });
    });

    socket.on('chat:react', async ({ messageId, userId, emoji, conversationId }) => {
        try {
            const { rows } = await db.query('SELECT reactions FROM chat_messages WHERE id = $1', [messageId]);
            if (!rows.length) return;
            const reactions = rows[0].reactions || {};
            if (!reactions[emoji]) reactions[emoji] = [];
            const idx = reactions[emoji].indexOf(userId);
            if (idx >= 0) reactions[emoji].splice(idx, 1); else reactions[emoji].push(userId);
            if (reactions[emoji].length === 0) delete reactions[emoji];
            await db.query('UPDATE chat_messages SET reactions = $1 WHERE id = $2', [JSON.stringify(reactions), messageId]);
            io.to(`chat:${conversationId}`).emit('chat:reaction', { messageId, reactions });
        } catch (err) {
            console.error('[chat:react] error:', err.message);
        }
    });

    // ── Chat: Register user socket (extend existing register-user) ─────────
    socket.on('chat:register', (userId) => {
        if (userId) {
            chatSockets.set(userId, socket.id);
            userSockets.set(userId, socket.id);
        }
    });

    // ── Chat: Delete message — broadcast to conversation room ──────────────
    socket.on('chat:delete', ({ messageId, conversationId }) => {
        io.to(`chat:${conversationId}`).emit('chat:deleted', { messageId, conversationId });
    });

    // ── Leave / Disconnect ─────────────────────────────────────────────────
    const handleLeave = (intentional = false) => {
        // Remove from userSockets if registered
        for (const [userId, sId] of userSockets.entries()) {
            if (sId === socket.id) {
                userSockets.delete(userId);
                break;
            }
        }
        // Remove from chatSockets if registered
        for (const [userId, sId] of chatSockets.entries()) {
            if (sId === socket.id) {
                chatSockets.delete(userId);
                break;
            }
        }

        const roomCode = roomManager.getParticipantRoom(socket.id);
        if (!roomCode) return;

        const info = roomManager.getParticipantInfo(socket.id);
        const { wasTeacher } = roomManager.removeParticipant(socket.id);
        socket.to(roomCode).emit('participant-left', { socketId: socket.id });
        console.log(`[-] ${info?.name || socket.id} left ${roomCode}`);

        // If the spotlighted person left, fall back to teacher (or clear spotlight)
        const currentSpotlight = roomManager.getSpotlight(roomCode);
        if (currentSpotlight === socket.id) {
            const teacherSocketId = roomManager.getTeacherSocketId(roomCode);
            const fallback = teacherSocketId || null;
            if (fallback) roomManager.setSpotlight(roomCode, fallback);
            else roomManager.clearSpotlight(roomCode);
            io.to(roomCode).emit('spotlight-changed', { spotlightSocketId: fallback });
        }

        // Teacher disconnect: start grace period
        if (wasTeacher && !intentional) {
            const roomId = info?.roomId;
            console.log(`[Room ${roomCode}] Teacher disconnected — ${TEACHER_GRACE_MS / 1000}s grace period started`);
            io.to(roomCode).emit('teacher-disconnected', { graceSeconds: TEACHER_GRACE_MS / 1000 });

            const timer = setTimeout(async () => {
                teacherGraceTimers.delete(roomCode);
                console.log(`[Room ${roomCode}] Grace period expired — ending room`);
                if (roomId) await endRoom(roomCode, roomId);
                else io.to(roomCode).emit('room-ended');
            }, TEACHER_GRACE_MS);

            teacherGraceTimers.set(roomCode, timer);
        }
    };

    socket.on('leave-room', () => handleLeave(true));
    socket.on('disconnect', () => handleLeave(false));
});

server.listen(PORT, async () => {
    // Auto-migrations
    try {
        await db.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE`);
        console.log('[migrate] chat_messages.is_deleted ready');
    } catch (err) {
        console.warn('[migrate] is_deleted column:', err.message);
    }
    try {
        await db.query(`ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS chat_allowed BOOLEAN DEFAULT FALSE`);
        console.log('[migrate] user_roles.chat_allowed ready');
    } catch (err) {
        console.warn('[migrate] chat_allowed column:', err.message);
    }
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS chat_requests (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                student_id TEXT NOT NULL UNIQUE,
                student_name TEXT,
                student_email TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('[migrate] chat_requests table ready');
    } catch (err) {
        console.warn('[migrate] chat_requests table:', err.message);
    }
    console.log(`🚀 ClassMeet server running on port ${PORT}`);
    console.log(`   InsForge: ${process.env.INSFORGE_BASE_URL}`);
    console.log(`   CORS: ${CLIENT_URL}`);
});
