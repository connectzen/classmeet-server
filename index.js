require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const crypto = require('crypto');
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

// Room quiz state: roomCode -> { activeQuizId, quiz, submissions: [{ submissionId, studentId, studentName, score }] }
const roomQuizState = new Map();

// User ID to Socket ID mapping for direct messaging
const userSockets = new Map();
const onlineUserIds = new Set();
const lastSeenByUserId = new Map();

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
const ADMIN_EMAILS = new Set(
    (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);

async function isAdminUser(userId, email) {
    if (ADMIN_USER_IDS.has(userId)) return true;
    if (ADMIN_EMAILS.size === 0) return false;
    // Check directly supplied email (passed from client auth session)
    if (email && ADMIN_EMAILS.has(email.toLowerCase())) return true;
    try {
        // Fallback: look up email from user_roles table
        const { rows } = await db.query('SELECT email FROM user_roles WHERE user_id = $1', [userId]);
        if (rows.length > 0 && rows[0].email && ADMIN_EMAILS.has(rows[0].email.toLowerCase())) {
            return true;
        }
    } catch { /* fall through */ }
    return false;
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/is-admin/:userId', async (req, res) => {
    res.json({ isAdmin: await isAdminUser(req.params.userId, req.query.email) });
});

app.get('/api/user-role/:userId', async (req, res) => {
    const { userId } = req.params;
    const { email } = req.query;
    if (await isAdminUser(userId, email)) {
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
            SELECT user_id, name, email, created_at, avatar_url
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
        io.emit('dashboard:data-changed');
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
        io.emit('dashboard:data-changed');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/students', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT ur.user_id, ur.name, ur.email, ur.created_at, ur.avatar_url,
                   COUNT(se.id)::int AS enrollment_count,
                   COALESCE(ur.chat_allowed, false) AS chat_allowed
            FROM user_roles ur
            LEFT JOIN student_enrollments se ON se.user_id = ur.user_id::text
            WHERE ur.role = 'student'
            GROUP BY ur.user_id, ur.name, ur.email, ur.created_at, ur.avatar_url, ur.chat_allowed
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
        io.emit('dashboard:data-changed');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/all-users', async (req, res) => {
    try {
        const { rows } = await db.query("SELECT user_id as id, name, email, role, avatar_url FROM user_roles");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Chat partners: who can this user DM? (role-based)
app.get('/api/chat/partners/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const { rows: me } = await db.query(
            'SELECT role, assigned_by FROM user_roles WHERE user_id = $1',
            [userId]
        );
        const myRole = me[0]?.role;
        const myAssignedBy = me[0]?.assigned_by;
        const isAdmin = await isAdminUser(userId);

        if (isAdmin) {
            const { rows } = await db.query("SELECT user_id as id, name, email, role, avatar_url FROM user_roles ORDER BY name");
            return res.json(rows);
        }
        if (myRole === 'member') {
            const { rows } = await db.query(
                "SELECT user_id as id, name, email, role, avatar_url FROM user_roles WHERE assigned_by = $1 ORDER BY name",
                [userId]
            );
            return res.json(rows);
        }
        if (myRole === 'teacher') {
            const { rows: myStudents } = await db.query(
                "SELECT user_id as id, name, email, role, avatar_url FROM user_roles WHERE assigned_by = $1 AND role = 'student'",
                [userId]
            );
            const partnerIds = myStudents.map(r => r.id);
            if (myAssignedBy) {
                const { rows: memberRow } = await db.query(
                    "SELECT user_id as id, name, email, role, avatar_url FROM user_roles WHERE user_id = $1",
                    [myAssignedBy]
                );
                if (memberRow.length && !partnerIds.includes(memberRow[0].id)) partnerIds.push(memberRow[0].id);
            }
            if (partnerIds.length === 0) return res.json([]);
            const placeholders = partnerIds.map((_, i) => `$${i + 1}`).join(',');
            const { rows } = await db.query(
                `SELECT user_id as id, name, email, role, avatar_url FROM user_roles WHERE user_id IN (${placeholders}) ORDER BY name`,
                partnerIds
            );
            return res.json(rows);
        }
        if (myRole === 'student') {
            if (!myAssignedBy) return res.json([]);
            const { rows } = await db.query(
                "SELECT user_id as id, name, email, role, avatar_url FROM user_roles WHERE user_id = $1",
                [myAssignedBy]
            );
            return res.json(rows);
        }
        res.json([]);
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

        // Filter out admins and assigned users (rejected users are deleted, not stored)
        const pending = authUsers
            .filter(u => !ADMIN_USER_IDS.has(u.id) && !assignedIds.has(u.id))
            .map(u => ({
                id:         u.id,
                name:       u.profile?.name || u.name || '',
                email:      u.email || '',
                created_at: u.created_at || u.createdAt || null,
            }));

        const pendingIds = pending.map(p => p.id);
        let onboardingMap = {};
        if (pendingIds.length > 0) {
            const { rows: onboardingRows } = await db.query(
                'SELECT user_id, role_interest, areas_of_interest FROM user_onboarding WHERE user_id = ANY($1)',
                [pendingIds]
            );
            onboardingRows.forEach(r => {
                onboardingMap[r.user_id] = { role_interest: r.role_interest, areas_of_interest: r.areas_of_interest || '' };
            });
        }
        const pendingWithRole = pending.map(p => ({
            ...p,
            role_interest: onboardingMap[p.id]?.role_interest || null,
            areas_of_interest: onboardingMap[p.id]?.areas_of_interest || null,
        }));

        res.json(pendingWithRole);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Onboarding (new users: store preferences only; do NOT assign role — invite users use claim-invite) ───────
app.post('/api/onboarding', async (req, res) => {
    const { userId, name, email, roleInterest, areasOfInterest, currentSituation, goals } = req.body;
    if (!userId || !roleInterest) return res.status(400).json({ error: 'userId and roleInterest are required' });
    const role = roleInterest === 'member' || roleInterest === 'teacher' || roleInterest === 'student' ? roleInterest : 'student';
    try {
        await db.query(
            `INSERT INTO user_onboarding (user_id, role_interest, areas_of_interest, current_situation, goals, onboarding_completed)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             ON CONFLICT (user_id) DO UPDATE SET
             role_interest = EXCLUDED.role_interest, areas_of_interest = EXCLUDED.areas_of_interest,
             current_situation = EXCLUDED.current_situation, goals = EXCLUDED.goals, onboarding_completed = TRUE`,
            [userId, role, areasOfInterest || '', currentSituation || '', goals || '']
        );
        io.emit('admin:refresh', { type: 'pending' });
        io.emit('dashboard:data-changed');
        res.json({ success: true, role: 'pending' });
    } catch (err) {
        console.error('[onboarding]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Invite links (Member: student + teacher; Teacher: student only) ───────
async function getRoleForUser(userId) {
    if (await isAdminUser(userId)) return 'admin';
    const { rows } = await db.query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
    return rows.length > 0 ? rows[0].role : null;
}

app.post('/api/invite-links', async (req, res) => {
    const { role, createdBy } = req.body;
    if (!createdBy || !role) return res.status(400).json({ error: 'createdBy and role are required' });
    const allowedRole = role === 'student' || role === 'teacher' ? role : null;
    if (!allowedRole) return res.status(400).json({ error: 'role must be student or teacher' });
    try {
        const creatorRole = await getRoleForUser(createdBy);
        if (creatorRole === 'member') {
            // Member can create student or teacher invite
        } else if (creatorRole === 'teacher') {
            if (allowedRole !== 'student') return res.status(403).json({ error: 'Teachers can only create student invite links' });
        } else {
            return res.status(403).json({ error: 'Only Members and Teachers can create invite links' });
        }
        // Create-or-return: reuse existing link if one exists (links are unlimited use)
        const { rows: existing } = await db.query(
            'SELECT id, token FROM invite_links WHERE created_by = $1 AND role = $2 LIMIT 1',
            [createdBy, allowedRole]
        );
        const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const base = baseUrl.replace(/\/$/, '');
        if (existing.length > 0) {
            const url = `${base}?invite=${existing[0].token}`;
            return res.json({ url, token: existing[0].token });
        }
        const token = crypto.randomBytes(24).toString('hex');
        await db.query(
            'INSERT INTO invite_links (token, role, created_by) VALUES ($1, $2, $3)',
            [token, allowedRole, createdBy]
        );
        const url = `${base}?invite=${token}`;
        res.json({ url, token });
    } catch (err) {
        console.error('[invite-links]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/invite-links/regenerate', async (req, res) => {
    const { createdBy, role } = req.body;
    if (!createdBy || !role) return res.status(400).json({ error: 'createdBy and role are required' });
    const allowedRole = role === 'student' || role === 'teacher' ? role : null;
    if (!allowedRole) return res.status(400).json({ error: 'role must be student or teacher' });
    try {
        const creatorRole = await getRoleForUser(createdBy);
        if (creatorRole === 'member') { /* ok */ } else if (creatorRole === 'teacher') {
            if (allowedRole !== 'student') return res.status(403).json({ error: 'Teachers can only regenerate student invite links' });
        } else {
            return res.status(403).json({ error: 'Only Members and Teachers can regenerate invite links' });
        }
        const { rows } = await db.query(
            'SELECT id FROM invite_links WHERE created_by = $1 AND role = $2 ORDER BY created_at DESC LIMIT 1',
            [createdBy, allowedRole]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'No invite link to regenerate' });
        const newToken = crypto.randomBytes(24).toString('hex');
        await db.query('UPDATE invite_links SET token = $1 WHERE id = $2', [newToken, rows[0].id]);
        const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const url = `${baseUrl.replace(/\/$/, '')}?invite=${newToken}`;
        res.json({ url, token: newToken });
    } catch (err) {
        console.error('[invite-links regenerate]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/invite-links', async (req, res) => {
    const { createdBy } = req.query;
    if (!createdBy) return res.status(400).json({ error: 'createdBy is required' });
    try {
        const { rows } = await db.query(
            `SELECT il.id, il.token, il.role, il.created_at,
              (SELECT COUNT(*)::int FROM invite_link_claims WHERE invite_link_id = il.id) AS claim_count
             FROM invite_links il WHERE il.created_by = $1 ORDER BY il.created_at DESC`,
            [createdBy]
        );
        const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const base = baseUrl.replace(/\/$/, '');
        res.json(rows.map(r => ({ ...r, url: `${base}?invite=${r.token}`, claim_count: r.claim_count || 0 })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/claim-invite', async (req, res) => {
    const { token, userId, name, email } = req.body;
    if (!token || !userId) return res.status(400).json({ error: 'token and userId are required' });
    try {
        const { rows } = await db.query(
            'SELECT id, role, created_by FROM invite_links WHERE token = $1',
            [token]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });
        const { id: inviteLinkId, role, created_by: assignedBy } = rows[0];
        await db.query(
            `INSERT INTO user_roles (user_id, role, name, email, assigned_by) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, name = EXCLUDED.name, email = EXCLUDED.email, assigned_by = EXCLUDED.assigned_by`,
            [userId, role, name || '', email || '', assignedBy]
        );
        await db.query(
            'INSERT INTO invite_link_claims (invite_link_id, user_id) VALUES ($1, $2) ON CONFLICT (invite_link_id, user_id) DO NOTHING',
            [inviteLinkId, userId]
        );
        io.emit('admin:refresh', { type: 'pending' });
        io.emit('dashboard:data-changed');
        res.json({ success: true, role });
    } catch (err) {
        console.error('[claim-invite]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Reject a pending user (admin only) — DELETE user entirely from backend ──
app.post('/api/reject-user/:userId', async (req, res) => {
    const { userId } = req.params;
    const { adminId } = req.body;
    if (!adminId || !(await isAdminUser(adminId))) return res.status(403).json({ error: 'Admin required' });
    try {
        // 1. Cascade-delete any chat content (storage files, tombstone messages)
        await cascadeDeleteUserContent(userId);

        // 2. Delete from our database (user_onboarding, invite claims, user_roles, enrollments, quiz, chat)
        await db.query('DELETE FROM user_onboarding WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM invite_link_claims WHERE user_id = $1', [userId]);
        await db.query('UPDATE invite_links SET used_by = NULL, used_at = NULL WHERE used_by = $1', [userId]);
        await db.query('DELETE FROM student_enrollments WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM quiz_submissions WHERE student_id = $1', [userId]);
        await db.query('DELETE FROM chat_participants WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);

        // 3. Delete from InsForge auth (removes user from auth system entirely)
        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey  = process.env.INSFORGE_API_KEY;
        if (baseUrl && apiKey) {
            try {
                const authRes = await fetch(`${baseUrl}/api/auth/users`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: [userId] }),
                });
                if (!authRes.ok) console.warn('[reject] Auth delete failed:', await authRes.text());
            } catch (authErr) {
                console.warn('[reject] Could not delete auth user:', authErr.message);
            }
        }

        io.emit('admin:refresh', { type: 'pending' });
        io.emit('dashboard:data-changed');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Approve a pending user ────────────────────────────────────────────────
const ALLOWED_ROLES = ['member', 'teacher', 'student'];
function normalizeRole(r) {
    return r && ALLOWED_ROLES.includes(r) ? r : 'student';
}

app.post('/api/approve-user/:userId', async (req, res) => {
    const { userId } = req.params;
    const { name, email, role = 'student' } = req.body;
    const assignedRole = normalizeRole(role);
    try {
        await db.query(
            `INSERT INTO user_roles (user_id, role, name, email)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, name = EXCLUDED.name`,
            [userId, assignedRole, name || '', email || '']
        );
        io.emit('admin:refresh', { type: 'pending' });
        io.emit('dashboard:data-changed');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin: assign/edit user role ──────────────────────────────────────────
app.patch('/api/user-role/:userId', async (req, res) => {
    const { userId } = req.params;
    const { role, adminId } = req.body;
    if (!adminId || !(await isAdminUser(adminId))) return res.status(403).json({ error: 'Admin required' });
    const assignedRole = normalizeRole(role);
    try {
        const { rowCount } = await db.query(
            'UPDATE user_roles SET role = $1 WHERE user_id = $2',
            [assignedRole, userId]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'User not found' });
        io.emit('admin:refresh', { type: 'teachers' });
        io.emit('admin:refresh', { type: 'students' });
        io.emit('admin:refresh', { type: 'members' });
        io.emit('dashboard:data-changed');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Members list (admin) ──────────────────────────────────────────────────
app.get('/api/members', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT user_id, name, email, created_at, avatar_url
            FROM user_roles
            WHERE role = 'member'
            ORDER BY created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/members', async (req, res) => {
    const { name, email, tempPassword, adminId } = req.body;
    if (!adminId || !(await isAdminUser(adminId))) return res.status(403).json({ error: 'Admin required' });
    if (!name || !email || !tempPassword) return res.status(400).json({ error: 'Name, email, and tempPassword are required' });
    try {
        const { data: authData, error: authError } = await insforge.auth.signUp({
            email,
            password: tempPassword,
            options: { data: { name } },
        });
        if (authError) throw authError;
        await insforge.auth.signOut();
        const userId = authData.user.id;
        await db.query(
            "INSERT INTO user_roles (user_id, role, name, email) VALUES ($1, 'member', $2, $3)",
            [userId, name, email]
        );
        io.emit('admin:refresh', { type: 'members' });
        io.emit('dashboard:data-changed');
        res.json({ id: userId, name, email });
    } catch (err) {
        console.error('[REST] Error creating member:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Admin stats (counts + live guest; admin only) ────────────────────────
let liveGuestCount = 0;
function getLiveGuestCount() { return liveGuestCount; }
function incrementGuestCount() { liveGuestCount += 1; }
function decrementGuestCount() { liveGuestCount = Math.max(0, liveGuestCount - 1); }

app.get('/api/admin/stats', async (req, res) => {
    const { adminId } = req.query;
    if (!adminId || !(await isAdminUser(adminId))) return res.status(403).json({ error: 'Admin required' });
    try {
        const { rows: counts } = await db.query(`
            SELECT role, COUNT(*)::int AS c FROM user_roles WHERE role IN ('member', 'teacher', 'student') GROUP BY role
        `);
        const byRole = { member: 0, teacher: 0, student: 0 };
        counts.forEach(r => { byRole[r.role] = r.c; });
        res.json({
            membersCount: byRole.member,
            teachersCount: byRole.teacher,
            studentsCount: byRole.student,
            liveGuestCount: getLiveGuestCount(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin health (admin only) ─────────────────────────────────────────────
app.get('/api/admin/health', async (req, res) => {
    const { adminId } = req.query;
    if (!adminId || !(await isAdminUser(adminId))) return res.status(403).json({ error: 'Admin required' });
    try {
        await db.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (err) {
        res.status(503).json({ status: 'degraded', error: err.message });
    }
});

// ── Guest rooms (Member only: create, join, end) ─────────────────────────
app.post('/api/guest-rooms', async (req, res) => {
    const { hostId } = req.body;
    if (!hostId) return res.status(400).json({ error: 'hostId required' });
    try {
        const role = await getRoleForUser(hostId);
        if (role !== 'member') return res.status(403).json({ error: 'Only members can create guest rooms' });
        const code = crypto.randomBytes(3).toString('hex').toUpperCase();
        const title = `Guest Room ${code}`;
        const { data: roomData, error: roomError } = await insforge.database
            .from('rooms')
            .insert([{ code, name: title, host_id: hostId, max_participants: 100 }])
            .select();
        if (roomError || !roomData?.[0]) return res.status(500).json({ error: roomError?.message || 'Failed to create room' });
        const roomId = roomData[0].id;
        const { rows } = await db.query(
            'INSERT INTO guest_rooms (room_id, room_code, host_id) VALUES ($1, $2, $3) RETURNING id, room_id, room_code, created_at',
            [roomId, code, hostId]
        );
        const guestRoom = rows[0];
        const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const url = `${baseUrl.replace(/\/$/, '')}?guest=${code}`;
        res.json({ ...guestRoom, url, roomName: title });
    } catch (err) {
        console.error('[guest-rooms]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/guest-rooms/join/:code', async (req, res) => {
    const { code } = req.params;
    try {
        const { rows } = await db.query(
            'SELECT id, room_id, room_code, host_id FROM guest_rooms WHERE room_code = $1 AND ended_at IS NULL',
            [code.toUpperCase()]
        );
        if (!rows.length) return res.status(404).json({ error: 'Invalid or expired guest link' });
        res.json({ roomId: rows[0].room_id, roomCode: rows[0].room_code, roomName: `Guest Room ${rows[0].room_code}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/guest-rooms/:id', async (req, res) => {
    const { id } = req.params;
    const { hostId } = req.body;
    if (!hostId) return res.status(400).json({ error: 'hostId required' });
    try {
        const role = await getRoleForUser(hostId);
        if (role !== 'member') return res.status(403).json({ error: 'Only members can end guest rooms' });
        const { rows } = await db.query('SELECT * FROM guest_rooms WHERE id = $1 AND host_id = $2', [id, hostId]);
        if (!rows.length) return res.status(404).json({ error: 'Guest room not found' });
        const gr = rows[0];
        await db.query('UPDATE guest_rooms SET ended_at = NOW() WHERE id = $1', [id]);
        try { await endRoom(gr.room_code, gr.room_id); } catch (e) { /* ignore */ }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Profile avatar upload (server-side so upload works regardless of bucket policy) ──
app.post('/api/profile/upload-avatar', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const userId = req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey  = process.env.INSFORGE_API_KEY;
        if (!baseUrl || !apiKey) return res.status(500).json({ error: 'Storage not configured' });
        const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
        const filename = `avatar-${userId}.${ext || 'jpg'}`;

        const stratRes = await fetch(`${baseUrl}/api/storage/buckets/avatars/upload-strategy`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, contentType: req.file.mimetype, size: req.file.size }),
        });
        if (!stratRes.ok) {
            const errBody = await stratRes.text();
            let errMsg;
            try { const j = JSON.parse(errBody); errMsg = j.message || j.error || errBody; } catch (_) { errMsg = errBody; }
            return res.status(500).json({ error: 'Strategy failed: ' + (errMsg || stratRes.statusText) });
        }
        const strategy = await stratRes.json();

        const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
        let publicUrl;

        if (strategy.method === 'direct') {
            const uploadUrl = strategy.uploadUrl.startsWith('http') ? strategy.uploadUrl : `${baseUrl}${strategy.uploadUrl}`;
            const form = new FormData();
            form.append('file', fileBlob, req.file.originalname);
            const upRes = await fetch(uploadUrl, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: form,
            });
            if (!upRes.ok) {
                const errBody = await upRes.text();
                return res.status(500).json({ error: 'Upload failed: ' + (errBody || upRes.statusText) });
            }
            publicUrl = uploadUrl;
        } else {
            const form = new FormData();
            for (const [k, v] of Object.entries(strategy.fields || {})) form.append(k, String(v));
            form.append('file', fileBlob, req.file.originalname);
            const upRes = await fetch(strategy.uploadUrl, { method: 'POST', body: form });
            if (!upRes.ok) {
                const errBody = await upRes.text();
                return res.status(500).json({ error: 'S3 upload failed: ' + (errBody || upRes.statusText) });
            }
            if (strategy.confirmRequired && strategy.confirmUrl) {
                const confirmUrl = strategy.confirmUrl.startsWith('http') ? strategy.confirmUrl : `${baseUrl}${strategy.confirmUrl}`;
                await fetch(confirmUrl, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ size: req.file.size, contentType: req.file.mimetype }),
                });
            }
            publicUrl = `${baseUrl}/api/storage/buckets/avatars/objects/${strategy.key}`;
        }

        res.json({ url: publicUrl, name: req.file.originalname, type: req.file.mimetype });
    } catch (err) {
        console.error('[profile/upload-avatar]', err.message);
        res.status(500).json({ error: err.message || 'Upload failed' });
    }
});

// ── Sync profile name and avatar_url from InsForge to user_roles ───────────
// Called by the client after insforge.auth.setProfile() succeeds
app.patch('/api/profile/sync-name', async (req, res) => {
    const { userId, name, avatar_url } = req.body;
    if (!userId || !name) return res.status(400).json({ error: 'userId and name are required' });
    try {
        const { rowCount } = await db.query(
            `UPDATE user_roles SET name = $1, avatar_url = $2 WHERE user_id = $3`,
            [name.trim(), avatar_url || null, userId]
        );
        // Emit refresh so dashboards show updated name/avatar immediately
        io.emit('admin:refresh', { type: 'students' });
        io.emit('admin:refresh', { type: 'teachers' });
        io.emit('dashboard:data-changed');
        res.json({ success: true, updated: rowCount > 0 });
    } catch (err) {
        console.error('[profile/sync-name]', err.message);
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

        // For DMs, fetch the other participant's info (current name/role from user_roles)
        const enriched = await Promise.all(convRows.map(async (conv) => {
            if (conv.type === 'dm') {
                const { rows: others } = await db.query(
                    `SELECT cp.user_id, COALESCE(ur.name, cp.user_name) AS user_name, COALESCE(ur.role, cp.user_role) AS user_role, ur.avatar_url
                     FROM chat_participants cp
                     LEFT JOIN user_roles ur ON ur.user_id = cp.user_id
                     WHERE cp.conversation_id = $1 AND cp.user_id != $2 LIMIT 1`,
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

// ─── ADMIN MEETINGS ──────────────────────────────────────────────────────

// List all rooms (admin use — for meeting target picker)
app.get('/api/admin/all-rooms', async (req, res) => {
    const { data, error } = await insforge.database
        .from('rooms')
        .select('id, code, name, host_id')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// Create an admin meeting (admin only)
app.post('/api/admin/meetings', async (req, res) => {
    const { title, description, scheduledAt, maxParticipants = 30, targets, createdBy } = req.body;
    if (!title || !scheduledAt || !targets || !createdBy) return res.status(400).json({ error: 'Missing required fields' });
    if (!ADMIN_USER_IDS.has(createdBy)) return res.status(403).json({ error: 'Admin only' });
    try {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        const meetingId = require('crypto').randomUUID();

        // Create the room in InsForge DB with the specified max_participants
        const { data: roomData, error: roomError } = await insforge.database
            .from('rooms')
            .insert([{ code, name: title, host_id: createdBy, max_participants: Number(maxParticipants) }])
            .select();
        if (roomError || !roomData?.[0]) return res.status(500).json({ error: roomError?.message || 'Failed to create room' });
        const roomId = roomData[0].id;

        // Insert admin_meeting record
        await db.query(
            `INSERT INTO admin_meetings (id, room_code, room_id, title, description, scheduled_at, created_by, max_participants)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [meetingId, code, roomId, title, description || '', scheduledAt, createdBy, Number(maxParticipants)]
        );

        // Insert target rows
        for (const target of targets) {
            await db.query(
                `INSERT INTO admin_meeting_targets (meeting_id, target_type, target_value) VALUES ($1, $2, $3)`,
                [meetingId, target.type, target.value]
            );
        }

        // Cache max_participants so first joiner doesn't need a DB lookup
        roomManager.setMaxParticipants(code, Number(maxParticipants));

        // Notify all connected clients
        io.emit('admin:meeting-created', { meetingId });

        res.json({ id: meetingId, code, roomId, title });
    } catch (err) {
        console.error('[admin/meetings POST]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// List all admin meetings (for admin dashboard)
app.get('/api/admin/meetings', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT am.*,
                   COALESCE(json_agg(json_build_object('type', amt.target_type, 'value', amt.target_value) ORDER BY amt.id)
                            FILTER (WHERE amt.target_type IS NOT NULL), '[]') AS targets
            FROM admin_meetings am
            LEFT JOIN admin_meeting_targets amt ON amt.meeting_id = am.id
            GROUP BY am.id
            ORDER BY am.scheduled_at ASC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get meetings targeted at a specific user (for Landing banner)
app.get('/api/admin/meetings/for-user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        // Resolve user role
        let userRole = 'pending';
        if (ADMIN_USER_IDS.has(userId)) {
            userRole = 'admin';
        } else {
            const { rows } = await db.query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
            if (rows.length > 0) userRole = rows[0].role;
        }

        // Get user's enrolled room IDs
        const { rows: enrollments } = await db.query(
            'SELECT room_id FROM student_enrollments WHERE user_id = $1', [userId]
        );
        const enrolledRoomIds = enrollments.map(e => e.room_id);

        // Find active meetings with at least one matching target
        let queryText;
        let queryParams;
        if (enrolledRoomIds.length > 0) {
            queryText = `
                SELECT DISTINCT am.*
                FROM admin_meetings am
                JOIN admin_meeting_targets amt ON amt.meeting_id = am.id
                WHERE am.is_active = true
                AND (
                    (amt.target_type = 'role' AND amt.target_value = $1)
                    OR (amt.target_type = 'user' AND amt.target_value = $2)
                    OR (amt.target_type = 'room' AND amt.target_value = ANY($3::text[]))
                )
                ORDER BY am.scheduled_at ASC
            `;
            queryParams = [userRole, userId, enrolledRoomIds];
        } else {
            queryText = `
                SELECT DISTINCT am.*
                FROM admin_meetings am
                JOIN admin_meeting_targets amt ON amt.meeting_id = am.id
                WHERE am.is_active = true
                AND (
                    (amt.target_type = 'role' AND amt.target_value = $1)
                    OR (amt.target_type = 'user' AND amt.target_value = $2)
                )
                ORDER BY am.scheduled_at ASC
            `;
            queryParams = [userRole, userId];
        }

        const { rows: meetings } = await db.query(queryText, queryParams);
        res.json(meetings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete an admin meeting (hard delete from DB + end room)
app.delete('/api/admin/meetings/:meetingId', async (req, res) => {
    const { meetingId } = req.params;
    const { adminId } = req.body;
    if (!adminId || !ADMIN_USER_IDS.has(adminId)) return res.status(403).json({ error: 'Admin only' });
    try {
        const { rows } = await db.query('SELECT * FROM admin_meetings WHERE id = $1', [meetingId]);
        if (!rows.length) return res.status(404).json({ error: 'Meeting not found' });
        const meeting = rows[0];

        // Hard delete — cascade removes targets too
        await db.query('DELETE FROM admin_meetings WHERE id = $1', [meetingId]);

        // Close the room if the meeting was still active
        if (meeting.is_active) {
            try { await endRoom(meeting.room_code, meeting.room_id); } catch (e) { /* ignore if already gone */ }
        }

        // Notify all clients
        io.emit('admin:meeting-ended', { meetingId });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit an admin meeting (update fields + replace targets)
app.put('/api/admin/meetings/:meetingId', async (req, res) => {
    const { meetingId } = req.params;
    const { adminId, title, description, scheduledAt, maxParticipants, targets } = req.body;
    if (!adminId || !ADMIN_USER_IDS.has(adminId)) return res.status(403).json({ error: 'Admin only' });
    if (!title || !scheduledAt) return res.status(400).json({ error: 'Title and scheduledAt are required' });
    try {
        await db.query(
            `UPDATE admin_meetings SET title=$1, description=$2, scheduled_at=$3, max_participants=$4 WHERE id=$5`,
            [title, description || '', new Date(scheduledAt).toISOString(), Number(maxParticipants) || 30, meetingId]
        );
        if (Array.isArray(targets)) {
            await db.query('DELETE FROM admin_meeting_targets WHERE meeting_id = $1', [meetingId]);
            for (const t of targets) {
                await db.query(
                    `INSERT INTO admin_meeting_targets (meeting_id, target_type, target_value) VALUES ($1, $2, $3)`,
                    [meetingId, t.type, t.value]
                );
            }
        }
        io.emit('admin:meeting-updated', { meetingId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── TEACHER SESSION IMAGE UPLOAD ─────────────────────────────────────────

// Upload session image to InsForge Storage
app.post('/api/teacher/upload-session-image', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey  = process.env.INSFORGE_API_KEY;
        const ext     = req.file.originalname.split('.').pop() || 'bin';
        const filename = `session-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

        // Step 1 — get upload strategy
        const stratRes = await fetch(`${baseUrl}/api/storage/buckets/avatars/upload-strategy`, {
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
            publicUrl = `${baseUrl}/api/storage/buckets/avatars/objects/${strategy.key}`;
        }

        res.json({ url: publicUrl, name: req.file.originalname, type: req.file.mimetype, key: strategy.key });
    } catch (err) {
        console.error('[teacher/upload-session-image]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── TEACHER SESSIONS ──────────────────────────────────────────────────────

// Create a teacher session (teacher or member; member = guest session, no targets)
app.post('/api/teacher/sessions', async (req, res) => {
    const { title, description, scheduledAt, maxParticipants = 30, targetStudentIds, createdBy, sessionImageUrl } = req.body;
    if (!title || !scheduledAt || !createdBy) return res.status(400).json({ error: 'Missing required fields' });
    try {
        const { rows: roleRows } = await db.query('SELECT role FROM user_roles WHERE user_id = $1', [createdBy]);
        const role = roleRows.length ? roleRows[0].role : null;
        if (!role || (role !== 'teacher' && role !== 'member')) {
            return res.status(403).json({ error: 'Teacher or member only' });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    try {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        const sessionId = require('crypto').randomUUID();

        // Create the room in InsForge DB
        const { data: roomData, error: roomError } = await insforge.database
            .from('rooms')
            .insert([{ code, name: title, host_id: createdBy, max_participants: Number(maxParticipants) }])
            .select();
        if (roomError || !roomData?.[0]) return res.status(500).json({ error: roomError?.message || 'Failed to create room' });
        const roomId = roomData[0].id;

        // Insert teacher_session record
        await db.query(
            `INSERT INTO teacher_sessions (id, room_code, room_id, title, description, scheduled_at, created_by, max_participants, session_image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [sessionId, code, roomId, title, description || '', scheduledAt, createdBy, Number(maxParticipants), sessionImageUrl || null]
        );

        // Insert target rows
        if (Array.isArray(targetStudentIds)) {
            for (const studentId of targetStudentIds) {
                await db.query(
                    `INSERT INTO teacher_session_targets (session_id, target_user_id) VALUES ($1, $2)`,
                    [sessionId, studentId]
                );
            }
        }

        roomManager.setMaxParticipants(code, Number(maxParticipants));
        io.emit('teacher:session-created', { sessionId });
        io.emit('dashboard:data-changed');
        res.json({ id: sessionId, code, roomId, title });
    } catch (err) {
        console.error('[teacher/sessions POST]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get teacher's own sessions
app.get('/api/teacher/sessions/by-host/:teacherId', async (req, res) => {
    const { teacherId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT * FROM teacher_sessions WHERE created_by = $1 ORDER BY scheduled_at ASC`,
            [teacherId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get sessions targeted at a specific student
app.get('/api/teacher/sessions/for-student/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT DISTINCT ts.*
             FROM teacher_sessions ts
             JOIN teacher_session_targets tst ON tst.session_id = ts.id
             WHERE ts.is_active = true AND tst.target_user_id = $1
             ORDER BY ts.scheduled_at ASC`,
            [userId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get session by room code (for guest landing page)
app.get('/api/session-by-code/:code', async (req, res) => {
    const code = (req.params.code || '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'Code required' });
    try {
        const { rows } = await db.query(
            `SELECT ts.id, ts.room_code, ts.room_id, ts.title, ts.description, ts.scheduled_at, ts.session_image_url, ts.created_by, ts.max_participants, ts.is_active,
             ur.name AS creator_name
             FROM teacher_sessions ts
             LEFT JOIN user_roles ur ON ur.user_id::text = ts.created_by
             WHERE UPPER(ts.room_code) = $1 AND ts.is_active = true`,
            [code]
        );
        if (!rows.length) return res.status(404).json({ error: 'Session not found' });
        const s = rows[0];
        res.json({
            id: s.id,
            room_code: s.room_code,
            room_id: s.room_id,
            title: s.title,
            description: s.description || '',
            scheduled_at: s.scheduled_at,
            session_image_url: s.session_image_url,
            created_by: s.created_by,
            max_participants: s.max_participants,
            creator_name: s.creator_name || null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get targets for a session
app.get('/api/teacher/sessions/:sessionId/targets', async (req, res) => {
    const { sessionId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT target_user_id FROM teacher_session_targets WHERE session_id = $1`,
            [sessionId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a teacher session (teacher/owner only)
app.delete('/api/teacher/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { teacherId } = req.body;
    if (!teacherId) return res.status(400).json({ error: 'teacherId required' });
    try {
        const { rows } = await db.query('SELECT * FROM teacher_sessions WHERE id = $1', [sessionId]);
        if (!rows.length) return res.status(404).json({ error: 'Session not found' });
        const session = rows[0];
        if (session.created_by !== teacherId) return res.status(403).json({ error: 'Not authorized' });

        await db.query('DELETE FROM teacher_sessions WHERE id = $1', [sessionId]);

        if (session.is_active) {
            try { await endRoom(session.room_code, session.room_id); } catch (e) { /* ignore */ }
        }

        io.emit('teacher:session-ended', { sessionId });
        io.emit('dashboard:data-changed');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update a teacher session (teacher/owner only)
app.put('/api/teacher/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { teacherId, title, description, scheduledAt, targetStudentIds, sessionImageUrl } = req.body;
    if (!teacherId || !title || !scheduledAt) return res.status(400).json({ error: 'Missing required fields' });
    try {
        // Verify ownership
        const { rows } = await db.query('SELECT * FROM teacher_sessions WHERE id = $1', [sessionId]);
        if (!rows.length) return res.status(404).json({ error: 'Session not found' });
        const session = rows[0];
        if (session.created_by !== teacherId) return res.status(403).json({ error: 'Not authorized' });

        // Update session
        await db.query(
            `UPDATE teacher_sessions SET title=$1, description=$2, scheduled_at=$3, session_image_url=$4 WHERE id=$5`,
            [title, description || '', new Date(scheduledAt).toISOString(), sessionImageUrl || null, sessionId]
        );

        // Update targets
        if (Array.isArray(targetStudentIds)) {
            await db.query('DELETE FROM teacher_session_targets WHERE session_id = $1', [sessionId]);
            for (const studentId of targetStudentIds) {
                await db.query(
                    `INSERT INTO teacher_session_targets (session_id, target_user_id) VALUES ($1, $2)`,
                    [sessionId, studentId]
                );
            }
        }

        io.emit('teacher:session-updated', { sessionId });
        io.emit('dashboard:data-changed');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── QUIZ API ─────────────────────────────────────────────────────────────

// Upload file/recording for quiz answers
app.post('/api/quiz/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
        const baseUrl = process.env.INSFORGE_BASE_URL;
        const apiKey  = process.env.INSFORGE_API_KEY;
        const ext     = req.file.originalname.split('.').pop() || 'bin';
        const filename = `quiz-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const stratRes = await fetch(`${baseUrl}/api/storage/buckets/chat-media/upload-strategy`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, contentType: req.file.mimetype, size: req.file.size }),
        });
        if (!stratRes.ok) return res.status(500).json({ error: 'Strategy failed' });
        const strategy = await stratRes.json();
        const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
        let publicUrl;
        if (strategy.method === 'direct') {
            const uploadUrl = strategy.uploadUrl.startsWith('http') ? strategy.uploadUrl : `${baseUrl}${strategy.uploadUrl}`;
            const form = new FormData();
            form.append('file', fileBlob, req.file.originalname);
            const upRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Authorization': `Bearer ${apiKey}` }, body: form });
            if (!upRes.ok) return res.status(500).json({ error: 'Upload failed' });
            publicUrl = uploadUrl;
        } else {
            const form = new FormData();
            for (const [k, v] of Object.entries(strategy.fields || {})) form.append(k, String(v));
            form.append('file', fileBlob, req.file.originalname);
            const upRes = await fetch(strategy.uploadUrl, { method: 'POST', body: form });
            if (!upRes.ok) return res.status(500).json({ error: 'S3 upload failed' });
            if (strategy.confirmRequired && strategy.confirmUrl) {
                const confirmUrl = strategy.confirmUrl.startsWith('http') ? strategy.confirmUrl : `${baseUrl}${strategy.confirmUrl}`;
                await fetch(confirmUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ size: req.file.size, contentType: req.file.mimetype }) });
            }
            publicUrl = `${baseUrl}/api/storage/buckets/chat-media/objects/${strategy.key}`;
        }
        res.json({ url: publicUrl, name: req.file.originalname, type: req.file.mimetype });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create quiz
// ── Courses CRUD (Member, Teacher, Admin) ──────────────────────────────────
app.post('/api/courses', async (req, res) => {
    const { title, description, createdBy } = req.body;
    if (!title || !createdBy) return res.status(400).json({ error: 'title and createdBy required' });
    try {
        const creatorRole = await getRoleForUser(createdBy);
        if (creatorRole !== 'member' && creatorRole !== 'teacher' && creatorRole !== 'admin') {
            return res.status(403).json({ error: 'Only members, teachers, and admins can create courses' });
        }
        const { rows } = await db.query(
            'INSERT INTO courses (title, description, created_by) VALUES ($1, $2, $3) RETURNING *',
            [title.trim(), description || null, createdBy]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/courses', async (req, res) => {
    const { createdBy } = req.query;
    if (!createdBy) return res.status(400).json({ error: 'createdBy required' });
    try {
        const { rows } = await db.query(
            'SELECT * FROM courses WHERE created_by = $1 ORDER BY created_at DESC',
            [createdBy]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/courses/:id', async (req, res) => {
    const { title, description } = req.body;
    try {
        let rows;
        if (description !== undefined) {
            rows = (await db.query(
                'UPDATE courses SET title = COALESCE($1, title), description = $2 WHERE id = $3 RETURNING *',
                [title || null, description, req.params.id]
            )).rows;
        } else {
            rows = (await db.query(
                'UPDATE courses SET title = COALESCE($1, title) WHERE id = $2 RETURNING *',
                [title || null, req.params.id]
            )).rows;
        }
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/courses/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM courses WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/courses/:id/lessons', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT * FROM lessons WHERE course_id = $1 ORDER BY order_index ASC, created_at ASC',
            [req.params.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/courses/:id/lessons', async (req, res) => {
    const { title, content, orderIndex, lessonType, videoUrl, audioUrl } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
        const order = orderIndex != null ? orderIndex : 0;
        const type = ['text', 'video', 'audio'].includes(lessonType) ? lessonType : 'text';
        const { rows } = await db.query(
            'INSERT INTO lessons (course_id, title, content, order_index, lesson_type, video_url, audio_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [req.params.id, title.trim(), content || null, order, type, videoUrl || null, audioUrl || null]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/lessons/:id', async (req, res) => {
    const { title, content, orderIndex, lessonType, videoUrl, audioUrl } = req.body;
    try {
        const updates = [];
        const params = [];
        let i = 1;
        if (title !== undefined) { updates.push(`title = $${i++}`); params.push(title); }
        if (content !== undefined) { updates.push(`content = $${i++}`); params.push(content); }
        if (orderIndex !== undefined) { updates.push(`order_index = $${i++}`); params.push(orderIndex); }
        if (lessonType !== undefined) { updates.push(`lesson_type = $${i++}`); params.push(['text', 'video', 'audio'].includes(lessonType) ? lessonType : 'text'); }
        if (videoUrl !== undefined) { updates.push(`video_url = $${i++}`); params.push(videoUrl); }
        if (audioUrl !== undefined) { updates.push(`audio_url = $${i++}`); params.push(audioUrl); }
        if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
        params.push(req.params.id);
        const { rows } = await db.query(
            `UPDATE lessons SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
            params
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/lessons/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM lessons WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/quizzes', async (req, res) => {
    const { title, roomId, courseId, timeLimitMinutes, createdBy } = req.body;
    if (!title || !createdBy) return res.status(400).json({ error: 'title and createdBy required' });
    if (!roomId && !courseId) return res.status(400).json({ error: 'Select at least a room or course' });
    const room = roomId || (courseId ? `course-only-${courseId}` : 'placeholder');
    try {
        const creatorRole = await getRoleForUser(createdBy);
        if (creatorRole !== 'member' && creatorRole !== 'teacher' && creatorRole !== 'admin') {
            return res.status(403).json({ error: 'Only members, teachers, and admins can create quizzes' });
        }
        const { rows } = await db.query(
            `INSERT INTO quizzes (title, room_id, created_by, time_limit_minutes, course_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [title.trim(), room, createdBy, timeLimitMinutes || null, courseId || null]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// List quizzes for rooms (supports ?createdBy= for teacher, ?studentId= or ?roomIds= for student)
app.get('/api/quizzes', async (req, res) => {
    const { createdBy, roomIds, studentId, status } = req.query;
    try {
        if (createdBy) {
            const { rows } = await db.query(
                `SELECT q.*, COUNT(qq.id)::int AS question_count,
                        COUNT(qs.id)::int AS submission_count
                 FROM quizzes q
                 LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id
                 LEFT JOIN quiz_submissions qs ON qs.quiz_id = q.id
                 WHERE q.created_by = $1
                 GROUP BY q.id ORDER BY q.created_at DESC`,
                [createdBy]
            );
            return res.json(rows);
        }

        // Student path: collect room IDs from both enrollments AND session targets
        let ids = [];
        if (studentId) {
            const { rows: enRows } = await db.query(
                `SELECT room_id FROM student_enrollments WHERE user_id = $1`, [studentId]
            );
            const { rows: tgtRows } = await db.query(
                `SELECT ts.room_id
                 FROM teacher_sessions ts
                 JOIN teacher_session_targets tst ON tst.session_id = ts.id
                 WHERE tst.target_user_id = $1`, [studentId]
            );
            const all = new Set([
                ...enRows.map(r => r.room_id),
                ...tgtRows.map(r => r.room_id),
            ].filter(Boolean));
            ids = [...all];
        } else if (roomIds) {
            ids = String(roomIds).split(',').filter(Boolean);
        }

        if (!ids.length) return res.json([]);
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const params = [...ids];
        // Include this student's submission status when studentId is known
        let subJoin = '', subSelect = '', subGroup = '';
        if (studentId) {
            params.push(String(studentId));
            const sp = params.length;
            subJoin   = `LEFT JOIN quiz_submissions sub ON sub.quiz_id = q.id AND sub.student_id = $${sp}`;
            subSelect = `, sub.submitted_at AS submitted_at, COALESCE(sub.teacher_final_score_override, sub.score) AS my_score`;
            subGroup  = `, sub.submitted_at, sub.score, sub.teacher_final_score_override`;
        }
        const { rows } = await db.query(
            `SELECT q.*, COUNT(qq.id)::int AS question_count${subSelect}
             FROM quizzes q
             LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id
             ${subJoin}
             WHERE q.room_id IN (${placeholders}) AND q.status = 'published'
             GROUP BY q.id${subGroup} ORDER BY q.created_at DESC`,
            params
        );
        return res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get one quiz with questions (nested: parent video questions with children)
app.get('/api/quizzes/:id', async (req, res) => {
    const { role } = req.query;
    try {
        const { rows: qRows } = await db.query('SELECT * FROM quizzes WHERE id = $1', [req.params.id]);
        if (!qRows.length) return res.status(404).json({ error: 'Not found' });
        const quiz = qRows[0];
        const { rows: all } = await db.query(
            `SELECT id, quiz_id, type, question_text, options, video_url, order_index, points, parent_question_id
             ${role === 'teacher' ? ', correct_answers' : ''}
             FROM quiz_questions WHERE quiz_id = $1 ORDER BY order_index ASC`,
            [req.params.id]
        );
        const topLevel = all.filter(q => !q.parent_question_id);
        const childrenByParent = {};
        all.filter(q => q.parent_question_id).forEach(q => {
            if (!childrenByParent[q.parent_question_id]) childrenByParent[q.parent_question_id] = [];
            childrenByParent[q.parent_question_id].push(q);
        });
        const questions = topLevel.map(q => ({
            ...q,
            children: childrenByParent[q.id] || [],
        }));
        res.json({ ...quiz, questions });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update quiz (title, timeLimitMinutes)
app.patch('/api/quizzes/:id', async (req, res) => {
    const { title, timeLimitMinutes } = req.body;
    try {
        const { rows } = await db.query(
            `UPDATE quizzes SET title = COALESCE($1, title), time_limit_minutes = $2 WHERE id = $3 RETURNING *`,
            [title || null, timeLimitMinutes ?? null, req.params.id]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Publish quiz
app.post('/api/quizzes/:id/publish', async (req, res) => {
    try {
        await db.query(`UPDATE quizzes SET status = 'published' WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unpublish quiz back to draft
app.post('/api/quizzes/:id/unpublish', async (req, res) => {
    try {
        await db.query(`UPDATE quizzes SET status = 'draft' WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete quiz
app.delete('/api/quizzes/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM quizzes WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add question to quiz
app.post('/api/quizzes/:id/questions', async (req, res) => {
    const { type, questionText, options, correctAnswers, videoUrl, orderIndex, points, parentQuestionId } = req.body;
    if (!type || !questionText) return res.status(400).json({ error: 'type and questionText required' });
    try {
        const baseWhere = parentQuestionId ? 'parent_question_id = $1' : 'parent_question_id IS NULL AND quiz_id = $1';
        const baseParams = parentQuestionId ? [parentQuestionId] : [req.params.id];
        const { rows: existing } = await db.query(
            `SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM quiz_questions WHERE ${baseWhere}`,
            baseParams
        );
        const idx = orderIndex ?? existing[0].next_index;
        const { rows } = await db.query(
            `INSERT INTO quiz_questions (quiz_id, type, question_text, options, correct_answers, video_url, order_index, points, parent_question_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [req.params.id, type, questionText.trim(), options ? JSON.stringify(options) : null,
             correctAnswers ? JSON.stringify(correctAnswers) : null, videoUrl || null, idx, points || 1, parentQuestionId || null]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update question
app.put('/api/quiz-questions/:id', async (req, res) => {
    const { type, questionText, options, correctAnswers, videoUrl, orderIndex, points } = req.body;
    try {
        const { rows } = await db.query(
            `UPDATE quiz_questions SET
                type = COALESCE($1, type),
                question_text = COALESCE($2, question_text),
                options = $3,
                correct_answers = $4,
                video_url = $5,
                order_index = COALESCE($6, order_index),
                points = COALESCE($7, points)
             WHERE id = $8 RETURNING *`,
            [type || null, questionText?.trim() || null,
             options !== undefined ? JSON.stringify(options) : null,
             correctAnswers !== undefined ? JSON.stringify(correctAnswers) : null,
             videoUrl !== undefined ? videoUrl : null,
             orderIndex ?? null, points || null, req.params.id]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete question
app.delete('/api/quiz-questions/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM quiz_questions WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start quiz (student) — create submission row
app.post('/api/quizzes/:id/start', async (req, res) => {
    const { studentId, studentName } = req.body;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO quiz_submissions (quiz_id, student_id, student_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (quiz_id, student_id) DO UPDATE SET student_name = EXCLUDED.student_name
             RETURNING *`,
            [req.params.id, studentId, studentName || '']
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get my submission for a quiz
app.get('/api/quizzes/:id/my-submission', async (req, res) => {
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    try {
        const { rows: subRows } = await db.query(
            'SELECT * FROM quiz_submissions WHERE quiz_id = $1 AND student_id = $2',
            [req.params.id, studentId]
        );
        if (!subRows.length) return res.json(null);
        const { rows: answers } = await db.query(
            `SELECT qa.*,
                    json_build_object(
                        'id', qq.id, 'question_text', qq.question_text, 'type', qq.type,
                        'options', qq.options, 'correct_answers', qq.correct_answers, 'points', qq.points
                    ) AS question
             FROM quiz_answers qa
             JOIN quiz_questions qq ON qq.id = qa.question_id
             WHERE qa.submission_id = $1
             ORDER BY qq.order_index ASC`,
            [subRows[0].id]
        );
        res.json({ ...subRows[0], answers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save answers (upsert, called as student works through quiz)
app.post('/api/submissions/:submissionId/answers', async (req, res) => {
    const { answers } = req.body; // [{ questionId, answerText, selectedOptions, fileUrl }]
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers array required' });
    try {
        for (const a of answers) {
            await db.query(
                `INSERT INTO quiz_answers (submission_id, question_id, answer_text, selected_options, file_url)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (submission_id, question_id) DO UPDATE SET
                    answer_text = EXCLUDED.answer_text,
                    selected_options = EXCLUDED.selected_options,
                    file_url = EXCLUDED.file_url`,
                [req.params.submissionId, a.questionId,
                 a.answerText || null,
                 a.selectedOptions !== undefined ? JSON.stringify(a.selectedOptions) : null,
                 a.fileUrl || null]
            );
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Submit quiz — auto-grade select/multi-select, mark submitted
app.post('/api/submissions/:submissionId/submit', async (req, res) => {
    const { submissionId } = req.params;
    try {
        // Get submission + quiz + answers + questions
        const { rows: subRows } = await db.query('SELECT * FROM quiz_submissions WHERE id = $1', [submissionId]);
        if (!subRows.length) return res.status(404).json({ error: 'Submission not found' });
        const sub = subRows[0];

        const { rows: questions } = await db.query(
            'SELECT * FROM quiz_questions WHERE quiz_id = $1', [sub.quiz_id]
        );
        const { rows: answers } = await db.query(
            'SELECT * FROM quiz_answers WHERE submission_id = $1', [submissionId]
        );

        let allTotalPoints = 0, autoTotalPoints = 0, earnedPoints = 0;
        for (const q of questions) {
            allTotalPoints += q.points;
            if (q.type === 'select' || q.type === 'multi-select') {
                autoTotalPoints += q.points;
                const ans = answers.find(a => a.question_id === q.id);
                if (ans && q.correct_answers) {
                    const correct = Array.isArray(q.correct_answers) ? q.correct_answers : JSON.parse(q.correct_answers);
                    const given   = ans.selected_options ? (Array.isArray(ans.selected_options) ? ans.selected_options : JSON.parse(ans.selected_options)) : [];
                    const isRight = JSON.stringify([...correct].sort()) === JSON.stringify([...given].sort());
                    const grade   = isRight ? q.points : 0;
                    earnedPoints += grade;
                    await db.query('UPDATE quiz_answers SET teacher_grade = $1 WHERE id = $2', [grade, ans.id]);
                }
            }
        }
        // If quiz has no auto-gradeable questions, score stays null until teacher grades manually
        const score = autoTotalPoints > 0 ? Math.round((earnedPoints / allTotalPoints) * 100) : null;
        const hasPendingManual = questions.some(q => !['select', 'multi-select'].includes(q.type));
        await db.query(
            'UPDATE quiz_submissions SET submitted_at = NOW(), score = $1 WHERE id = $2',
            [score, submissionId]
        );
        res.json({ success: true, score, hasPendingManual });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all submissions for a quiz (teacher)
app.get('/api/quizzes/:id/submissions', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT qs.*, json_agg(json_build_object(
                'id', qa.id, 'question_id', qa.question_id,
                'answer_text', qa.answer_text, 'selected_options', qa.selected_options,
                'file_url', qa.file_url, 'teacher_grade', qa.teacher_grade, 'teacher_feedback', qa.teacher_feedback
             ) ORDER BY qa.question_id) FILTER (WHERE qa.id IS NOT NULL) AS answers
             FROM quiz_submissions qs
             LEFT JOIN quiz_answers qa ON qa.submission_id = qs.id
             WHERE qs.quiz_id = $1
             GROUP BY qs.id ORDER BY qs.submitted_at DESC NULLS LAST`,
            [req.params.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Grade an answer (teacher) — also recalculates total submission score, emits to student
app.patch('/api/quiz-answers/:id/grade', async (req, res) => {
    const { grade, feedback } = req.body;
    try {
        await db.query(
            'UPDATE quiz_answers SET teacher_grade = $1, teacher_feedback = $2 WHERE id = $3',
            [grade ?? null, feedback || null, req.params.id]
        );
        // Recalculate total submission score from all graded answers
        const { rows: gradeData } = await db.query(
            `SELECT qa.teacher_grade, qq.points
             FROM quiz_answers qa
             JOIN quiz_questions qq ON qq.id = qa.question_id
             WHERE qa.submission_id = (SELECT submission_id FROM quiz_answers WHERE id = $1)`,
            [req.params.id]
        );
        const allPts    = gradeData.reduce((s, r) => s + (Number(r.points) || 0), 0);
        const earnedPts = gradeData.reduce((s, r) => s + (r.teacher_grade !== null ? Number(r.teacher_grade) : 0), 0);
        const newScore  = allPts > 0 ? Math.round((earnedPts / allPts) * 100) : null;
        const { rows: subRows } = await db.query(
            `UPDATE quiz_submissions SET score = $1
             WHERE id = (SELECT submission_id FROM quiz_answers WHERE id = $2)
             RETURNING id, quiz_id, student_id, teacher_final_score_override`,
            [newScore, req.params.id]
        );
        const sub = subRows[0];
        if (sub) {
            const effectiveScore = sub.teacher_final_score_override != null ? Number(sub.teacher_final_score_override) : newScore;
            const socketId = userSockets.get(sub.student_id);
            if (socketId) io.to(socketId).emit('quiz:score-updated', { submissionId: sub.id, quizId: sub.quiz_id, studentId: sub.student_id, score: effectiveScore });
        }
        res.json({ success: true, newScore });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update submission overall feedback and optional final score override
app.patch('/api/submissions/:id/feedback', async (req, res) => {
    const { teacherOverallFeedback, teacherFinalScoreOverride } = req.body;
    try {
        const updates = [];
        const params = [];
        let i = 1;
        if (teacherOverallFeedback !== undefined) {
            updates.push(`teacher_overall_feedback = $${i++}`);
            params.push(teacherOverallFeedback);
        }
        if (teacherFinalScoreOverride !== undefined) {
            updates.push(`teacher_final_score_override = $${i++}`);
            params.push(teacherFinalScoreOverride);
        }
        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
        params.push(req.params.id);
        const { rows } = await db.query(
            `UPDATE quiz_submissions SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, quiz_id, student_id, score, teacher_final_score_override, teacher_overall_feedback`,
            params
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        const sub = rows[0];
        const effectiveScore = sub.teacher_final_score_override != null ? Number(sub.teacher_final_score_override) : sub.score;
        const socketId = userSockets.get(sub.student_id);
        if (socketId) io.to(socketId).emit('quiz:score-updated', { submissionId: sub.id, quizId: sub.quiz_id, studentId: sub.student_id, score: effectiveScore });
        res.json({ success: true, teacherOverallFeedback: sub.teacher_overall_feedback, teacherFinalScoreOverride: sub.teacher_final_score_override });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get teacher's rooms for quiz room picker
// Uses teacher_sessions (persistent) so rooms still appear after a session ends
app.get('/api/teacher/:teacherId/rooms', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT room_id AS id, room_code AS code, title AS name
             FROM teacher_sessions
             WHERE created_by = $1
             ORDER BY scheduled_at DESC`,
            [req.params.teacherId]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/teacher/:teacherId/students', async (req, res) => {
    const { teacherId } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT user_id AS id, name, email, avatar_url
             FROM user_roles
             WHERE assigned_by = $1 AND role = 'student'
             ORDER BY name`,
            [teacherId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
const guestRoomHostByRoomCode = new Map();

io.on('connection', (socket) => {
    console.log(`[+] ${socket.id}`);

    // ── Register User for Direct Messages ──────────────────────────────────
    socket.on('register-user', (userId) => {
        if (userId) {
            userSockets.set(userId, socket.id);
            onlineUserIds.add(userId);
            io.emit('presence:status', { userId, online: true });
            console.log(`[Socket] Registered user ${userId} to socket ${socket.id}`);
        }
    });
    socket.on('presence:subscribe', () => {
        socket.emit('presence:list', Array.from(onlineUserIds));
        const lastSeenObj = {};
        for (const [uid, ts] of lastSeenByUserId.entries()) lastSeenObj[uid] = ts;
        socket.emit('presence:state', { onlineIds: Array.from(onlineUserIds), lastSeen: lastSeenObj });
    });

    // ── Join Room ──────────────────────────────────────────────────────────
    socket.on('join-room', async ({ roomCode, roomId, roomName, name, role, isGuestRoomHost }, callback) => {
        console.log(`[Socket] join-room: ${name} (${role}) -> ${roomCode}`);
        try {
            // Always look up max_participants from DB for this room
            let maxParticipants = 30;
            try {
                const { rows: roomRows } = await db.query(
                    'SELECT max_participants FROM rooms WHERE code = $1', [roomCode]
                );
                if (roomRows.length > 0) {
                    maxParticipants = roomRows[0].max_participants || 30;
                    roomManager.setMaxParticipants(roomCode, maxParticipants);
                }
            } catch (e) { /* use cached or default */ maxParticipants = roomManager.getMaxParticipants(roomCode); }

            const currentCount = roomManager.getParticipantCount(roomCode);
            if (currentCount >= maxParticipants) return callback({ error: `Room is full (max ${maxParticipants} participants)` });

            roomManager.addParticipant(roomCode, socket.id, { name, role, roomId });
            socket.join(roomCode);
            if (role === 'guest') incrementGuestCount();

            if (isGuestRoomHost && role === 'teacher') {
                guestRoomHostByRoomCode.set(roomCode, socket.id);
            }

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

            const quizState = roomQuizState.get(roomCode);
            callback({
                success: true,
                roomId,
                roomName: roomName || roomCode,
                existingParticipants,
                currentSpotlight,
                teacherPresent,
                roomQuiz: quizState ? { quizId: quizState.activeQuizId, quiz: quizState.quiz } : null,
            });
        } catch (err) {
            console.error('[join-room] error:', err.message);
            callback({ error: err.message });
        }
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
        roomQuizState.delete(roomCode);
        await endRoom(roomCode, roomId);
    });

    // ── Room Quiz (teacher starts/stops, students submit, teacher reveals) ──
    socket.on('room-quiz-start', async ({ roomCode, roomId, quizId }) => {
        const info = roomManager.getParticipantInfo(socket.id);
        if (!info || info.role !== 'teacher') return;
        try {
            const { rows: qRows } = await db.query('SELECT * FROM quizzes WHERE id = $1 AND status = $2', [quizId, 'published']);
            if (!qRows.length) return socket.emit('room:quiz-error', { error: 'Quiz not found or not published' });
            const quiz = qRows[0];
            const { rows: all } = await db.query(
                `SELECT id, quiz_id, type, question_text, options, video_url, order_index, points, parent_question_id
                 FROM quiz_questions WHERE quiz_id = $1 ORDER BY order_index ASC`,
                [quizId]
            );
            const topLevel = all.filter(q => !q.parent_question_id);
            const childrenByParent = {};
            all.filter(q => q.parent_question_id).forEach(q => {
                if (!childrenByParent[q.parent_question_id]) childrenByParent[q.parent_question_id] = [];
                childrenByParent[q.parent_question_id].push(q);
            });
            const questions = topLevel.map(q => ({ ...q, children: childrenByParent[q.id] || [] }));
            const quizWithQuestions = { ...quiz, questions };
            roomQuizState.set(roomCode, { activeQuizId: quizId, quiz: quizWithQuestions, submissions: [] });
            io.to(roomCode).emit('room:quiz-active', { quizId, quiz: quizWithQuestions });
            socket.emit('room:quiz-active', { quizId, quiz: quizWithQuestions });
        } catch (err) {
            console.error('[room-quiz-start]', err);
            socket.emit('room:quiz-error', { error: err.message });
        }
    });

    socket.on('room-quiz-stop', ({ roomCode }) => {
        const info = roomManager.getParticipantInfo(socket.id);
        if (!info || info.role !== 'teacher') return;
        roomQuizState.delete(roomCode);
        io.to(roomCode).emit('room:quiz-inactive');
        socket.emit('room:quiz-inactive');
    });

    socket.on('room-quiz-submit', ({ roomCode, submissionId, quizId, studentId, studentName, score }) => {
        const state = roomQuizState.get(roomCode);
        if (!state || state.activeQuizId !== quizId) return;
        const sub = { submissionId, studentId, studentName, score, socketId: socket.id };
        state.submissions.push(sub);
        const teacherSocketId = roomManager.getTeacherSocketId(roomCode);
        if (teacherSocketId) {
            io.to(teacherSocketId).emit('room:quiz-submission', { ...sub, submissions: state.submissions });
        }
    });

    socket.on('room-quiz-reveal', ({ roomCode, type, submissionId, data }) => {
        const info = roomManager.getParticipantInfo(socket.id);
        if (!info || info.role !== 'teacher') return;

        if (type === 'individual' && data?.studentId) {
            // Find the student's socket from quiz state submissions or userSockets
            const state = roomQuizState.get(roomCode);
            let studentSocketId = null;
            if (state) {
                const sub = state.submissions.find(s => s.studentId === data.studentId);
                if (sub && sub.socketId) studentSocketId = sub.socketId;
            }
            if (!studentSocketId) studentSocketId = userSockets.get(data.studentId);
            if (!studentSocketId) studentSocketId = roomManager.getSocketIdByUserId(roomCode, data.studentId);

            if (studentSocketId) {
                io.to(studentSocketId).emit('room:quiz-revealed', { type: 'individual', submissionId, data });
            }
            // Notify teacher that this student was revealed
            socket.emit('room:quiz-student-revealed', { submissionId, studentId: data.studentId });
        } else {
            // Broadcast final results to everyone
            io.to(roomCode).emit('room:quiz-revealed', { type, submissionId, data });
        }
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

    // ── Chat: Delete message — broadcast to conversation room ──────────────
    socket.on('chat:delete', ({ messageId, conversationId }) => {
        io.to(`chat:${conversationId}`).emit('chat:deleted', { messageId, conversationId });
    });

    // ── Leave / Disconnect ─────────────────────────────────────────────────
    const handleLeave = (intentional = false) => {
        // Remove from userSockets and presence
        let leavingUserId = null;
        for (const [userId, sId] of userSockets.entries()) {
            if (sId === socket.id) {
                leavingUserId = userId;
                userSockets.delete(userId);
                break;
            }
        }
        if (leavingUserId) {
            onlineUserIds.delete(leavingUserId);
            const lastSeen = Date.now();
            lastSeenByUserId.set(leavingUserId, lastSeen);
            io.emit('presence:status', { userId: leavingUserId, online: false, lastSeen });
        }
        const roomCode = roomManager.getParticipantRoom(socket.id);
        if (!roomCode) return;

        const info = roomManager.getParticipantInfo(socket.id);
        const { wasTeacher, role } = roomManager.removeParticipant(socket.id);
        if (role === 'guest') decrementGuestCount();
        socket.to(roomCode).emit('participant-left', { socketId: socket.id });
        if (roomManager.getParticipantCount(roomCode) === 0) roomQuizState.delete(roomCode);
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

        // Guest room host left or disconnected — end room immediately for everyone (no grace)
        if (guestRoomHostByRoomCode.get(roomCode) === socket.id) {
            guestRoomHostByRoomCode.delete(roomCode);
            const roomId = info?.roomId;
            console.log(`[Room ${roomCode}] Guest room host left — ending room`);
            if (roomId) endRoom(roomCode, roomId).catch(() => {});
            else io.to(roomCode).emit('room-ended');
            return;
        }

        // Teacher disconnect (non-guest): start grace period
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
        await db.query(`ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
        console.log('[migrate] user_roles.avatar_url ready');
    } catch (err) {
        console.warn('[migrate] avatar_url column:', err.message);
    }
    try {
        await db.query(`ALTER TABLE teacher_sessions ADD COLUMN IF NOT EXISTS session_image_url TEXT`);
        console.log('[migrate] teacher_sessions.session_image_url ready');
    } catch (err) {
        console.warn('[migrate] session_image_url column:', err.message);
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
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_meetings (
                id UUID PRIMARY KEY,
                room_code TEXT NOT NULL,
                room_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                scheduled_at TIMESTAMPTZ NOT NULL,
                created_by TEXT NOT NULL,
                max_participants INTEGER DEFAULT 30,
                is_active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_meeting_targets (
                id SERIAL PRIMARY KEY,
                meeting_id UUID NOT NULL REFERENCES admin_meetings(id) ON DELETE CASCADE,
                target_type TEXT NOT NULL CHECK (target_type IN ('role','room','user')),
                target_value TEXT NOT NULL
            )
        `);
        console.log('[migrate] admin_meetings + admin_meeting_targets ready');
    } catch (err) {
        console.warn('[migrate] admin_meetings tables:', err.message);
    }
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS teacher_sessions (
                id UUID PRIMARY KEY,
                room_code TEXT NOT NULL,
                room_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                scheduled_at TIMESTAMPTZ NOT NULL,
                created_by TEXT NOT NULL,
                max_participants INTEGER DEFAULT 30,
                is_active BOOLEAN NOT NULL DEFAULT true,
                session_image_url TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS teacher_session_targets (
                id SERIAL PRIMARY KEY,
                session_id UUID NOT NULL REFERENCES teacher_sessions(id) ON DELETE CASCADE,
                target_user_id TEXT NOT NULL
            )
        `);
        console.log('[migrate] teacher_sessions + teacher_session_targets ready');
    } catch (err) {
        console.warn('[migrate] teacher_sessions tables:', err.message);
    }
    // ── Role system: allow 'member' in user_roles ─────────────────────────
    try {
        await db.query(`ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check`);
        await db.query(`ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN ('admin', 'member', 'teacher', 'student'))`);
        console.log('[migrate] user_roles member role ready');
    } catch (err) {
        console.warn('[migrate] user_roles role check:', err.message);
    }
    // ── user_onboarding, invite_links, guest_rooms, courses ───────────────
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS user_onboarding (
                user_id              UUID PRIMARY KEY,
                role_interest        TEXT NOT NULL CHECK (role_interest IN ('member', 'teacher', 'student')),
                areas_of_interest    TEXT,
                current_situation    TEXT,
                goals                TEXT,
                onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
                created_at           TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS invite_links (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                token       TEXT UNIQUE NOT NULL,
                role        TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
                created_by  UUID NOT NULL,
                used_by     UUID,
                used_at     TIMESTAMPTZ,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_invite_links_created_by ON invite_links(created_by)`);
        await db.query(`
            CREATE TABLE IF NOT EXISTS guest_rooms (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                room_id    TEXT NOT NULL,
                room_code  TEXT NOT NULL UNIQUE,
                host_id    UUID NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                ended_at   TIMESTAMPTZ
            )
        `);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_guest_rooms_host_id ON guest_rooms(host_id)`);
        await db.query(`
            CREATE TABLE IF NOT EXISTS courses (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                title       TEXT NOT NULL,
                created_by  UUID NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_courses_created_by ON courses(created_by)`);
        console.log('[migrate] user_onboarding, invite_links, guest_rooms, courses ready');
    } catch (err) {
        console.warn('[migrate] role system tables:', err.message);
    }
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS invite_link_claims (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                invite_link_id  UUID NOT NULL REFERENCES invite_links(id) ON DELETE CASCADE,
                user_id         UUID NOT NULL,
                claimed_at      TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(invite_link_id, user_id)
            )
        `);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_invite_link_claims_invite_link_id ON invite_link_claims(invite_link_id)`);
        console.log('[migrate] invite_link_claims ready');
    } catch (err) {
        console.warn('[migrate] invite_link_claims:', err.message);
    }
    try {
        await db.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS description TEXT`);
        console.log('[migrate] courses.description ready');
    } catch (err) {
        console.warn('[migrate] courses.description:', err.message);
    }
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS lessons (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                content     TEXT,
                order_index INT NOT NULL DEFAULT 0,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_lessons_course_id ON lessons(course_id)`);
        console.log('[migrate] lessons table ready');
    } catch (err) {
        console.warn('[migrate] lessons:', err.message);
    }
    try {
        await db.query(`ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS course_id UUID`);
        console.log('[migrate] quizzes.course_id ready');
    } catch (err) {
        console.warn('[migrate] quizzes.course_id:', err.message);
    }
    try {
        await db.query(`ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS parent_question_id UUID REFERENCES quiz_questions(id) ON DELETE CASCADE`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_quiz_questions_parent ON quiz_questions(parent_question_id)`);
        console.log('[migrate] quiz_questions.parent_question_id ready');
    } catch (err) {
        console.warn('[migrate] quiz_questions.parent_question_id:', err.message);
    }
    try {
        await db.query(`ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS teacher_overall_feedback TEXT`);
        await db.query(`ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS teacher_final_score_override NUMERIC`);
        console.log('[migrate] quiz_submissions teacher_overall_feedback, teacher_final_score_override ready');
    } catch (err) {
        console.warn('[migrate] quiz_submissions feedback:', err.message);
    }
    try {
        await db.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS lesson_type TEXT DEFAULT 'text'`);
        await db.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_url TEXT`);
        await db.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS audio_url TEXT`);
        await db.query(`UPDATE lessons SET lesson_type = 'text' WHERE lesson_type IS NULL`);
        console.log('[migrate] lessons lesson_type, video_url, audio_url ready');
    } catch (err) {
        console.warn('[migrate] lessons type:', err.message);
    }
    try {
        await db.query('DROP TABLE IF EXISTS rejected_users');
        console.log('[migrate] rejected_users table removed (reject = delete)');
    } catch (err) {
        console.warn('[migrate] drop rejected_users:', err.message);
    }
    console.log(`🚀 ClassMeet server running on port ${PORT}`);
    console.log(`   InsForge: ${process.env.INSFORGE_BASE_URL}`);
    console.log(`   CORS: ${CLIENT_URL}`);
});
