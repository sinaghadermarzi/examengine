# ExamEngine

Real-time exam application with a coordinator server and multi-client support.

## Features

- **Create exams** with multiple-choice questions, configurable duration
- **Join exams** in real time via WebSocket
- **Live timer** synced across all participants
- **Durable answer saving** — answers are saved to SQLite on every selection, surviving disconnects and server restarts
- **Disconnect resilience** — clients auto-reconnect with exponential backoff and restore their saved answers
- **Auto-end** — exams end automatically when the timer expires
- **Results & review** — scores ranked by correctness with full answer review

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## Architecture

```
Client (Browser)  ←— WebSocket —→  Server (Node.js)
                                       ↓
                                   SQLite (WAL mode)
```

- **Server**: Node.js HTTP + WebSocket server (`ws` library)
- **Storage**: SQLite via `better-sqlite3` with WAL mode for concurrent reads
- **Client**: Vanilla HTML/CSS/JS, no build step required

## Protocol

All communication uses JSON over WebSocket:

| Client → Server | Description |
|---|---|
| `register` | Register with userId and name |
| `list_exams` | List joinable exams |
| `create_exam` | Create exam with title, duration, questions |
| `join_exam` | Join an exam (restores saved answers on reconnect) |
| `start_exam` | Start the exam (creator only) |
| `save_answer` | Save an answer (persisted immediately to disk) |
| `submit_exam` | Submit all answers |
| `end_exam` | End exam early (creator only) |
| `get_results` | Get exam results |

## Testing

```bash
node test.js
```

Runs an automated integration test covering registration, exam creation, joining, answering, disconnect/reconnect with answer restoration, submission, and results.
