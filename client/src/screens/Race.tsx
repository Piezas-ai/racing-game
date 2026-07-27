/** The race itself: chase-camera render loop, HUD, combat, item overlays,
 * standings. Up to 10 racers share the track. Touch devices get a drag pad
 * and ability buttons. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { generateTrack, BIOMES } from '../../../shared/track';
import type { ItemKind, ServerMessage } from '../../../shared/protocol';
import { RACE_LAPS, STATE_HZ } from '../../../shared/protocol';
import { RaceEngine } from '../game/engine';
import { BotFleet } from '../game/bots';
import { ChaseRenderer, KART_COLORS } from '../game/render';
import { createInput, type GameAction } from '../game/input';
import { sfx, stopEngineSound, updateEngineSound } from '../game/audio';
import { formatMs } from '../api';
import type { GameSocket } from '../ws';

export type RaceConfig = Extract<ServerMessage, { type: 'race_config' }>;

const ITEM_EMOJI: Record<ItemKind, string> = {
  jumpscare: '👻', boost: '💨', oil: '🛢️', lightning: '⚡',
  steal: '🪄', sword: '⚔️', shield: '🛡️',
  dj: '🪩', scare2: '👻👻', rocket: '🚀',
};
const ITEM_LABEL: Record<ItemKind, string> = {
  jumpscare: 'Jump Scare (hits everyone!)', boost: 'Boost', oil: 'Oil Slick',
  lightning: 'Lightning (hits everyone!)', steal: 'Steal (robs a random racer)',
  sword: 'Sword (ram someone!)', shield: 'Shield bubble',
  dj: 'DJ (disco-slows a random racer)', scare2: 'Double Jump Scare (scares TWO racers)',
  rocket: 'Rocket (homes in on a random racer)',
};

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? 'th'}`;

type RaceOver = Extract<ServerMessage, { type: 'race_over' }>;

interface Props {
  socket: GameSocket;
  config: RaceConfig;
  onExit: () => void;
}

const IS_TOUCH = typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);

export function Race({ socket, config, onExit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [scare, setScare] = useState(false);
  const [zap, setZap] = useState(false);
  const [boomFlash, setBoomFlash] = useState(false);
  const [hypnoFlash, setHypnoFlash] = useState(false);
  const [heldItem, setHeldItem] = useState<ItemKind | null>(null);
  const [hud, setHud] = useState({
    lap: 1, timeMs: 0, rank: 1, finished: false,
    bullets: config.loadout.bullets, blocks: config.loadout.blocks,
    turrets: config.loadout.turrets, booms: config.loadout.booms, hypnos: config.loadout.hypnos,
    armorBullets: config.loadout.armorBullets, armorBlocks: config.loadout.armorBlocks,
  });
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [over, setOver] = useState<RaceOver | null>(null);
  const overRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<ReturnType<typeof createInput> | null>(null);

  const { engine, renderer, fleet } = useMemo(() => {
    const track = generateTrack(config.seed, config.level, config.biome);
    const me = config.players[config.yourSlot];
    const hasBots = config.players.some((p) => p.bot);
    return {
      engine: new RaceEngine(track, config.yourSlot, config.loadout, me?.car, me?.pet ?? null),
      renderer: new ChaseRenderer(track),
      // slot 0 (the host) simulates all AI racers
      fleet: config.yourSlot === 0 && hasBots ? new BotFleet(track, config.players, config.seed) : null,
    };
  }, [config]);

  const names = useMemo(() => config.players.map((p) => p.username), [config]);
  const playerCount = config.players.length;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const input = createInput();
    inputRef.current = input;
    let raf = 0;
    let last = performance.now();
    let sendAcc = 0;
    let hudAcc = 0;

    const showToast = (msg: string) => {
      setToastMsg(msg);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastMsg(null), 3500);
    };

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const unsub = socket.listen((msg) => {
      switch (msg.type) {
        case 'countdown':
          setCountdown(msg.value);
          if (msg.value > 0) sfx.countdownTick();
          else {
            sfx.go();
            engine.start();
            setTimeout(() => setCountdown(null), 900);
          }
          break;
        case 'peer_state':
          engine.setPeerState(msg.slot, msg.state);
          break;
        case 'peer_bot_states':
          for (const s of msg.states) engine.setPeerState(s.slot, s.state);
          break;
        case 'peer_item':
          engine.applyPeerItem(msg.slot, msg.item, msg.x, msg.y, msg.targetSlot, msg.targetSlots);
          fleet?.applyItem(msg.slot, msg.item, msg.targetSlot, msg.targetSlots);
          break;
        case 'peer_block':
          engine.onPeerBlock(msg.blockId);
          break;
        case 'peer_fire':
          engine.onPeerFire(msg.slot, msg.x, msg.y, msg.heading);
          sfx.shootDistant();
          break;
        case 'peer_place_block':
          engine.onPeerPlaceBlock(msg.slot, msg.x, msg.y);
          break;
        case 'peer_turret':
          engine.onPeerTurret(msg.slot, msg.x, msg.y);
          showToast(`🗼 ${names[msg.slot] ?? 'Someone'} placed a turret!`);
          sfx.placeBlock();
          break;
        case 'peer_boom':
          engine.onPeerBoom(msg.slot);
          fleet?.applyBoom();
          break;
        case 'peer_hypno':
          engine.onPeerHypno(msg.slot);
          fleet?.applyHypno(msg.slot);
          break;
        case 'ammo':
          engine.setAmmo(msg.bullets, msg.blocks, msg.turrets, msg.booms, msg.hypnos);
          break;
        case 'peer_finished':
          showToast(`🏁 ${names[msg.slot] ?? 'Someone'} finished in ${formatMs(msg.timeMs)}!`);
          break;
        case 'peer_left':
          engine.removePeer(msg.slot);
          showToast(`${names[msg.slot] ?? 'Someone'} left the race`);
          break;
        case 'error':
          showToast(msg.message);
          break;
        case 'race_over':
          overRef.current = true;
          setOver(msg);
          stopEngineSound();
          if (msg.winnerSlot === config.yourSlot) sfx.win();
          else sfx.lose();
          break;
      }
    });

    socket.send({ type: 'ready' });
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__engine = engine;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      engine.update(dt, input.state, {
        useItem: input.consume('useItem'),
        fire: input.consume('fire'),
        place: input.consume('place'),
        turret: input.consume('turret'),
        boom: input.consume('boom'),
        hypno: input.consume('hypno'),
      });

      for (const ev of engine.drainEvents()) {
        switch (ev.kind) {
          case 'pickup':
            sfx.pickup();
            setHeldItem(ev.item);
            break;
          case 'block':
            socket.send({ type: 'block', blockId: ev.blockId });
            break;
          case 'use':
            socket.send({ type: 'item', item: ev.item, x: ev.x, y: ev.y, targetSlot: ev.targetSlot, targetSlots: ev.targetSlots, stolen: ev.stolen });
            fleet?.applyItem(config.yourSlot, ev.item, ev.targetSlot, ev.targetSlots);
            setHeldItem(engine.item); // steal may hand us a new item immediately
            if (ev.item === 'boost') sfx.boost();
            else if (ev.item === 'oil') sfx.oilDrop();
            else if (ev.item === 'lightning') sfx.lightning();
            else if (ev.item === 'sword') sfx.sword();
            else if (ev.item === 'shield') sfx.barrier();
            else if (ev.item === 'steal') sfx.steal();
            else if (ev.item === 'dj') sfx.dj();
            else if (ev.item === 'rocket') sfx.rocket();
            else sfx.pickup();
            if (ev.item === 'steal' && ev.targetSlot !== undefined) {
              showToast(`🪄 Stole ${ev.stolen ? ITEM_EMOJI[ev.stolen] : 'an item'} from ${names[ev.targetSlot]}!`);
            } else if (ev.item === 'dj' && ev.targetSlot !== undefined) {
              showToast(`🪩 Dropped the beat on ${names[ev.targetSlot]}!`);
            } else if (ev.item === 'rocket' && ev.targetSlot !== undefined) {
              showToast(`🚀 Rocket launched at ${names[ev.targetSlot]}!`);
            } else if (ev.item === 'scare2' && ev.targetSlots?.length) {
              showToast(`👻👻 Scared ${ev.targetSlots.map((s) => names[s] ?? 'someone').join(' and ')}!`);
            }
            break;
          case 'noTarget':
            showToast('Nobody else out there to hit…');
            sfx.empty();
            break;
          case 'disco':
            showToast(`🪩 ${names[ev.bySlot] ?? 'Someone'} put a disco ball on your head!`);
            sfx.dj();
            break;
          case 'rocketIncoming':
            showToast(`🚀 INCOMING! ${names[ev.bySlot] ?? 'Someone'} fired a rocket at you!`);
            sfx.rocket();
            break;
          case 'fire':
            socket.send({ type: 'fire', x: ev.x, y: ev.y, heading: ev.heading });
            sfx.shoot();
            break;
          case 'placeBlock':
            socket.send({ type: 'place_block', x: ev.x, y: ev.y });
            sfx.placeBlock();
            break;
          case 'turret':
            socket.send({ type: 'turret', x: ev.x, y: ev.y });
            sfx.placeBlock();
            showToast('🗼 Turret deployed!');
            break;
          case 'boom':
            socket.send({ type: 'boom' });
            fleet?.applyBoom();
            sfx.boom();
            showToast('💥 BOOM! Everyone else goes back to the start!');
            break;
          case 'hypno':
            socket.send({ type: 'hypno' });
            fleet?.applyHypno(config.yourSlot);
            sfx.hypno();
            showToast('🌀 Everyone is under your spell!');
            break;
          case 'boomed':
            setBoomFlash(true);
            sfx.boom();
            setTimeout(() => setBoomFlash(false), 1200);
            showToast(`💥 ${names[ev.bySlot] ?? 'Someone'} BOOMED you back to the start!`);
            break;
          case 'hypnoed':
            setHypnoFlash(true);
            sfx.hypno();
            setTimeout(() => setHypnoFlash(false), 1800);
            showToast(`🌀 ${names[ev.bySlot] ?? 'Someone'} hypnotized you!`);
            break;
          case 'stolen':
            setHeldItem(null);
            sfx.steal();
            showToast(`🪄 ${names[ev.bySlot] ?? 'Someone'} stole your item!`);
            break;
          case 'stealFailed':
            showToast('🪄 Nobody had anything to steal…');
            break;
          case 'deflect':
            sfx.armor();
            break;
          case 'empty':
            sfx.empty();
            break;
          case 'hit':
            socket.send({ type: 'hit', source: ev.source, absorbed: ev.absorbed, shooterSlot: ev.shooterSlot });
            if (ev.absorbed) sfx.armor();
            else if (ev.source === 'block') sfx.shatter();
            else if (ev.source === 'sword') sfx.sword();
            else sfx.spin();
            break;
          case 'scared':
            setScare(true);
            sfx.scare();
            setTimeout(() => setScare(false), 1500);
            break;
          case 'zapped':
            setZap(true);
            sfx.lightning();
            setTimeout(() => setZap(false), 450);
            break;
          case 'spin': sfx.spin(); break;
          case 'spike': sfx.spike(); break;
          case 'trap': sfx.trap(); break;
          case 'lap': sfx.lap(); break;
          case 'finish':
            socket.send({ type: 'finish', timeMs: ev.timeMs, bestLapMs: ev.bestLapMs });
            break;
        }
      }

      if (fleet && !overRef.current) {
        fleet.update(dt, engine);
        // bots live in the peers map so ranking/minimap/rendering just work
        for (const { slot, state } of fleet.states()) engine.setPeerState(slot, state);
        for (const out of fleet.drainOutbox()) {
          if (out.kind === 'fire') {
            socket.send({ type: 'bot_fire', slot: out.slot, x: out.x, y: out.y, heading: out.heading });
            engine.onPeerFire(out.slot, out.x, out.y, out.heading); // the host can be hit too
            sfx.shootDistant();
          } else if (out.kind === 'finish') {
            socket.send({ type: 'bot_finish', slot: out.slot, timeMs: out.timeMs });
            showToast(`🤖 ${names[out.slot] ?? 'A robot'} finished in ${formatMs(out.timeMs)}!`);
          } else if (out.kind === 'hit') {
            socket.send({ type: 'hit', source: out.source, absorbed: false, shooterSlot: out.shooterSlot, victimSlot: out.victimSlot });
          }
        }
      }

      sendAcc += dt;
      if (sendAcc >= 1 / STATE_HZ && !overRef.current) {
        sendAcc = 0;
        socket.send({ type: 'state', state: engine.myState() });
        if (fleet) socket.send({ type: 'bot_states', states: fleet.states() });
      }

      hudAcc += dt;
      if (hudAcc > 0.12) {
        hudAcc = 0;
        setHud({
          lap: Math.min(engine.lap, RACE_LAPS),
          timeMs: Math.round(engine.raceTime * 1000),
          rank: engine.myRank(),
          finished: engine.finished,
          bullets: engine.bulletsLeft,
          blocks: engine.blocksLeft,
          turrets: engine.turretsLeft,
          booms: engine.boomsLeft,
          hypnos: engine.hypnosLeft,
          armorBullets: engine.armorBullets,
          armorBlocks: engine.armorBlocks,
        });
      }

      updateEngineSound(Math.min(1, engine.speed / 420), engine.finished || overRef.current);
      renderer.draw(ctx, engine, now / 1000, config.players);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      input.dispose();
      inputRef.current = null;
      unsub();
      stopEngineSound();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [engine, renderer, fleet, socket, config, names]);

  const theme = BIOMES[config.biome];
  const iWon = over && over.winnerSlot === config.yourSlot;
  const myStanding = over?.standings.find((s) => s.slot === config.yourSlot);

  return (
    <div className="race-screen" style={{ background: theme.sky }}>
      <canvas ref={canvasRef} />

      <div className="hud hud-top-left">
        <div className="hud-chip">Lap {hud.lap}/{RACE_LAPS}</div>
        <div className="hud-chip">{formatMs(hud.timeMs)}</div>
        <div className={`hud-chip ${hud.rank === 1 ? 'rank-first' : ''}`}>
          {ordinal(hud.rank)}/{playerCount}
        </div>
        <div className="hud-chip">L{config.level} {theme.emoji} {theme.label}</div>
      </div>

      <div className="hud hud-ammo">
        <div className="hud-chip">🔫 {hud.bullets} <span className="hud-key">F</span></div>
        <div className="hud-chip">📦 {hud.blocks} <span className="hud-key">B</span></div>
        {hud.turrets > 0 && <div className="hud-chip">🗼 {hud.turrets} <span className="hud-key">T</span></div>}
        {hud.booms > 0 && <div className="hud-chip">💥 {hud.booms} <span className="hud-key">X</span></div>}
        {hud.hypnos > 0 && <div className="hud-chip">🌀 {hud.hypnos} <span className="hud-key">H</span></div>}
        {(hud.armorBullets > 0 || hud.armorBlocks > 0) && (
          <div className="hud-chip">🛡️ {hud.armorBullets}·{hud.armorBlocks}</div>
        )}
      </div>

      <div className="hud hud-item">
        <div className="item-box">{heldItem ? ITEM_EMOJI[heldItem] : ''}</div>
        <div className="item-label">{heldItem ? `${ITEM_LABEL[heldItem]} — ${IS_TOUCH ? 'tap 🎁' : 'press Space'}` : 'Drive through a ? block'}</div>
      </div>

      {toastMsg && !over && <div className="hud hud-toast">{toastMsg}</div>}
      {hud.finished && !over && (
        <div className="hud hud-toast">You finished! Waiting for the others…</div>
      )}

      {countdown !== null && (
        <div className="overlay countdown">
          <span key={countdown}>{countdown === 0 ? 'GO!' : countdown}</span>
        </div>
      )}

      {zap && <div className="overlay zap-flash" />}
      {boomFlash && (
        <div className="overlay boom-overlay">
          <div className="boom-emoji">💥</div>
        </div>
      )}
      {hypnoFlash && (
        <div className="overlay hypno-overlay">
          <div className="hypno-emoji">🌀</div>
          <div className="hypno-text">HYPNOTIZED</div>
        </div>
      )}

      {scare && (
        <div className="overlay scare">
          <div className="scare-face">👻</div>
          <div className="scare-text">BOO!!!</div>
        </div>
      )}

      {over && (
        <div className="overlay modal-backdrop">
          <div className="card result-card">
            <h2>{over.winnerSlot === null ? 'Race over' : iWon ? '🏆 You win!' : `🏁 ${over.winnerName} wins`}</h2>
            {over.reason === 'forfeit' && <p className="muted">Everyone else left the race.</p>}
            {over.reason === 'timeout' && <p className="muted">Time ran out for the stragglers.</p>}
            {myStanding && <p className="points-earned">+{myStanding.points} points</p>}
            <table className="times-table">
              <tbody>
                {over.standings.map((s) => (
                  <tr key={s.slot} className={s.placement === 1 ? 'winner-row' : ''}>
                    <td>{s.placement ? ordinal(s.placement) : '—'}</td>
                    <td>
                      <span className="slot-dot" style={{ background: config.players[s.slot]?.color ?? KART_COLORS[s.slot % KART_COLORS.length] }} />
                      {config.players[s.slot]?.bot ? '🤖 ' : ''}{s.username}{s.slot === config.yourSlot ? ' (you)' : ''}
                    </td>
                    <td>{s.timeMs ? formatMs(s.timeMs) : s.placement ? 'DNF' : 'left'}</td>
                    <td className="muted">+{s.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-primary" onClick={onExit}>Back to lobby</button>
          </div>
        </div>
      )}

      {IS_TOUCH && !over && (
        <TouchControls
          heldItem={heldItem}
          counts={hud}
          onAxes={(t, s) => inputRef.current?.setTouchAxes(t, s)}
          onRelease={() => inputRef.current?.clearTouchAxes()}
          onAction={(a) => inputRef.current?.queue(a)}
        />
      )}

      <button className="btn btn-ghost leave-btn" onClick={onExit}>Leave</button>
    </div>
  );
}

/** iPad/phone controls: drag the left pad to steer + throttle, tap ability
 * buttons on the right. */
