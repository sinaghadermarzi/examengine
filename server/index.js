const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const ExamManager = require('./exam-manager');

const PORT = process.env.PORT || 3000;

// --- HTTP Server (serves static files) ---
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, '..', 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });

// Track connected clients: Map<ws, { userId, examId }>
const clients = new Map();
// Track exam rooms: Map<examId, Set<ws>>
const examRooms = new Map();

function broadcast(examId, message, excludeWs = null) {
  const room = examRooms.get(examId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const ws of room) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

const manager = new ExamManager(broadcast);

function joinRoom(ws, examId) {
  if (!examRooms.has(examId)) {
    examRooms.set(examId, new Set());
  }
  examRooms.get(examId).add(ws);
}

function leaveRoom(ws, examId) {
  const room = examRooms.get(examId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) examRooms.delete(examId);
  }
}

function send(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

wss.on('connection', (ws) => {
  clients.set(ws, { userId: null, examId: null });

  // Heartbeat for connection health
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.examId) {
      leaveRoom(ws, client.examId);
      // Notify room about disconnect
      broadcast(client.examId, {
        type: 'participant_disconnected',
        userId: client.userId,
      });
    }
    clients.delete(ws);
  });
});

// Heartbeat interval - detect dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      const client = clients.get(ws);
      if (client?.examId) {
        leaveRoom(ws, client.examId);
      }
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

wss.on('close', () => clearInterval(heartbeat));

// --- Message Handler ---
function handleMessage(ws, msg) {
  const client = clients.get(ws);

  try {
    switch (msg.type) {
      case 'register': {
        const user = manager.registerUser(msg.userId, msg.name);
        client.userId = msg.userId;
        send(ws, { type: 'registered', user });
        break;
      }

      case 'list_exams': {
        const exams = manager.listExams();
        send(ws, { type: 'exam_list', exams });
        break;
      }

      case 'create_exam': {
        if (!client.userId) {
          send(ws, { type: 'error', message: 'Not registered' });
          return;
        }
        const exam = manager.createExam(
          client.userId,
          msg.title,
          msg.durationSeconds || 3600,
          msg.questions || []
        );
        client.examId = exam.id;
        joinRoom(ws, exam.id);
        send(ws, { type: 'exam_created', exam });
        break;
      }

      case 'join_exam': {
        if (!client.userId) {
          send(ws, { type: 'error', message: 'Not registered' });
          return;
        }
        // Leave previous room
        if (client.examId) leaveRoom(ws, client.examId);

        const result = manager.joinExam(msg.examId, client.userId);
        client.examId = msg.examId;
        joinRoom(ws, msg.examId);

        send(ws, {
          type: 'exam_joined',
          exam: result.exam,
          participantId: result.participantId,
          savedAnswers: result.savedAnswers,
          remainingMs: manager.getRemainingTime(msg.examId),
        });
        break;
      }

      case 'start_exam': {
        if (!client.userId || !client.examId) {
          send(ws, { type: 'error', message: 'Not in an exam' });
          return;
        }
        const exam = manager.startExam(client.examId, client.userId);
        send(ws, {
          type: 'exam_started_ack',
          exam,
          remainingMs: manager.getRemainingTime(client.examId),
        });
        break;
      }

      case 'save_answer': {
        const result = manager.saveAnswer(
          msg.participantId,
          msg.questionId,
          msg.answer
        );
        send(ws, {
          type: 'answer_saved',
          questionId: msg.questionId,
          ...result,
        });
        break;
      }

      case 'submit_exam': {
        const result = manager.submitExam(msg.participantId);
        send(ws, { type: 'exam_submitted', ...result });
        break;
      }

      case 'get_results': {
        const results = manager.getResults(msg.examId);
        const exam = manager.getExamFull(msg.examId);
        send(ws, { type: 'results', examId: msg.examId, results, exam });
        break;
      }

      case 'get_my_answers': {
        const answers = manager.getMyAnswers(msg.participantId);
        send(ws, { type: 'my_answers', answers });
        break;
      }

      case 'end_exam': {
        if (!client.userId || !client.examId) {
          send(ws, { type: 'error', message: 'Not in an exam' });
          return;
        }
        const exam = manager.getExamFull(client.examId);
        if (exam.creator_id !== client.userId) {
          send(ws, { type: 'error', message: 'Only the creator can end the exam' });
          return;
        }
        manager.endExam(client.examId);
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    send(ws, { type: 'error', message: err.message });
  }
}

server.listen(PORT, () => {
  console.log(`ExamEngine server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});
