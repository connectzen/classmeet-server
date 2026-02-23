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
        `CREATE INDEX IF NOT EXISTS idx_messages_receiver_id ON messages(receiver_id)`
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
