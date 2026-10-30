import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const QUESTION_SECONDS = 20;
export const BASE_POINTS = 500;
export const BONUS_PER_SECOND = 25;
export const MAX_PLAYERS = 20;
export const ROUND_ENDS = [4, 7, 10]; // 10 questions: rounds contain 4, 3 and 3 questions.
export const PRELOADED_QUIZ = [
  { text: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correctIndex: 1, explanation: 'Iron minerals on Mars give its surface a reddish appearance.' },
  { text: 'What is the value of 12 × 8?', options: ['86', '92', '96', '108'], correctIndex: 2, explanation: '12 multiplied by 8 equals 96.' },
  { text: 'Which gas do plants absorb during photosynthesis?', options: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], correctIndex: 2, explanation: 'Plants use carbon dioxide and water to make sugars.' },
  { text: 'What is the capital of Japan?', options: ['Seoul', 'Tokyo', 'Beijing', 'Bangkok'], correctIndex: 1, explanation: 'Tokyo is Japan’s capital.' },
  { text: 'Which data structure follows FIFO order?', options: ['Stack', 'Queue', 'Tree', 'Graph'], correctIndex: 1, explanation: 'A queue removes items in first-in, first-out order.' },
  { text: 'How many sides does a hexagon have?', options: ['5', '6', '7', '8'], correctIndex: 1, explanation: 'A hexagon has six sides.' },
  { text: 'Which ocean is the largest?', options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correctIndex: 3, explanation: 'The Pacific is the largest ocean.' },
  { text: 'What does CPU stand for?', options: ['Central Processing Unit', 'Computer Personal Unit', 'Core Program Utility', 'Central Power Utility'], correctIndex: 0, explanation: 'CPU means Central Processing Unit.' },
  { text: 'Which number is prime?', options: ['21', '27', '29', '33'], correctIndex: 2, explanation: '29 has exactly two positive divisors.' },
  { text: 'What is the boiling point of water at sea level?', options: ['50°C', '90°C', '100°C', '120°C'], correctIndex: 2, explanation: 'At standard pressure, water boils at 100°C.' }
];

export function remainingSeconds(deadlineAt, now) {
  return Math.max(0, Math.ceil((deadlineAt - now) / 1000));
}
export function calculateScore(correct, deadlineAt, receivedAt) {
  if (!correct || receivedAt >= deadlineAt) return 0;
  return BASE_POINTS + BONUS_PER_SECOND * remainingSeconds(deadlineAt, receivedAt);
}
export function validateQuiz(quiz) {
  const errors = [];
  if (!quiz || typeof quiz !== 'object') return { ok: false, errors: ['Quiz must be an object.'] };
  const title = typeof quiz.title === 'string' ? quiz.title.trim() : '';
  if (title.length < 3 || title.length > 80) errors.push('Quiz title must contain 3–80 characters.');
  if (!Array.isArray(quiz.questions) || quiz.questions.length !== 10) errors.push('A quiz must contain exactly 10 questions.');
  else quiz.questions.forEach((q, i) => {
    if (!q || typeof q !== 'object') { errors.push(`Question ${i + 1} is invalid.`); return; }
    if (typeof q.text !== 'string' || q.text.trim().length < 8 || q.text.trim().length > 240) errors.push(`Question ${i + 1}: text must contain 8–240 characters.`);
    if (!Array.isArray(q.options) || q.options.length !== 4) errors.push(`Question ${i + 1}: exactly four options are required.`);
    else {
      const opts = q.options.map(x => typeof x === 'string' ? x.trim() : '');
      if (opts.some(x => x.length < 1 || x.length > 100)) errors.push(`Question ${i + 1}: options must contain 1–100 characters.`);
      if (new Set(opts.map(x => x.toLowerCase())).size !== 4) errors.push(`Question ${i + 1}: options must be unique.`);
    }
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) errors.push(`Question ${i + 1}: correctIndex must be 0–3.`);
    if (q.explanation !== undefined && (typeof q.explanation !== 'string' || q.explanation.length > 500)) errors.push(`Question ${i + 1}: explanation must be at most 500 characters.`);
  });
  return { ok: errors.length === 0, errors };
}
const token = () => randomBytes(32).toString('base64url');
const roomCode = () => randomBytes(3).toString('hex').toUpperCase();
const validName = n => typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 18;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function publicRoom(room) {
  return { code: room.code, hostId: room.hostId, hostGeneration: room.hostGeneration, phase: room.phase, players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, connected: p.connected, score: p.score })), questionNumber: room.questionIndex + 1, totalQuestions: room.questions.length };
}
function playerView(room, playerId, now) {
  const player = room.players[playerId];
  const question = room.questions[room.questionIndex];
  const phase = room.phase;
  const reveal = (phase === 'reveal' || phase === 'finished') && question ? { correctAnswer: question.options[question.correctIndex], explanation: question.explanation || '' } : null;
  return {
    roomCode: room.code, hostId: room.hostId, hostGeneration: room.hostGeneration, phase,
    round: room.questionIndex < 4 ? 1 : room.questionIndex < 7 ? 2 : 3,
    questionNumber: Math.min(room.questionIndex + 1, room.questions.length), totalQuestions: room.questions.length,
    deadlineAt: phase === 'question' ? room.deadlineAt : null,
    serverNow: now,
    question: question ? { text: question.text, options: [...question.options] } : null,
    answered: Boolean(player?.answers?.[room.questionIndex]),
    reveal,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected })),
    winnerId: room.winnerId || null, winnerName: room.winnerName || null,
    matchId: room.matchId || null
  };
}

