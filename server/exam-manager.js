const { v4: uuidv4 } = require('uuid');
const { db, stmts } = require('./db');

// Active exam timers
const examTimers = new Map();

class ExamManager {
  constructor(broadcast) {
    this.broadcast = broadcast; // function(examId, message) to send to all in exam
    this._restoreActiveExams();
  }

  // On server restart, restore timers for any active exams
  _restoreActiveExams() {
    const activeExams = db.prepare(
      `SELECT * FROM exams WHERE status = 'active'`
    ).all();
    for (const exam of activeExams) {
      const endsAt = new Date(exam.ends_at + 'Z').getTime();
      const remaining = endsAt - Date.now();
      if (remaining <= 0) {
        this.endExam(exam.id);
      } else {
        this._scheduleEnd(exam.id, remaining);
      }
    }
  }

  registerUser(userId, name) {
    stmts.upsertUser.run(userId, name);
    return stmts.getUser.get(userId);
  }

  createExam(userId, title, durationSeconds, questions) {
    const examId = uuidv4();
    stmts.createExam.run(examId, title, userId, durationSeconds);

    const addQuestions = db.transaction((qs) => {
      for (let i = 0; i < qs.length; i++) {
        const q = qs[i];
        stmts.addQuestion.run(
          uuidv4(),
          examId,
          i,
          q.text,
          q.type || 'multiple_choice',
          q.options ? JSON.stringify(q.options) : null,
          q.correct_answer || null
        );
      }
    });
    addQuestions(questions);

    // Creator auto-joins
    const participantId = uuidv4();
    stmts.joinExam.run(participantId, examId, userId);

    return this.getExamFull(examId);
  }

  getExamFull(examId) {
    const exam = stmts.getExam.get(examId);
    if (!exam) return null;
    const questions = stmts.getQuestions.all(examId);
    const participants = stmts.listParticipants.all(examId);
    return {
      ...exam,
      questions: questions.map((q) => ({
        ...q,
        options: q.options ? JSON.parse(q.options) : null,
        // Only include correct_answer if exam has ended
        correct_answer: exam.status === 'ended' ? q.correct_answer : undefined,
      })),
      participants,
    };
  }

  listExams() {
    return stmts.listJoinableExams.all();
  }

  joinExam(examId, userId) {
    const exam = stmts.getExam.get(examId);
    if (!exam) throw new Error('Exam not found');
    if (exam.status === 'ended') throw new Error('Exam has already ended');

    let participant = stmts.getParticipant.get(examId, userId);
    if (!participant) {
      const participantId = uuidv4();
      stmts.joinExam.run(participantId, examId, userId);
      participant = stmts.getParticipant.get(examId, userId);
    }

    // Notify other participants
    this.broadcast(examId, {
      type: 'participant_joined',
      userId,
      userName: stmts.getUser.get(userId)?.name,
      participantCount: stmts.listParticipants.all(examId).length,
    });

    return {
      exam: this.getExamFull(examId),
      participantId: participant.id,
      // Restore any previously saved answers
      savedAnswers: stmts.getAnswers.all(participant.id),
    };
  }

  startExam(examId, userId) {
    const exam = stmts.getExam.get(examId);
    if (!exam) throw new Error('Exam not found');
    if (exam.creator_id !== userId) throw new Error('Only the creator can start the exam');
    if (exam.status !== 'draft') throw new Error('Exam can only be started from draft status');

    stmts.startExam.run(exam.duration_seconds, examId);
    const updated = stmts.getExam.get(examId);

    const endsAt = new Date(updated.ends_at + 'Z').getTime();
    const remaining = endsAt - Date.now();
    this._scheduleEnd(examId, remaining);

    this.broadcast(examId, {
      type: 'exam_started',
      exam: this.getExamFull(examId),
      remainingMs: remaining,
    });

    return this.getExamFull(examId);
  }

  _scheduleEnd(examId, delayMs) {
    if (examTimers.has(examId)) {
      clearTimeout(examTimers.get(examId));
    }
    const timer = setTimeout(() => {
      this.endExam(examId);
    }, Math.max(0, delayMs));
    examTimers.set(examId, timer);
  }

  endExam(examId) {
    if (examTimers.has(examId)) {
      clearTimeout(examTimers.get(examId));
      examTimers.delete(examId);
    }
    stmts.endExam.run(examId);

    this.broadcast(examId, {
      type: 'exam_ended',
      examId,
      results: this.getResults(examId),
    });

    return this.getExamFull(examId);
  }

  saveAnswer(participantId, questionId, answer) {
    const participant = stmts.getParticipantById.get(participantId);
    if (!participant) throw new Error('Participant not found');

    const exam = stmts.getExam.get(participant.exam_id);
    if (!exam || exam.status !== 'active') throw new Error('Exam is not active');

    if (participant.submitted_at) throw new Error('Already submitted');

    const answerId = uuidv4();
    stmts.saveAnswer.run(answerId, participantId, questionId, answer);

    return { saved: true, answerId };
  }

  submitExam(participantId) {
    const participant = stmts.getParticipantById.get(participantId);
    if (!participant) throw new Error('Participant not found');
    if (participant.submitted_at) throw new Error('Already submitted');

    stmts.markSubmitted.run(participantId);

    const exam = stmts.getExam.get(participant.exam_id);
    this.broadcast(exam.id, {
      type: 'participant_submitted',
      userId: participant.user_id,
      userName: stmts.getUser.get(participant.user_id)?.name,
    });

    return { submitted: true };
  }

  getResults(examId) {
    return stmts.getExamResults.all(examId);
  }

  getMyAnswers(participantId) {
    return stmts.getAnswers.all(participantId);
  }

  getRemainingTime(examId) {
    const exam = stmts.getExam.get(examId);
    if (!exam || exam.status !== 'active') return 0;
    const endsAt = new Date(exam.ends_at + 'Z').getTime();
    return Math.max(0, endsAt - Date.now());
  }
}

module.exports = ExamManager;
