(() => {
  // --- State ---
  let ws = null;
  let userId = localStorage.getItem('examengine_userId') || crypto.randomUUID();
  let userName = localStorage.getItem('examengine_userName') || '';
  let currentExam = null;
  let participantId = null;
  let timerInterval = null;
  let remainingMs = 0;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  const savedAnswerMap = new Map(); // questionId -> answer

  localStorage.setItem('examengine_userId', userId);

  // --- DOM Elements ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const statusEl = $('#connection-status');
  const userInfoEl = $('#user-info');

  // Screens
  const screens = {
    register: $('#screen-register'),
    lobby: $('#screen-lobby'),
    create: $('#screen-create'),
    waiting: $('#screen-waiting'),
    exam: $('#screen-exam'),
    results: $('#screen-results'),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // --- WebSocket Connection ---
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      statusEl.textContent = 'Connected';
      statusEl.className = 'connected';
      reconnectAttempts = 0;

      // Re-register if we have a name
      if (userName) {
        send({ type: 'register', userId, name: userName });
      }

      // Rejoin exam if we were in one
      if (currentExam) {
        send({ type: 'join_exam', examId: currentExam.id });
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      statusEl.textContent = 'Disconnected - Reconnecting...';
      statusEl.className = 'disconnected';
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      statusEl.textContent = 'Connection lost. Refresh to retry.';
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    setTimeout(connect, delay);
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // --- Server Message Handler ---
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'registered':
        userInfoEl.textContent = msg.user.name;
        showScreen('lobby');
        send({ type: 'list_exams' });
        break;

      case 'exam_list':
        renderExamList(msg.exams);
        break;

      case 'exam_created':
        currentExam = msg.exam;
        participantId = msg.exam.participants.find((p) => p.user_id === userId)?.id;
        showWaitingRoom();
        break;

      case 'exam_joined':
        currentExam = msg.exam;
        participantId = msg.participantId;
        remainingMs = msg.remainingMs;
        // Restore saved answers
        savedAnswerMap.clear();
        if (msg.savedAnswers) {
          msg.savedAnswers.forEach((a) => savedAnswerMap.set(a.question_id, a.answer));
        }
        if (msg.exam.status === 'active') {
          showExamScreen();
        } else if (msg.exam.status === 'ended') {
          send({ type: 'get_results', examId: currentExam.id });
        } else {
          showWaitingRoom();
        }
        break;

      case 'exam_started':
      case 'exam_started_ack':
        currentExam = msg.exam;
        remainingMs = msg.remainingMs;
        showExamScreen();
        break;

      case 'answer_saved':
        showSavedIndicator(msg.questionId);
        break;

      case 'exam_submitted':
        toast('Exam submitted successfully!');
        break;

      case 'exam_ended':
        clearTimerInterval();
        currentExam = null;
        showResultsScreen(msg.results, msg.examId);
        break;

      case 'participant_joined':
        toast(`${msg.userName} joined the exam`);
        if (currentExam && currentExam.status === 'draft') {
          // Refresh waiting room
          send({ type: 'join_exam', examId: currentExam.id });
        }
        break;

      case 'participant_submitted':
        toast(`${msg.userName} submitted their exam`);
        break;

      case 'participant_disconnected':
        // Could update participant list UI
        break;

      case 'results':
        showResultsScreen(msg.results, msg.examId, msg.exam);
        break;

      case 'error':
        toast(`Error: ${msg.message}`);
        break;
    }
  }

  // --- Registration ---
  $('#btn-register').addEventListener('click', () => {
    const name = $('#input-name').value.trim();
    if (!name) return;
    userName = name;
    localStorage.setItem('examengine_userName', userName);
    send({ type: 'register', userId, name });
  });

  $('#input-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-register').click();
  });

  // Auto-fill if returning
  if (userName) {
    $('#input-name').value = userName;
  }

  // --- Lobby ---
  $('#btn-create-exam').addEventListener('click', () => {
    showScreen('create');
    addQuestionBlock();
  });

  $('#btn-refresh-exams').addEventListener('click', () => {
    send({ type: 'list_exams' });
  });

  function renderExamList(exams) {
    const container = $('#exam-list');
    if (!exams.length) {
      container.innerHTML = '<p class="muted">No exams available. Create one to get started.</p>';
      return;
    }
    container.innerHTML = exams
      .map(
        (e) => `
      <div class="exam-item">
        <div class="exam-item-info">
          <h4>${escapeHtml(e.title)}</h4>
          <span>${Math.round(e.duration_seconds / 60)} min &middot; <span class="badge badge-${e.status}">${e.status}</span></span>
        </div>
        <button class="btn btn-primary" onclick="joinExam('${e.id}')">
          ${e.status === 'active' ? 'Join Now' : 'Join'}
        </button>
      </div>
    `
      )
      .join('');
  }

  // Make joinExam global for inline onclick
  window.joinExam = (examId) => {
    send({ type: 'join_exam', examId });
  };

  // --- Create Exam ---
  let questionCount = 0;

  function addQuestionBlock() {
    const container = $('#questions-container');
    const idx = questionCount++;
    const block = document.createElement('div');
    block.className = 'question-block';
    block.dataset.idx = idx;
    block.innerHTML = `
      <div class="q-header">
        <strong>Question ${idx + 1}</strong>
        <button class="btn-remove-q" onclick="this.closest('.question-block').remove()">&times;</button>
      </div>
      <div class="form-group">
        <textarea placeholder="Enter question text" class="q-text-input"></textarea>
      </div>
      <div class="form-group">
        <label>Options (select the correct answer):</label>
        <div class="options-list">
          <div class="option-row">
            <input type="radio" name="correct-${idx}" value="0" checked>
            <input type="text" placeholder="Option A" class="opt-input">
          </div>
          <div class="option-row">
            <input type="radio" name="correct-${idx}" value="1">
            <input type="text" placeholder="Option B" class="opt-input">
          </div>
          <div class="option-row">
            <input type="radio" name="correct-${idx}" value="2">
            <input type="text" placeholder="Option C" class="opt-input">
          </div>
          <div class="option-row">
            <input type="radio" name="correct-${idx}" value="3">
            <input type="text" placeholder="Option D" class="opt-input">
          </div>
        </div>
      </div>
    `;
    container.appendChild(block);
  }

  $('#btn-add-question').addEventListener('click', addQuestionBlock);

  $('#btn-back-lobby').addEventListener('click', () => {
    $('#questions-container').innerHTML = '';
    questionCount = 0;
    showScreen('lobby');
    send({ type: 'list_exams' });
  });

  $('#btn-submit-exam').addEventListener('click', () => {
    const title = $('#exam-title').value.trim();
    const duration = parseInt($('#exam-duration').value) || 60;

    if (!title) {
      toast('Please enter an exam title');
      return;
    }

    const blocks = $$('.question-block');
    if (!blocks.length) {
      toast('Add at least one question');
      return;
    }

    const questions = [];
    for (const block of blocks) {
      const text = block.querySelector('.q-text-input').value.trim();
      if (!text) {
        toast('All questions must have text');
        return;
      }
      const optInputs = block.querySelectorAll('.opt-input');
      const options = [];
      for (const oi of optInputs) {
        const val = oi.value.trim();
        if (val) options.push(val);
      }
      if (options.length < 2) {
        toast('Each question needs at least 2 options');
        return;
      }
      const correctIdx = block.querySelector(`input[type="radio"]:checked`)?.value || '0';
      questions.push({
        text,
        type: 'multiple_choice',
        options,
        correct_answer: options[parseInt(correctIdx)] || options[0],
      });
    }

    send({
      type: 'create_exam',
      title,
      durationSeconds: duration * 60,
      questions,
    });

    // Reset form
    $('#exam-title').value = '';
    $('#exam-duration').value = '60';
    $('#questions-container').innerHTML = '';
    questionCount = 0;
  });

  // --- Waiting Room ---
  function showWaitingRoom() {
    showScreen('waiting');
    if (!currentExam) return;
    $('#waiting-title').textContent = currentExam.title;

    const isCreator = currentExam.creator_id === userId;
    const info = [];
    info.push(`Duration: ${Math.round(currentExam.duration_seconds / 60)} minutes`);
    info.push(`Questions: ${currentExam.questions.length}`);
    info.push(`Status: ${currentExam.status}`);
    $('#waiting-info').innerHTML = info.map((i) => `<p>${i}</p>`).join('');

    // Participants
    const partList = $('#participants-list');
    partList.innerHTML =
      '<h3>Participants</h3>' +
      currentExam.participants
        .map(
          (p) =>
            `<div class="participant-item"><span class="participant-dot"></span>${escapeHtml(p.user_name)}</div>`
        )
        .join('');

    const startBtn = $('#btn-start-exam');
    startBtn.style.display = isCreator ? 'inline-block' : 'none';
  }

  $('#btn-start-exam').addEventListener('click', () => {
    send({ type: 'start_exam' });
  });

  $('#btn-leave-exam').addEventListener('click', () => {
    currentExam = null;
    participantId = null;
    showScreen('lobby');
    send({ type: 'list_exams' });
  });

  // --- Active Exam ---
  function showExamScreen() {
    showScreen('exam');
    if (!currentExam) return;

    $('#exam-active-title').textContent = currentExam.title;
    startTimer();

    const container = $('#exam-questions');
    container.innerHTML = currentExam.questions
      .map((q, i) => {
        const options = q.options || [];
        const savedAnswer = savedAnswerMap.get(q.id);
        return `
        <div class="exam-question" data-qid="${q.id}">
          <div class="q-num">Question ${i + 1} of ${currentExam.questions.length}</div>
          <div class="q-text">${escapeHtml(q.text)}</div>
          <div class="q-options">
            ${options
              .map(
                (opt, oi) => `
              <label class="option-label ${savedAnswer === opt ? 'selected' : ''}" data-opt="${oi}">
                <input type="radio" name="q-${q.id}" value="${escapeHtml(opt)}"
                  ${savedAnswer === opt ? 'checked' : ''}
                  onchange="selectAnswer('${q.id}', '${escapeHtml(opt)}')">
                <span>${escapeHtml(opt)}</span>
              </label>
            `
              )
              .join('')}
          </div>
          <div class="saved-indicator" id="saved-${q.id}">Answer saved</div>
        </div>
      `;
      })
      .join('');
  }

  window.selectAnswer = (questionId, answer) => {
    savedAnswerMap.set(questionId, answer);

    // Highlight selected
    const qDiv = document.querySelector(`.exam-question[data-qid="${questionId}"]`);
    if (qDiv) {
      qDiv.querySelectorAll('.option-label').forEach((l) => l.classList.remove('selected'));
      const checked = qDiv.querySelector('input[type="radio"]:checked');
      if (checked) checked.closest('.option-label').classList.add('selected');
    }

    // Save durably to server
    send({
      type: 'save_answer',
      participantId,
      questionId,
      answer,
    });
  };

  function showSavedIndicator(questionId) {
    const el = document.getElementById(`saved-${questionId}`);
    if (el) {
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 2000);
    }
  }

  $('#btn-submit-answers').addEventListener('click', () => {
    if (!confirm('Are you sure you want to submit? You cannot change your answers after submission.')) return;
    send({ type: 'submit_exam', participantId });
  });

  // --- Timer ---
  function startTimer() {
    clearTimerInterval();
    updateTimerDisplay();
    timerInterval = setInterval(() => {
      remainingMs -= 1000;
      if (remainingMs <= 0) {
        remainingMs = 0;
        clearTimerInterval();
      }
      updateTimerDisplay();
    }, 1000);
  }

  function clearTimerInterval() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function updateTimerDisplay() {
    const el = $('#exam-timer');
    const totalSec = Math.max(0, Math.floor(remainingMs / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;

    if (h > 0) {
      el.textContent = `${h}:${pad(m)}:${pad(s)}`;
    } else {
      el.textContent = `${m}:${pad(s)}`;
    }

    el.className = 'timer';
    if (totalSec <= 60) el.classList.add('critical');
    else if (totalSec <= 300) el.classList.add('warning');
  }

  function pad(n) {
    return n.toString().padStart(2, '0');
  }

  // --- Results ---
  function showResultsScreen(results, examId, exam) {
    showScreen('results');
    clearTimerInterval();

    const container = $('#results-content');
    if (!results || !results.length) {
      container.innerHTML = '<p class="muted">No results available.</p>';
      return;
    }

    const totalQuestions = exam ? exam.questions.length : '?';

    let html = `
      <table class="results-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Name</th>
            <th>Score</th>
            <th>Answered</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    results.forEach((r, i) => {
      html += `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(r.user_name)}</td>
          <td class="result-score">${r.correct}/${totalQuestions}</td>
          <td>${r.answered}/${totalQuestions}</td>
          <td>${r.submitted_at ? 'Submitted' : 'Not submitted'}</td>
        </tr>
      `;
    });

    html += '</tbody></table>';

    // Show review if exam data is available
    if (exam && exam.questions) {
      html += '<h3>Answer Review</h3>';
      exam.questions.forEach((q, i) => {
        const myAnswer = savedAnswerMap.get(q.id);
        const isCorrect = myAnswer === q.correct_answer;
        html += `
          <div class="review-question">
            <strong>Q${i + 1}: ${escapeHtml(q.text)}</strong>
            <p>Your answer: <span class="${isCorrect ? 'answer-correct' : 'answer-wrong'}">
              ${myAnswer ? escapeHtml(myAnswer) : 'No answer'}
            </span></p>
            <p>Correct answer: <span class="answer-correct">${escapeHtml(q.correct_answer || 'N/A')}</span></p>
          </div>
        `;
      });
    }

    container.innerHTML = html;
  }

  $('#btn-back-to-lobby').addEventListener('click', () => {
    currentExam = null;
    participantId = null;
    savedAnswerMap.clear();
    showScreen('lobby');
    send({ type: 'list_exams' });
  });

  // --- Utilities ---
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function toast(message) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // --- Init ---
  connect();

  // If user already has a name, auto-register after connect
  if (userName) {
    // Will register on ws.onopen
  }
})();
