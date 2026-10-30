import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameHandler, PRELOADED_QUIZ, remainingSeconds, calculateScore, validateQuiz } from '../src/server/game-core.js';

class MemoryStore {
  constructor() { this.data = new Map(); this.version = 0; }
  async getWithMetadata(key) {
    const entry = this.data.get(key);
    return entry ? { data: structuredClone(entry.value), etag: entry.etag, metadata: {} } : null;
  }
  async setJSON(key, value, options = {}) {
    const current = this.data.get(key);
    if (options.onlyIfNew && current) return { modified: false };
    if (options.onlyIfMatch && (!current || current.etag !== options.onlyIfMatch)) return { modified: false };
    const etag = `"v${++this.version}"`;
    this.data.set(key, { value: structuredClone(value), etag });
    return { modified: true, etag };
  }
  async get(key) { const entry = this.data.get(key); return entry ? structuredClone(entry.value) : null; }
  async list({ prefix = '' } = {}) { return { blobs: [...this.data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, etag: this.data.get(key).etag })) }; }
}
function harness() {
  const store = new MemoryStore(); let clock = 1_800_000_000_000;
  const handler = createGameHandler({ getStore: () => store, now: () => clock, getIp: () => '198.51.100.7' });
  const call = async (action, payload = {}) => {
    const response = await handler(new Request('https://local/.netlify/functions/game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }) }));
    return { status: response.status, body: await response.json() };
  };
  return { store, call, setTime: value => { clock = value; }, time: () => clock };
}
async function makeTwoPlayers(h) {
  const a = await h.call('create', { playerId: 'p1', name: 'Player One' });
  assert.equal(a.status, 200);
  const b = await h.call('join', { playerId: 'p2', name: 'Player Two', roomCode: a.body.room.code });
  assert.equal(b.status, 200);
  return {
    code: a.body.room.code,
    p1: { playerId: 'p1', token: a.body.token, hostGeneration: 1 },
    p2: { playerId: 'p2', token: b.body.token, hostGeneration: 1 }
  };
}

test('rounding rule and 500 + 25-per-second scoring are consistent', () => {
  assert.equal(remainingSeconds(20_000, 1_000), 19);
  assert.equal(remainingSeconds(20_000, 19_001), 1);
  assert.equal(remainingSeconds(20_000, 20_000), 0);
  assert.equal(calculateScore(true, 20_000, 1_000), 975);
  assert.equal(calculateScore(false, 20_000, 1_000), 0);
  assert.equal(calculateScore(true, 20_000, 20_000), 0);
});

test('two players complete all three rounds; answer key stays hidden until close; scoring and winner persist', async () => {
  const h = harness(); const players = await makeTwoPlayers(h);
  let started = await h.call('start', { roomCode: players.code, ...players.p1 });
  assert.equal(started.status, 200);
  assert.equal(started.body.state.round, 1);
  let state = started.body.state;
  let p1Expected = 0;

  for (let index = 0; index < PRELOADED_QUIZ.length; index++) {
    const q = PRELOADED_QUIZ[index];
    assert.equal(state.round, index < 4 ? 1 : index < 7 ? 2 : 3);
    assert.equal(state.phase, 'question');
    assert.equal(state.question.text, q.text);
    assert.equal(state.reveal, null);
    assert.equal(JSON.stringify(state).includes('correctIndex'), false);

    h.setTime(state.deadlineAt - 1_000);
    const answer1 = await h.call('answer', { roomCode: players.code, ...players.p1, optionIndex: q.correctIndex });
    assert.equal(answer1.status, 200);
    assert.deepEqual(answer1.body.result, { accepted: true });
    assert.equal(answer1.body.state.reveal, null);
    assert.equal(answer1.body.state.players.find(p => p.id === 'p1').score, p1Expected);

    const answer2 = await h.call('answer', { roomCode: players.code, ...players.p2, optionIndex: (q.correctIndex + 1) % 4 });
    assert.equal(answer2.status, 200);
    const duplicate = await h.call('answer', { roomCode: players.code, ...players.p1, optionIndex: q.correctIndex });
    assert.equal(duplicate.status, 409);

    const seconds = remainingSeconds(state.deadlineAt, h.time());
    p1Expected += 500 + 25 * seconds;
    h.setTime(state.deadlineAt);
    const late = await h.call('answer', { roomCode: players.code, ...players.p2, optionIndex: q.correctIndex });
    assert.equal(late.status, 409);

    const reveal = await h.call('poll', { roomCode: players.code, ...players.p1 });
    assert.equal(reveal.status, 200);
    assert.equal(reveal.body.state.phase, 'reveal');
    assert.equal(reveal.body.state.reveal.correctAnswer, q.options[q.correctIndex]);
    assert.equal(reveal.body.state.players.find(p => p.id === 'p1').score, p1Expected);
    assert.equal(reveal.body.state.players.find(p => p.id === 'p2').score, 0);

    h.setTime(state.deadlineAt + 1_800);
    const next = await h.call('poll', { roomCode: players.code, ...players.p1 });
    assert.equal(next.status, 200);
    state = next.body.state;
    if (index < PRELOADED_QUIZ.length - 1) {
      assert.equal(state.phase, 'question');
      assert.equal(state.questionNumber, index + 2);
    } else {
      assert.equal(state.phase, 'finished');
      assert.equal(state.round, 3);
      assert.equal(state.winnerName, 'Player One');
      assert.equal(state.players.find(p => p.id === 'p1').score, p1Expected);
      assert.equal(state.players.find(p => p.id === 'p2').score, 0);
      const history = await h.call('history');
      assert.equal(history.status, 200);
      assert.equal(history.body.matches.length, 1);
      assert.equal(history.body.matches[0].winnerName, 'Player One');
      assert.equal(history.body.matches[0].players.find(p => p.id === 'p1').score, p1Expected);
    }
  }
});

test('conditional writes preserve concurrent answers from two players', async () => {
  const h = harness(); const players = await makeTwoPlayers(h);
  const start = await h.call('start', { roomCode: players.code, ...players.p1 });
  const q = PRELOADED_QUIZ[0];
  const results = await Promise.all([
    h.call('answer', { roomCode: players.code, ...players.p1, optionIndex: q.correctIndex }),
    h.call('answer', { roomCode: players.code, ...players.p2, optionIndex: q.correctIndex })
  ]);
  assert.ok(results.every(x => x.status === 200));
  h.setTime(start.body.state.deadlineAt);
  const reveal = await h.call('poll', { roomCode: players.code, ...players.p1 });
  assert.equal(reveal.body.state.players.reduce((n, p) => n + p.score, 0), 2 * 1_000);
});

test('host migration revokes old host authority', async () => {
  const h = harness(); const players = await makeTwoPlayers(h);
  h.setTime(h.time() + 5_000);
  const poll = await h.call('poll', { roomCode: players.code, ...players.p2 });
  assert.equal(poll.body.room.hostId, 'p2');
  assert.equal(poll.body.room.hostGeneration, 2);
  const oldHost = await h.call('start', { roomCode: players.code, ...players.p1, hostGeneration: 1 });
  assert.equal(oldHost.status, 403);
  const newHost = await h.call('start', { roomCode: players.code, ...players.p2, hostGeneration: 2 });
  assert.equal(newHost.status, 200);
});

test('room creation, join and invalid room-code attempts are rate limited', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) assert.equal((await h.call('create', { playerId: `c${i}`, name: `Creator ${i}` })).status, 200);
  assert.equal((await h.call('create', { playerId: 'c4', name: 'Creator 4' })).status, 429);
  const h2 = harness();
  for (let i = 0; i < 5; i++) await h2.call('join', { playerId: `x${i}`, name: `Guest ${i}`, roomCode: 'ZZ' });
  const limited = await h2.call('join', { playerId: 'x6', name: 'Guest 6', roomCode: 'ZZ' });
  assert.equal(limited.status, 429);
});

