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
            role        TEXT NOT NULL CHECK (role IN ('admin', 'member', 'teacher', 'student')),
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
        `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id)`,

        // ── Quiz System ───────────────────────────────────────────────────
        `CREATE TABLE IF NOT EXISTS quizzes (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title               TEXT NOT NULL,
            room_id             TEXT NOT NULL,
            created_by          TEXT NOT NULL,
            time_limit_minutes  INTEGER,
            status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
            created_at          TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_quizzes_room_id ON quizzes(room_id)`,
        `CREATE INDEX IF NOT EXISTS idx_quizzes_created_by ON quizzes(created_by)`,
        `CREATE TABLE IF NOT EXISTS quiz_questions (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            quiz_id          UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
            type             TEXT NOT NULL CHECK (type IN ('text','select','multi-select','recording','video','upload')),
            question_text    TEXT NOT NULL,
            options          JSONB,
            correct_answers  JSONB,
            video_url        TEXT,
            order_index      INTEGER NOT NULL DEFAULT 0,
            points           INTEGER NOT NULL DEFAULT 1
        )`,
        `CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz_id ON quiz_questions(quiz_id)`,
        `CREATE TABLE IF NOT EXISTS quiz_submissions (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            quiz_id          UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
            student_id       TEXT NOT NULL,
            student_name     TEXT NOT NULL DEFAULT '',
            started_at       TIMESTAMPTZ DEFAULT NOW(),
            submitted_at     TIMESTAMPTZ,
            score            NUMERIC,
            UNIQUE(quiz_id, student_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_quiz_submissions_quiz_id ON quiz_submissions(quiz_id)`,
        `CREATE INDEX IF NOT EXISTS idx_quiz_submissions_student_id ON quiz_submissions(student_id)`,
        `CREATE TABLE IF NOT EXISTS quiz_answers (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            submission_id    UUID NOT NULL REFERENCES quiz_submissions(id) ON DELETE CASCADE,
            question_id      UUID NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
            answer_text      TEXT,
            selected_options JSONB,
            file_url         TEXT,
            teacher_grade    NUMERIC,
            teacher_feedback TEXT,
            UNIQUE(submission_id, question_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_quiz_answers_submission_id ON quiz_answers(submission_id)`,

        // ── Onboarding ─────────────────────────────────────────────────────
        `CREATE TABLE IF NOT EXISTS user_onboarding (
            user_id              UUID PRIMARY KEY,
            role_interest        TEXT NOT NULL CHECK (role_interest IN ('member', 'teacher', 'student')),
            areas_of_interest    TEXT,
            current_situation    TEXT,
            goals                TEXT,
            onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
            created_at           TIMESTAMPTZ DEFAULT NOW()
        )`,

        // ── Invite links ───────────────────────────────────────────────────
        `CREATE TABLE IF NOT EXISTS invite_links (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            token       TEXT UNIQUE NOT NULL,
            role        TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
            created_by  UUID NOT NULL,
            used_by     UUID,
            used_at     TIMESTAMPTZ,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_invite_links_created_by ON invite_links(created_by)`,

        // ── Guest rooms ────────────────────────────────────────────────────
        `CREATE TABLE IF NOT EXISTS guest_rooms (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            room_id    TEXT NOT NULL,
            room_code  TEXT NOT NULL UNIQUE,
            host_id    UUID NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            ended_at   TIMESTAMPTZ
        )`,
        `CREATE INDEX IF NOT EXISTS idx_guest_rooms_host_id ON guest_rooms(host_id)`,

        // ── Courses ─────────────────────────────────────────────────────────
        `CREATE TABLE IF NOT EXISTS courses (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title       TEXT NOT NULL,
            description TEXT,
            created_by  UUID NOT NULL,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_courses_created_by ON courses(created_by)`,
        `CREATE TABLE IF NOT EXISTS lessons (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            title       TEXT NOT NULL,
            content     TEXT,
            order_index INT NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_lessons_course_id ON lessons(course_id)`
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
