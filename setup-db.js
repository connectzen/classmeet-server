require('dotenv').config();
const { query, pool } = require('./db');

async function setupDatabase() {
    console.log('[setup-db] Connecting to PostgreSQL via direct connection pool...');

    // Create tables and indexes using the direct pg connection
    const statements = [
        `CREATE TABLE IF NOT EXISTS student_enrollments (
            id          SERIAL PRIMARY KEY,
            user_id     TEXT NOT NULL,
            room_id     TEXT NOT NULL,
            room_code   TEXT NOT NULL,
            room_name   TEXT NOT NULL,
            enrolled_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, room_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_student_enrollments_user_id
            ON student_enrollments(user_id)`,
        `CREATE TABLE IF NOT EXISTS rooms (
            id               TEXT PRIMARY KEY,
            code             TEXT UNIQUE NOT NULL,
            name             TEXT NOT NULL,
            host_id          TEXT NOT NULL,
            max_participants INTEGER DEFAULT 30,
            created_at       TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(code)`,
        `CREATE TABLE IF NOT EXISTS user_roles (
            id          SERIAL PRIMARY KEY,
            user_id     UUID UNIQUE NOT NULL,
            role        TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
            name        TEXT,
            email       TEXT,
            assigned_by UUID,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS messages (
            id          SERIAL PRIMARY KEY,
            sender_id   TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            receiver_id TEXT NOT NULL,
            subject     TEXT,
            content     TEXT NOT NULL,
            is_read     BOOLEAN DEFAULT FALSE,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_messages_receiver_id ON messages(receiver_id)`,

        // ── Chat System ───────────────────────────────────────────────────
        `CREATE TABLE IF NOT EXISTS chat_conversations (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            type       TEXT NOT NULL DEFAULT 'dm' CHECK (type IN ('dm','group','broadcast')),
            name       TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS chat_participants (
            conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            user_id         TEXT NOT NULL,
            user_name       TEXT NOT NULL DEFAULT '',
            user_role       TEXT NOT NULL DEFAULT 'student',
            joined_at       TIMESTAMPTZ DEFAULT NOW(),
            last_read_at    TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (conversation_id, user_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_chat_participants_user_id ON chat_participants(user_id)`,
        `CREATE TABLE IF NOT EXISTS chat_messages (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            sender_id       TEXT NOT NULL,
            sender_name     TEXT NOT NULL DEFAULT '',
            sender_role     TEXT NOT NULL DEFAULT 'student',
            content         TEXT,
            media_url       TEXT,
            media_type      TEXT CHECK (media_type IN ('image','file','voice') OR media_type IS NULL),
            media_name      TEXT,
            reactions       JSONB NOT NULL DEFAULT '{}',
            is_read         BOOLEAN NOT NULL DEFAULT FALSE,
            is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id)`
    ];

    for (const sql of statements) {
        try {
            await query(sql);
            console.log(`[setup-db] ✅  ${sql.trim().split('\n')[0].substring(0, 60)}...`);
        } catch (err) {
            console.error('[setup-db] ❌ Error executing statement:');
            console.error(sql);
            console.error(err.message);
            throw err;
        }
    }
}

setupDatabase()
    .then(async () => {
        console.log('\n🎉 Database setup complete!');
        await pool.end();
        process.exit(0);
    })
    .catch((err) => {
        console.error('Fatal error:', err);
        pool.end().finally(() => process.exit(1));
    });