test('host-created quiz validation rejects malformed content and accepts a valid 10-question quiz', () => {
  assert.equal(validateQuiz({ title: 'Good Quiz', questions: PRELOADED_QUIZ }).ok, true);
  const invalid = structuredClone(PRELOADED_QUIZ);
  invalid[0].options[1] = invalid[0].options[0];
  invalid[0].correctIndex = 8;
  assert.equal(validateQuiz({ title: 'x', questions: invalid }).ok, false);
});

test('a reconnect after the 30-second grace period is rejected', async () => {
  const h = harness(); const players = await makeTwoPlayers(h);
  h.setTime(h.time() + 33_000);
  const late = await h.call('poll', { roomCode: players.code, ...players.p1 });
  assert.equal(late.status, 410);
});

test('valid room joins are rate limited independently of invalid-code attempts', async () => {
  const h = harness();
  const created = await h.call('create', { playerId: 'host', name: 'Host Player' });
  for (let i = 0; i < 8; i++) {
    const joined = await h.call('join', { playerId: `join-${i}`, name: `Guest ${i}`, roomCode: created.body.room.code });
    assert.equal(joined.status, 200);
  }
  const limited = await h.call('join', { playerId: 'join-9', name: 'Guest Nine', roomCode: created.body.room.code });
  assert.equal(limited.status, 429);
});

test('reconnecting previous host returns as a player and does not regain host control', async () => {
  const h = harness(); const players = await makeTwoPlayers(h);
  h.setTime(h.time() + 5_000);
  const migration = await h.call('poll', { roomCode: players.code, ...players.p2 });
  assert.equal(migration.body.room.hostId, 'p2');
  h.setTime(h.time() + 1_000);
  const rejoined = await h.call('poll', { roomCode: players.code, ...players.p1 });
  assert.equal(rejoined.status, 200);
  assert.equal(rejoined.body.room.hostId, 'p2');
  assert.equal(rejoined.body.room.hostGeneration, 2);
  const oldHostCommand = await h.call('start', { roomCode: players.code, ...players.p1, hostGeneration: 2 });
  assert.equal(oldHostCommand.status, 403);
});

test('server validates a host-created quiz before allowing it into a match', async () => {
  const h = harness(); const players = await makeTwoPlayers(h);
  const invalid = await h.call('quiz:create', { roomCode: players.code, ...players.p1, quiz: { title: 'Bad', questions: [{ text: 'Too short', options: ['A', 'A', 'C', 'D'], correctIndex: 9 }] } });
  assert.equal(invalid.status, 400);
  const valid = await h.call('quiz:create', { roomCode: players.code, ...players.p1, quiz: { title: 'Custom quiz', questions: PRELOADED_QUIZ } });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.questionCount, 10);
  const start = await h.call('start', { roomCode: players.code, ...players.p1 });
  assert.equal(start.status, 200);
  assert.equal(start.body.state.question.text, PRELOADED_QUIZ[0].text);
});
