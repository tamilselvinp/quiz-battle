import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const ENDPOINT = '/.netlify/functions/game';
async function callGame(action, payload = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `Game request failed (${response.status}).`);
  return data;
}

function App() {
  const playerId = useMemo(() => {
    let id = sessionStorage.getItem('qb-player');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('qb-player', id); }
    return id;
  }, []);
  const [screen, setScreen] = useState('home');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [room, setRoom] = useState(null);
  const [game, setGame] = useState(null);
  const [session, setSession] = useState(() => ({ roomCode: sessionStorage.getItem('qb-room') || '', token: sessionStorage.getItem('qb-token') || '' }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [serverOffset, setServerOffset] = useState(0);
  const [history, setHistory] = useState([]);

  const saveSession = (roomCode, token) => {
    sessionStorage.setItem('qb-room', roomCode);
    sessionStorage.setItem('qb-token', token);
    setSession({ roomCode, token });
  };
  const clearSession = () => {
    sessionStorage.removeItem('qb-room'); sessionStorage.removeItem('qb-token');
    setSession({ roomCode: '', token: '' }); setRoom(null); setGame(null);
  };
  const apply = data => {
    if (data.room) setRoom(data.room);
    if (data.state) {
      setGame(data.state);
      setServerOffset((data.state.serverNow || Date.now()) - Date.now());
      if (data.state.phase === 'lobby') setScreen('lobby');
      else if (data.state.phase === 'finished') setScreen('finished');
      else setScreen('game');
    } else if (data.room?.phase === 'lobby') setScreen('lobby');
  };
  const act = async (action, payload = {}) => {
    setBusy(true); setError('');
    try { return await callGame(action, payload); }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    callGame('history').then(d => setHistory(d.matches || [])).catch(() => {});
  // Restore once on initial mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setSelected(null); }, [game?.questionNumber]);

  useEffect(() => {
    if (!session.roomCode || !session.token) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const data = await callGame('poll', { roomCode: session.roomCode, playerId, token: session.token });
        if (!stopped) { apply(data); if (data.state?.phase === 'finished') stopped = true; }
      } catch (e) {
        if (!stopped && e.message.includes('reconnection window expired')) { setError(e.message); clearSession(); setScreen('home'); }
        else if (!stopped && !e.message.includes('Session expired')) setError(e.message);
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 250);
    return () => { stopped = true; clearTimeout(timer); };
  // token changes when a player reconnects; restart the polling loop with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.roomCode, session.token, playerId]);

  const me = (game?.players || room?.players || []).find(p => p.id === playerId);
  const isHost = room?.hostId === playerId;
  const remaining = game?.deadlineAt ? Math.max(0, Math.ceil((game.deadlineAt - (now + serverOffset)) / 1000)) : 0;
  const withSession = { roomCode: session.roomCode || room?.code, playerId, token: session.token, hostGeneration: room?.hostGeneration ?? game?.hostGeneration };

  const createRoom = async () => {
    const data = await act('create', { playerId, name: name.trim() });
    if (data) { saveSession(data.room.code, data.token); setRoom(data.room); setScreen('lobby'); }
  };
  const joinRoom = async () => {
    const data = await act('join', { playerId, name: name.trim(), roomCode: code.trim().toUpperCase() });
    if (data) { saveSession(data.room.code, data.token); setRoom(data.room); setScreen('lobby'); }
  };
  const startGame = async () => {
    const data = await act('start', withSession);
    if (data) apply(data);
  };
  const submitAnswer = async () => {
    if (selected === null) return;
    const data = await act('answer', { ...withSession, optionIndex: selected });
    if (data) { setGame(data.state); setSelected(null); }
  };

  return <main className="max-w-5xl mx-auto px-4 py-8 md:py-12">
    <header className="flex items-center justify-between mb-8 gap-3"><div><div className="text-xs tracking-[.3em] text-violet-300 font-bold">MULTIPLAYER QUIZ ARENA</div><h1 className="text-3xl md:text-4xl font-black mt-1">QUIZ <span className="text-violet-300">BATTLE</span></h1></div><span className="pill">INDIVIDUAL MODE · 2–20 PLAYERS</span></header>
    {error && <div role="alert" className="mb-5 p-3 rounded-xl border border-red-500/40 bg-red-950/50 text-red-200">{error}<button className="float-right" onClick={() => setError('')}>×</button></div>}

    {screen === 'home' && <div className="grid md:grid-cols-2 gap-5">
      <section className="panel p-6"><h2 className="text-xl font-bold mb-1">Create a battle</h2><p className="muted text-sm mb-5">Start a private room and invite a challenger.</p><label className="block text-sm mb-2">Your nickname</label><input className="field mb-4" maxLength="18" placeholder="Enter nickname" value={name} onChange={e => setName(e.target.value)}/><button className="btn w-full" disabled={busy || name.trim().length < 2} onClick={createRoom}>Create private room</button></section>
      <section className="panel p-6"><h2 className="text-xl font-bold mb-1">Join a battle</h2><p className="muted text-sm mb-5">Enter the six-character room code from your host.</p><label className="block text-sm mb-2">Your nickname</label><input className="field mb-3" maxLength="18" placeholder="Enter nickname" value={name} onChange={e => setName(e.target.value)}/><input aria-label="Room code" className="field mb-4 uppercase tracking-[.25em]" maxLength="6" placeholder="ROOM CODE" value={code} onChange={e => setCode(e.target.value.toUpperCase())}/><button className="btn w-full" disabled={busy || name.trim().length < 2 || code.trim().length !== 6} onClick={joinRoom}>Join room</button></section>
      <section className="panel p-6 md:col-span-2"><div className="flex items-center justify-between"><h2 className="font-bold">Recent completed matches</h2><span className="pill">SAVED HISTORY</span></div>{history.length === 0 ? <p className="muted text-sm mt-3">Your completed matches will appear here.</p> : <div className="mt-3 space-y-2">{history.slice(0, 5).map(m => <div key={m.id} className="flex justify-between border-t border-slate-700 pt-2 text-sm"><span>{m.winnerName} won · {m.playerCount} players</span><span className="muted">{new Date(m.completedAt).toLocaleString()}</span></div>)}</div>}</section>
    </div>}

    {screen === 'lobby' && room && <section className="panel p-6 md:p-8"><div className="flex flex-wrap justify-between gap-4"><div><p className="muted text-sm">PRIVATE ROOM CODE</p><div className="text-4xl tracking-[.25em] font-black text-violet-300">{room.code}</div></div><div className="pill h-fit">{room.players.length}/20 PLAYERS</div></div><div className="mt-6"><h2 className="font-bold text-xl">Players in lobby</h2><div className="grid sm:grid-cols-2 gap-3 mt-3">{room.players.map(p => <div key={p.id} className="rounded-xl bg-slate-900/70 border border-slate-700 p-3 flex justify-between"><span>{p.name}{p.id === playerId ? ' (You)' : ''}</span>{p.id === room.hostId && <span className="text-violet-300 text-xs">HOST</span>}</div>)}</div></div><div className="mt-7 flex flex-wrap gap-3 items-center">{isHost ? <button className="btn" disabled={room.players.length < 2 || busy} onClick={startGame}>Start Individual Match</button> : <span className="muted">Waiting for the host to start the match…</span>}<button className="btn !bg-slate-700" onClick={() => { clearSession(); setScreen('home'); }}>Leave lobby</button></div><p className="muted text-xs mt-4">3 rounds · 20-second questions · 500 base points · 25 bonus points per second remaining</p></section>}

    {screen === 'game' && game && <section className="panel p-6 md:p-8"><div className="flex flex-wrap justify-between gap-3"><span className="pill">ROUND {game.round} / 3 · QUESTION {game.questionNumber} / {game.totalQuestions}</span><span className="pill">{game.phase === 'question' ? 'ANSWER NOW' : 'ANSWER REVEAL'}</span></div><div className="flex items-center justify-between mt-5"><div><div className="muted text-xs">TIME REMAINING</div><div className={`text-5xl font-black tabular-nums ${remaining <= 5 ? 'text-red-300' : 'text-violet-300'}`}>{game.phase === 'question' ? remaining : 0}<span className="text-xl ml-1">s</span></div></div><div className="text-right"><div className="muted text-xs">YOUR SCORE</div><div className="text-3xl font-bold">{me?.score ?? 0}</div></div></div><div className="h-2 bg-slate-800 rounded-full mt-4 overflow-hidden"><div className="h-full bg-violet-400 transition-[width]" style={{ width: `${Math.max(0, remaining / 20 * 100)}%` }}/></div><h2 className="text-2xl md:text-3xl font-bold mt-8">{game.question?.text}</h2><div className="grid sm:grid-cols-2 gap-3 mt-6">{game.question?.options?.map((o, i) => <button key={i} disabled={game.phase !== 'question' || game.answered || selected !== null} onClick={() => setSelected(i)} className={`option ${selected === i ? 'selected' : ''}`}>{String.fromCharCode(65 + i)}. {o}</button>)}</div>{game.phase === 'question' ? <div className="mt-5 flex gap-3 items-center"><button className="btn" disabled={selected === null || game.answered || busy} onClick={submitAnswer}>Lock answer</button>{game.answered && <span className="text-emerald-300 text-sm">Answer locked. The answer and points are revealed when the question closes.</span>}</div> : <div className="mt-6 rounded-xl bg-slate-900 p-4"><p className="text-emerald-300 font-bold">Correct answer: {game.reveal?.correctAnswer}</p><p className="muted text-sm mt-1">{game.reveal?.explanation || ''}</p></div>}<div className="mt-7 border-t border-slate-700 pt-4"><h3 className="font-bold mb-2">Individual leaderboard</h3>{[...(game.players || [])].sort((a, b) => b.score - a.score).map((p, i) => <div className="flex justify-between py-1 text-sm" key={p.id}><span>{i + 1}. {p.name}{p.id === playerId ? ' (You)' : ''}</span><strong>{p.score}</strong></div>)}</div></section>}

    {screen === 'finished' && game && <section className="panel p-8 text-center"><div className="text-5xl">🏆</div><h2 className="text-3xl font-black mt-3">Battle complete!</h2><p className="muted mt-2">{game.winnerName} wins · Final individual leaderboard</p><div className="max-w-md mx-auto text-left mt-6">{[...(game.players || [])].sort((a, b) => b.score - a.score).map((p, i) => <div className="flex justify-between p-3 border-b border-slate-700" key={p.id}><span>{i + 1}. {p.name}</span><strong>{p.score}</strong></div>)}</div><button className="btn mt-6" onClick={() => { clearSession(); setScreen('home'); callGame('history').then(d => setHistory(d.matches || [])).catch(() => {}); }}>Return home</button></section>}
    <footer className="text-center text-xs muted mt-8">Server-authoritative scoring · Strongly consistent room state · Private rooms</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
