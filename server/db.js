const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'examengine.db'), {
  // WAL mode for better concurrent read performance
});
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 3600,
    status TEXT NOT NULL DEFAULT 'draft',
    started_at TEXT,
    ends_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    question_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'multiple_choice',
    options TEXT,
    correct_answer TEXT,
    FOREIGN KEY (exam_id) REFERENCES exams(id)
  );

  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    submitted_at TEXT,
    UNIQUE(exam_id, user_id),
    FOREIGN KEY (exam_id) REFERENCES exams(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS answers (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    answer TEXT,
    saved_at TEXT DEFAULT (datetime('now')),
    UNIQUE(participant_id, question_id),
    FOREIGN KEY (participant_id) REFERENCES participants(id),
    FOREIGN KEY (question_id) REFERENCES questions(id)
  );
`);

// --- Prepared Statements ---

const stmts = {
  // Users
  upsertUser: db.prepare(`
    INSERT INTO users (id, name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `),
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),

  // Exams
  createExam: db.prepare(`
    INSERT INTO exams (id, title, creator_id, duration_seconds, status)
    VALUES (?, ?, ?, ?, 'draft')
  `),
  getExam: db.prepare('SELECT * FROM exams WHERE id = ?'),
  listExams: db.prepare(`SELECT * FROM exams ORDER BY created_at DESC`),
  listJoinableExams: db.prepare(`
    SELECT * FROM exams WHERE status IN ('draft', 'active') ORDER BY created_at DESC
  `),
  updateExamStatus: db.prepare(`UPDATE exams SET status = ? WHERE id = ?`),
  startExam: db.prepare(`
    UPDATE exams SET status = 'active', started_at = datetime('now'),
    ends_at = datetime('now', '+' || ? || ' seconds')
    WHERE id = ? AND status = 'draft'
  `),
  endExam: db.prepare(`UPDATE exams SET status = 'ended' WHERE id = ?`),

  // Questions
  addQuestion: db.prepare(`
    INSERT INTO questions (id, exam_id, question_index, text, type, options, correct_answer)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getQuestions: db.prepare(`
    SELECT * FROM questions WHERE exam_id = ? ORDER BY question_index ASC
  `),
  getQuestion: db.prepare('SELECT * FROM questions WHERE id = ?'),

  // Participants
  joinExam: db.prepare(`
    INSERT INTO participants (id, exam_id, user_id)
    VALUES (?, ?, ?)
    ON CONFLICT(exam_id, user_id) DO NOTHING
  `),
  getParticipant: db.prepare(`
    SELECT * FROM participants WHERE exam_id = ? AND user_id = ?
  `),
  getParticipantById: db.prepare('SELECT * FROM participants WHERE id = ?'),
  listParticipants: db.prepare(`
    SELECT p.*, u.name as user_name FROM participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.exam_id = ?
  `),
  markSubmitted: db.prepare(`
    UPDATE participants SET submitted_at = datetime('now') WHERE id = ?
  `),

  // Answers
  saveAnswer: db.prepare(`
    INSERT INTO answers (id, participant_id, question_id, answer, saved_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(participant_id, question_id)
    DO UPDATE SET answer = excluded.answer, saved_at = datetime('now')
  `),
  getAnswers: db.prepare(`
    SELECT a.*, q.question_index, q.text as question_text, q.correct_answer
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    WHERE a.participant_id = ?
    ORDER BY q.question_index ASC
  `),
  getAnswer: db.prepare(`
    SELECT * FROM answers WHERE participant_id = ? AND question_id = ?
  `),
  getExamResults: db.prepare(`
    SELECT p.user_id, u.name as user_name, p.submitted_at,
           COUNT(a.id) as answered,
           SUM(CASE WHEN a.answer = q.correct_answer THEN 1 ELSE 0 END) as correct
    FROM participants p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN answers a ON a.participant_id = p.id
    LEFT JOIN questions q ON q.id = a.question_id
    WHERE p.exam_id = ?
    GROUP BY p.id
    ORDER BY correct DESC
  `),
};

module.exports = { db, stmts };
