const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3999;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connectClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const messages = [];
    ws.on('open', () => resolve({ ws, messages, name }));
    ws.on('message', (data) => {
      messages.push(JSON.parse(data));
    });
    ws.on('error', reject);
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function waitForMessage(client, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = client.messages.find((m) => m.type === type);
      if (found) {
        client.messages.splice(client.messages.indexOf(found), 1);
        return resolve(found);
      }
    };
    check();
    const interval = setInterval(() => {
      check();
    }, 50);
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeout);
  });
}

async function runTests() {
  // Start server
  const server = spawn('node', [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
  });

  let serverReady = false;
  server.stdout.on('data', (d) => {
    if (d.toString().includes('running')) serverReady = true;
  });
  server.stderr.on('data', (d) => process.stderr.write(d));

  // Wait for server to start
  for (let i = 0; i < 30; i++) {
    if (serverReady) break;
    await sleep(200);
  }
  if (!serverReady) throw new Error('Server did not start');

  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      console.log(`  PASS: ${msg}`);
      passed++;
    } else {
      console.log(`  FAIL: ${msg}`);
      failed++;
    }
  }

  try {
    console.log('--- Test: Registration ---');
    const creator = await connectClient('creator');
    send(creator.ws, { type: 'register', userId: 'user-1', name: 'Alice' });
    const regMsg = await waitForMessage(creator, 'registered');
    assert(regMsg.user.name === 'Alice', 'Creator registered as Alice');

    console.log('--- Test: Create Exam ---');
    send(creator.ws, {
      type: 'create_exam',
      title: 'Test Exam',
      durationSeconds: 10,
      questions: [
        { text: 'What is 2+2?', options: ['3', '4', '5'], correct_answer: '4' },
        { text: 'Capital of France?', options: ['London', 'Paris', 'Berlin'], correct_answer: 'Paris' },
      ],
    });
    const createdMsg = await waitForMessage(creator, 'exam_created');
    assert(createdMsg.exam.title === 'Test Exam', 'Exam created with correct title');
    assert(createdMsg.exam.questions.length === 2, 'Exam has 2 questions');
    const examId = createdMsg.exam.id;

    console.log('--- Test: Join Exam ---');
    const student = await connectClient('student');
    send(student.ws, { type: 'register', userId: 'user-2', name: 'Bob' });
    await waitForMessage(student, 'registered');
    send(student.ws, { type: 'join_exam', examId });
    const joinMsg = await waitForMessage(student, 'exam_joined');
    assert(joinMsg.exam.id === examId, 'Student joined the correct exam');
    assert(joinMsg.participantId !== null, 'Student got a participant ID');
    const studentParticipantId = joinMsg.participantId;

    console.log('--- Test: Start Exam ---');
    send(creator.ws, { type: 'start_exam' });
    const startAck = await waitForMessage(creator, 'exam_started_ack');
    assert(startAck.exam.status === 'active', 'Exam is active');
    const startNotif = await waitForMessage(student, 'exam_started');
    assert(startNotif.remainingMs > 0, 'Student received remaining time');

    console.log('--- Test: Save Answers ---');
    // Clear any pending notification messages
    student.messages.length = 0;
    const q1Id = startNotif.exam.questions[0].id;
    const q2Id = startNotif.exam.questions[1].id;
    send(student.ws, { type: 'save_answer', participantId: studentParticipantId, questionId: q1Id, answer: '4' });
    const saved1 = await waitForMessage(student, 'answer_saved');
    assert(saved1.saved === true, 'Answer 1 saved');

    await sleep(200);
    send(student.ws, { type: 'save_answer', participantId: studentParticipantId, questionId: q2Id, answer: 'Paris' });
    const saved2 = await waitForMessage(student, 'answer_saved');
    assert(saved2.saved === true, 'Answer 2 saved');

    console.log('--- Test: Disconnect and Reconnect ---');
    student.ws.close();
    await sleep(500);
    const student2 = await connectClient('student-reconnected');
    send(student2.ws, { type: 'register', userId: 'user-2', name: 'Bob' });
    await waitForMessage(student2, 'registered');
    send(student2.ws, { type: 'join_exam', examId });
    const rejoinMsg = await waitForMessage(student2, 'exam_joined');
    assert(rejoinMsg.savedAnswers.length === 2, 'Reconnected student has saved answers restored');
    assert(rejoinMsg.savedAnswers.some((a) => a.answer === '4'), 'Answer to Q1 preserved');
    assert(rejoinMsg.savedAnswers.some((a) => a.answer === 'Paris'), 'Answer to Q2 preserved');

    console.log('--- Test: Submit Exam ---');
    send(student2.ws, { type: 'submit_exam', participantId: studentParticipantId });
    const submitMsg = await waitForMessage(student2, 'exam_submitted');
    assert(submitMsg.submitted === true, 'Exam submitted');

    console.log('--- Test: End Exam & Results ---');
    send(creator.ws, { type: 'end_exam' });
    const endMsg = await waitForMessage(creator, 'exam_ended');
    assert(endMsg.results.length > 0, 'Results available');
    const bobResult = endMsg.results.find((r) => r.user_name === 'Bob');
    assert(bobResult.correct === 2, 'Bob got 2/2 correct');

    // Cleanup
    creator.ws.close();
    student2.ws.close();
  } catch (err) {
    console.error('Test error:', err.message);
    failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  server.kill();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