function TouchControls({
  heldItem, counts, onAxes, onRelease, onAction,
}: {
  heldItem: ItemKind | null;
  counts: { bullets: number; blocks: number; turrets: number; booms: number; hypnos: number };
  onAxes: (throttle: number, steer: number) => void;
  onRelease: () => void;
  onAction: (a: GameAction) => void;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const [nub, setNub] = useState<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    anchor.current = { x: e.clientX, y: e.clientY };
    setNub({ x: 0, y: 0 });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!anchor.current) return;
    const dx = e.clientX - anchor.current.x;
    const dy = e.clientY - anchor.current.y;
    const cl = (v: number) => Math.max(-70, Math.min(70, v));
    setNub({ x: cl(dx), y: cl(dy) });
    onAxes(-dy / 60, dx / 60); // drag up = gas, down = brake, sideways = steer
  };
  const onPointerUp = () => {
    anchor.current = null;
    setNub(null);
    onRelease();
  };

  const btn = (label: string, action: GameAction, count?: number, className = '') => (
    <button
      key={action}
      className={`touch-btn ${className}`}
      disabled={count !== undefined && count <= 0}
      onPointerDown={(e) => {
        e.preventDefault();
        onAction(action);
      }}
    >
      <span className="touch-btn-icon">{label}</span>
      {count !== undefined && <span className="touch-btn-count">{count}</span>}
    </button>
  );

  return (
    <>
      <div
        ref={padRef}
        className="touch-pad"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="touch-pad-ring">
          {nub && <div className="touch-pad-nub" style={{ transform: `translate(${nub.x}px, ${nub.y}px)` }} />}
          {!nub && <span className="touch-pad-hint">drag to drive</span>}
        </div>
      </div>
      <div className="touch-actions">
        {btn(heldItem ? ITEM_EMOJI[heldItem] : '🎁', 'useItem', undefined, heldItem ? 'has-item' : '')}
        {btn('🔫', 'fire', counts.bullets)}
        {btn('📦', 'place', counts.blocks)}
        {counts.turrets > 0 && btn('🗼', 'turret', counts.turrets)}
        {counts.booms > 0 && btn('💥', 'boom', counts.booms)}
        {counts.hypnos > 0 && btn('🌀', 'hypno', counts.hypnos)}
      </div>
    </>
  );
}