async function readEntry(store, key) {
  return store.getWithMetadata(key, { consistency: 'strong', type: 'json' });
}
async function cas(store, key, current, next) {
  return store.setJSON(key, next, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
}
async function mutateRoom(store, code, mutate, retries = 12) {
  const key = `room:${code}`;
  for (let i = 0; i < retries; i++) {
    const current = await readEntry(store, key);
    if (!current) return { error: 'Room not found.', status: 404 };
    const next = structuredClone(current.data);
    const result = await mutate(next);
    if (result?.error) return result;
    if (result?.noWrite) return { room: current.data, result };
    const saved = await cas(store, key, current, next);
    if (saved.modified) return { room: next, result };
  }
  return { error: 'The room is busy. Please retry.', status: 409 };
}
async function rateLimit(store, ip, action, limit, now) {
  const key = `limit:${createHash('sha256').update(`${action}:${ip}`).digest('hex')}`;
  for (let i = 0; i < 8; i++) {
    const current = await readEntry(store, key);
    const value = current?.data;
    const fresh = value && value.resetAt > now ? value : { count: 0, resetAt: now + 60_000 };
    if (fresh.count >= limit) return false;
    const next = { count: fresh.count + 1, resetAt: fresh.resetAt };
    const saved = await cas(store, key, current, next);
    if (saved.modified) return true;
  }
  return false;
}
function advanceClock(room, now) {
  if (room.phase === 'question' && now >= room.deadlineAt) {
    for (const player of Object.values(room.players)) {
      const answer = player.answers[room.questionIndex];
      if (answer && !answer.applied) { player.score += answer.points; answer.applied = true; }
    }
    room.phase = 'reveal';
    room.revealAt = room.deadlineAt + 1800;
  }
  if (room.phase === 'reveal' && now >= room.revealAt) {
    if (room.questionIndex + 1 >= room.questions.length) {
      room.phase = 'finished';
      const ranking = Object.values(room.players).sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
      room.winnerId = ranking[0]?.id || null;
      room.winnerName = ranking[0]?.name || null;
      room.completedAt = now;
      room.matchId ||= randomUUID();
    } else {
      room.questionIndex++;
      room.phase = 'question';
      room.deadlineAt = now + QUESTION_SECONDS * 1000;
      room.revealAt = null;
    }
  }
}
function migrateHost(room) {
  const connected = Object.values(room.players).filter(p => p.connected).sort((a, b) => a.joinedAt - b.joinedAt);
  if (room.hostId && !room.players[room.hostId]?.connected && connected.length) {
    room.hostId = connected[0].id;
    room.hostGeneration++;
  }
}
function markStalePlayers(room, now) {
  for (const p of Object.values(room.players)) {
    if (p.connected && now - p.lastSeenAt > 4000) { p.connected = false; p.disconnectedAt = p.lastSeenAt + 2000; }
    if (!p.connected && p.disconnectedAt && now > p.disconnectedAt + 30_000) p.expired = true;
  }
  migrateHost(room);
}

export function createGameHandler({ getStore, now = () => Date.now(), getIp = req => req.headers.get('x-nf-client-connection-ip') || 'unknown' }) {
  return async function handler(request) {
    if (request.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON.' }, 400); }
    if (!body || typeof body.action !== 'string') return json({ ok: false, error: 'Missing action.' }, 400);
    const store = getStore();
    const time = now();
    const ip = getIp(request);
    try {
      if (body.action === 'history') {
        const { blobs } = await store.list({ prefix: 'match:' });
        const matches = await Promise.all(blobs.map(async b => store.get(b.key, { consistency: 'strong', type: 'json' })));
        return json({ ok: true, matches: matches.filter(Boolean).sort((a, b) => b.completedAt - a.completedAt).slice(0, 10) });
      }
      if (body.action === 'create') {
        if (!await rateLimit(store, ip, 'create', 3, time)) return json({ ok: false, error: 'Too many room creation attempts. Wait one minute.' }, 429);
        if (!validName(body.name) || typeof body.playerId !== 'string' || body.playerId.length > 80) return json({ ok: false, error: 'Enter a valid nickname.' }, 400);
        for (let attempt = 0; attempt < 8; attempt++) {
          const code = roomCode();
          const playerToken = token();
          const room = { code, hostId: body.playerId, hostGeneration: 1, phase: 'lobby', players: { [body.playerId]: { id: body.playerId, name: body.name.trim(), token: playerToken, connected: true, lastSeenAt: time, disconnectedAt: null, joinedAt: time, score: 0, answers: {} } }, questions: structuredClone(PRELOADED_QUIZ), questionIndex: 0, deadlineAt: null, revealAt: null, createdAt: time };
          const saved = await store.setJSON(`room:${code}`, room, { onlyIfNew: true });
          if (saved.modified) return json({ ok: true, token: playerToken, playerId: body.playerId, room: publicRoom(room) });
        }
        return json({ ok: false, error: 'Could not allocate a room. Try again.' }, 503);
      }
      if (body.action === 'join') {
        if (!await rateLimit(store, ip, 'join', 8, time)) return json({ ok: false, error: 'Too many join attempts. Wait one minute.' }, 429);
        const code = String(body.roomCode || '').toUpperCase();
        if (!/^[A-F0-9]{6}$/.test(code)) {
          if (!await rateLimit(store, ip, 'invalid-code', 5, time)) return json({ ok: false, error: 'Too many invalid room-code attempts. Wait one minute.' }, 429);
          return json({ ok: false, error: 'Enter a valid six-character room code.' }, 400);
        }
        const changed = await mutateRoom(store, code, room => {
          if (room.phase !== 'lobby') return { error: 'This match has already started.', status: 409 };
          if (Object.keys(room.players).length >= MAX_PLAYERS) return { error: 'Room is full.', status: 409 };
          if (!validName(body.name) || typeof body.playerId !== 'string' || body.playerId.length > 80) return { error: 'Enter a valid nickname.', status: 400 };
          if (room.players[body.playerId]) return { error: 'This player session is already in the room.', status: 409 };
          if (Object.values(room.players).some(p => p.name.toLowerCase() === body.name.trim().toLowerCase())) return { error: 'That nickname is already in this room.', status: 409 };
          const playerToken = token();
          room.players[body.playerId] = { id: body.playerId, name: body.name.trim(), token: playerToken, connected: true, lastSeenAt: time, disconnectedAt: null, joinedAt: time, score: 0, answers: {} };
          return { token: playerToken };
        });
        if (changed.error) {
          if (changed.status === 404 && !await rateLimit(store, ip, 'invalid-code', 5, time)) return json({ ok: false, error: 'Too many invalid room-code attempts. Wait one minute.' }, 429);
          return json({ ok: false, error: changed.error }, changed.status);
        }
        return json({ ok: true, token: changed.result.token, playerId: body.playerId, room: publicRoom(changed.room) });
      }
      const code = String(body.roomCode || '').toUpperCase();
      if (body.action === 'reconnect') {
        const changed = await mutateRoom(store, code, room => {
          const p = room.players[body.playerId];
          if (!p || p.token !== body.token) return { error: 'Invalid reconnect credentials.', status: 403 };
          const inferredDisconnectAt = p.disconnectedAt || (time - p.lastSeenAt > 4000 ? p.lastSeenAt + 2000 : null);
          if (inferredDisconnectAt && time > inferredDisconnectAt + 30_000) return { error: 'The 30-second reconnection window expired.', status: 410 };
          if (inferredDisconnectAt) { p.connected = false; p.disconnectedAt = inferredDisconnectAt; markStalePlayers(room, time); }
          p.connected = true; p.disconnectedAt = null; p.expired = false; p.lastSeenAt = time; p.token = token();
          return { token: p.token };
        });
        if (changed.error) return json({ ok: false, error: changed.error }, changed.status);
        return json({ ok: true, token: changed.result.token, room: publicRoom(changed.room), state: playerView(changed.room, body.playerId, time) });
      }
      if (body.action === 'poll') {
        const changed = await mutateRoom(store, code, room => {
          const p = room.players[body.playerId];
          if (!p || p.token !== body.token) return { error: 'Session expired. Reconnect to continue.', status: 403 };
          const inferredDisconnectAt = p.disconnectedAt || (time - p.lastSeenAt > 4000 ? p.lastSeenAt + 2000 : null);
          if (inferredDisconnectAt && time > inferredDisconnectAt + 30_000) return { error: 'The 30-second reconnection window expired.', status: 410 };
          const needsHeartbeat = !p.connected || time - p.lastSeenAt >= 2000;
          const needsStaleCheck = Object.values(room.players).some(x => x.connected && time - x.lastSeenAt > 4000);
          const needsAdvance = (room.phase === 'question' && time >= room.deadlineAt) || (room.phase === 'reveal' && time >= room.revealAt);
          if (!needsHeartbeat && !needsStaleCheck && !needsAdvance) return { noWrite: true };
          p.connected = true; p.lastSeenAt = time; p.disconnectedAt = null;
          markStalePlayers(room, time);
          advanceClock(room, time);
          return {};
        });
        if (changed.error) return json({ ok: false, error: changed.error }, changed.status);
        if (changed.room.phase === 'finished' && !changed.room.historySaved) {
          const history = { id: changed.room.matchId, roomCode: changed.room.code, completedAt: changed.room.completedAt, winnerName: changed.room.winnerName, playerCount: Object.keys(changed.room.players).length, players: Object.values(changed.room.players).map(p => ({ id: p.id, name: p.name, score: p.score })) };
          const saved = await store.setJSON(`match:${history.id}`, history, { onlyIfNew: true });
          await mutateRoom(store, code, room => { room.historySaved = true; return {}; });
        }
        return json({ ok: true, state: playerView(changed.room, body.playerId, time), room: publicRoom(changed.room) });
      }
      if (body.action === 'quiz:create') {
        const validation = validateQuiz(body.quiz);
        if (!validation.ok) return json({ ok: false, error: validation.errors.join(' ') }, 400);
        const changed = await mutateRoom(store, code, room => {
          const p = room.players[body.playerId];
          if (!p || p.token !== body.token || room.hostId !== p.id || body.hostGeneration !== room.hostGeneration) return { error: 'Only the current host can change the quiz.', status: 403 };
          if (room.phase !== 'lobby') return { error: 'The quiz is locked after the match starts.', status: 409 };
          room.quizTitle = body.quiz.title.trim();
          room.questions = body.quiz.questions.map(q => ({ text: q.text.trim(), options: q.options.map(o => o.trim()), correctIndex: q.correctIndex, explanation: q.explanation || '' }));
          return {};
        });
        if (changed.error) return json({ ok: false, error: changed.error }, changed.status);
        return json({ ok: true, quizTitle: changed.room.quizTitle || 'Custom quiz', questionCount: changed.room.questions.length });
      }
      if (body.action === 'start') {
        const changed = await mutateRoom(store, code, room => {
          const p = room.players[body.playerId];
          if (!p || p.token !== body.token || room.hostId !== p.id || body.hostGeneration !== room.hostGeneration) return { error: 'Only the current host can start this room.', status: 403 };
          if (room.phase !== 'lobby' || Object.keys(room.players).length < 2) return { error: 'At least two players are required.', status: 409 };
          room.phase = 'question'; room.questionIndex = 0; room.deadlineAt = time + QUESTION_SECONDS * 1000; room.revealAt = null;
          for (const player of Object.values(room.players)) { player.score = 0; player.answers = {}; }
          return {};
        });
        if (changed.error) return json({ ok: false, error: changed.error }, changed.status);
        return json({ ok: true, room: publicRoom(changed.room), state: playerView(changed.room, body.playerId, time) });
      }
      if (body.action === 'answer') {
        const changed = await mutateRoom(store, code, room => {
          const p = room.players[body.playerId];
          if (!p || p.token !== body.token) return { error: 'Invalid player session.', status: 403 };
          if (room.phase !== 'question' || time >= room.deadlineAt) return { error: 'The question deadline has passed.', status: 409 };
          if (p.answers[room.questionIndex]) return { error: 'Your answer is already locked.', status: 409 };
          if (!Number.isInteger(body.optionIndex) || body.optionIndex < 0 || body.optionIndex > 3) return { error: 'Invalid answer selection.', status: 400 };
          const q = room.questions[room.questionIndex];
          const correct = body.optionIndex === q.correctIndex;
          const seconds = remainingSeconds(room.deadlineAt, time);
          const points = calculateScore(correct, room.deadlineAt, time);
          p.answers[room.questionIndex] = { optionIndex: body.optionIndex, correct, points, remainingSeconds: seconds, receivedAt: time };
          return { accepted: true }; 
        });
        if (changed.error) return json({ ok: false, error: changed.error }, changed.status);
        return json({ ok: true, result: changed.result, state: playerView(changed.room, body.playerId, time) });
      }
      return json({ ok: false, error: 'Unknown action.' }, 400);
    } catch (error) {
      console.error('game function error', error);
      return json({ ok: false, error: 'The game service is temporarily unavailable.' }, 500);
    }
  };
}
