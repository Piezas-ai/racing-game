/** Screen state machine: auth → lobby → staging room → race.
 * Owns the WebSocket and the /game/<code> share-URL handling. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type User } from './api';
import { GameSocket } from './ws';
import { Auth } from './screens/Auth';
import { Lobby } from './screens/Lobby';
import { Race, type RaceConfig } from './screens/Race';
import { unlockAudio } from './game/audio';
import { KART_COLORS } from './game/render';
import { MAX_PLAYERS, type PlayerInfo } from '../../shared/protocol';
import { BOT_SKILL_LABELS, BOT_SKILLS, MAX_BOTS, type BotSkill } from '../../shared/bots';
import type { Biome } from '../../shared/track';

type BotsConfig = { count: number; skill: BotSkill };

type Phase =
  | { name: 'loading' }
  | { name: 'auth' }
  | { name: 'lobby' }
  | { name: 'waiting'; code: string; players: PlayerInfo[]; yourSlot: number; bots: BotsConfig }
  | { name: 'race'; config: RaceConfig };

function codeFromPath(): string | null {
  const m = location.pathname.match(/^\/game\/(\d{4,6})$/);
  return m ? m[1] : null;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<GameSocket | null>(null);
  const pendingJoin = useRef<string | null>(codeFromPath());
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const ensureSocket = useCallback((): GameSocket => {
    if (socketRef.current?.open) return socketRef.current;
    const sock = new GameSocket();
    socketRef.current = sock;
    sock.onDisconnect = () => {
      socketRef.current = null;
      if (phaseRef.current.name === 'waiting' || phaseRef.current.name === 'race') {
        showToast('Connection lost');
        history.pushState({}, '', '/');
        setPhase({ name: 'lobby' });
      }
    };
    sock.listen((msg) => {
      if (msg.type === 'created') {
        setBusy(false);
        history.pushState({}, '', `/game/${msg.code}`);
      } else if (msg.type === 'lobby_update') {
        setBusy(false);
        if (phaseRef.current.name !== 'race') {
          setPhase({
            name: 'waiting', code: msg.code, players: msg.players, yourSlot: msg.yourSlot,
            bots: msg.bots ?? { count: 0, skill: 'medium' },
          });
        }
      } else if (msg.type === 'race_config') {
        setBusy(false);
        setPhase({ name: 'race', config: msg });
      } else if (msg.type === 'error') {
        setBusy(false);
        showToast(msg.message);
        if (phaseRef.current.name !== 'race') {
          history.pushState({}, '', '/');
          setPhase((p) => (p.name === 'race' ? p : { name: 'lobby' }));
        }
      }
    });
    return sock;
  }, [showToast]);

  const joinGame = useCallback(
    (code: string) => {
      unlockAudio();
      setBusy(true);
      ensureSocket().send({
        type: 'join', code,
        color: userRef.current?.color, car: userRef.current?.car, pet: userRef.current?.activePet,
      });
    },
    [ensureSocket],
  );

  const createGame = useCallback(
    (level: number, biome: Biome | 'random') => {
      unlockAudio();
      setBusy(true);
      ensureSocket().send({
        type: 'create', level, biome,
        color: userRef.current?.color, car: userRef.current?.car, pet: userRef.current?.activePet,
      });
    },
    [ensureSocket],
  );

  const startRace = useCallback(() => {
    unlockAudio();
    socketRef.current?.send({ type: 'start' });
  }, []);

  const setBots = useCallback((count: number, skill: BotSkill) => {
    socketRef.current?.send({ type: 'set_bots', count, skill });
  }, []);

  useEffect(() => {
    api
      .me()
      .then((u) => {
        setUser(u);
        const code = pendingJoin.current;
        pendingJoin.current = null;
        if (code) joinGame(code);
        else setPhase({ name: 'lobby' });
      })
      .catch(() => setPhase({ name: 'auth' }));
  }, [joinGame]);

  const onAuthed = (u: User) => {
    setUser(u);
    const code = pendingJoin.current;
    pendingJoin.current = null;
    if (code) joinGame(code);
    else setPhase({ name: 'lobby' });
  };

  const backToLobby = useCallback(() => {
    socketRef.current?.send({ type: 'leave' });
    history.pushState({}, '', '/');
    setPhase({ name: 'lobby' });
    api.me().then(setUser).catch(() => undefined);
  }, []);

  const logout = async () => {
    socketRef.current?.close();
    socketRef.current = null;
    await api.logout().catch(() => undefined);
    setUser(null);
    setPhase({ name: 'auth' });
  };

  return (
    <>
      {phase.name === 'loading' && (
        <div className="center-screen"><p className="muted">Loading…</p></div>
      )}
      {phase.name === 'auth' && <Auth onAuthed={onAuthed} joinCode={pendingJoin.current} />}
      {phase.name === 'lobby' && user && (
        <Lobby
          user={user}
          onCreate={createGame}
          onJoin={joinGame}
          onLogout={logout}
          onUserUpdate={setUser}
          busy={busy}
        />
      )}
      {phase.name === 'waiting' && (
        <WaitingRoom
          code={phase.code}
          players={phase.players}
          yourSlot={phase.yourSlot}
          bots={phase.bots}
          onSetBots={setBots}
          onStart={startRace}
          onCancel={backToLobby}
        />
      )}
      {phase.name === 'race' && (
        <Race socket={socketRef.current!} config={phase.config} onExit={backToLobby} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

function WaitingRoom({
  code, players, yourSlot, bots, onSetBots, onStart, onCancel,
}: {
  code: string;
  players: PlayerInfo[];
  yourSlot: number;
  bots: BotsConfig;
  onSetBots: (count: number, skill: BotSkill) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/game/${code}`;
  const isHost = yourSlot === 0;
  const totalRacers = players.length + bots.count;
  return (
    <div className="center-screen">
      <div className="card waiting-card">
        <h2>{isHost ? 'Race created!' : 'You’re in!'}</h2>
        <p className="muted">Share the code — up to {MAX_PLAYERS} racers can join.</p>
        <div className="big-code">{code.split('').join(' ')}</div>
        <div className="share-row">
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button
            className="btn btn-primary"
            onClick={() => {
              navigator.clipboard?.writeText(url).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>

        <div className="roster">
          {players.map((p, slot) => (
            <div key={slot} className="roster-row">
              <span className="slot-dot" style={{ background: p.color || KART_COLORS[slot % KART_COLORS.length] }} />
              <span>{p.username}{slot === yourSlot ? ' (you)' : ''}</span>
              {slot === 0 && <span className="host-badge">host</span>}
            </div>
          ))}
          {bots.count > 0 && (
            <div className="roster-row">
              <span className="slot-dot bot-dot">🤖</span>
              <span>{bots.count} robot racer{bots.count > 1 ? 's' : ''} · {BOT_SKILL_LABELS[bots.skill]}</span>
            </div>
          )}
          <p className="pulse muted">
            {players.length}/{MAX_PLAYERS} racers · {isHost ? 'start whenever you like' : 'waiting for the host to start…'}
          </p>
        </div>

        {isHost && (
          <div className="bot-controls">
            <div className="bot-stepper">
              <span className="bot-label">🤖 Robots</span>
              <button
                className="btn btn-ghost stepper-btn"
                disabled={bots.count <= 0}
                onClick={() => onSetBots(bots.count - 1, bots.skill)}
              >−</button>
              <span className="bot-count">{bots.count}</span>
              <button
                className="btn btn-ghost stepper-btn"
                disabled={bots.count >= MAX_BOTS}
                onClick={() => onSetBots(bots.count + 1, bots.skill)}
              >+</button>
            </div>
            <div className="skill-row">
              {BOT_SKILLS.map((s) => (
                <button
                  key={s}
                  className={`skill-btn ${bots.skill === s ? 'selected' : ''}`}
                  onClick={() => onSetBots(bots.count, s)}
                >
                  {BOT_SKILL_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        )}

        {isHost && (
          <button className="btn btn-primary" onClick={onStart}>
            {totalRacers > 1 ? `Start race (${totalRacers} racers)` : 'Start solo practice'}
          </button>
        )}
        <button className="btn btn-ghost" onClick={onCancel}>Leave</button>
      </div>
    </div>
  );
}
