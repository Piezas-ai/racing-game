/** Host-side AI racers. The HOST's client simulates every bot kart and is the
 * bots' victim-authority: bots here collide with the host's view of puddles,
 * road blocks, bullets, hazards and turrets, and the host reports their hits
 * to the server (hit + victimSlot). States are broadcast as one batched
 * `bot_states` message per tick; everyone else just renders them as peers. */
import { mulberry32 } from '../../../shared/rng';
import { progressAt, trapClosed, type Track } from '../../../shared/track';
import { RACE_LAPS, type HitSource, type ItemKind, type KartState, type PlayerInfo } from '../../../shared/protocol';
import { botParams, type BotParams } from '../../../shared/bots';
import { KART_RADIUS, MAX_SPEED, ROCKET_FLIGHT_S, TURRET_RANGE, type RaceEngine, type Turret } from './engine';

const BOT_ACCEL = 330;
const BOT_STEER = 2.6; // rad/s
const WALL_MARGIN = 26;
const TURRET_BOT_INTERVAL = 2.2; // turrets sting bots a bit less often than humans

export type BotOutMsg =
  | { kind: 'fire'; slot: number; x: number; y: number; heading: number }
  | { kind: 'finish'; slot: number; timeMs: number }
  | { kind: 'hit'; victimSlot: number; source: HitSource; shooterSlot: number };

interface BotSim {
  slot: number;
  p: BotParams;
  x: number;
  y: number;
  heading: number;
  speed: number;
  lap: number;
  progress: number;
  prevProgress: number;
  halfway: boolean; // must pass mid-track before a start-line cross counts
  centerHint: number;
  lane: number; // preferred lateral offset (fraction of halfWidth)
  wobblePhase: number;
  finished: boolean;
  spinT: number;
  scareT: number;
  slowT: number;
  djT: number;
  hypnoT: number;
  hypnoSource: number;
  spikeCd: number;
  trapCd: number;
  fireCd: number;
  turretCd: Map<Turret, number>;
  incomingRockets: { t: number; fromSlot: number }[];
}

export class BotFleet {
  private track: Track;
  private bots: BotSim[] = [];
  private humanCount: number;
  private outbox: BotOutMsg[] = [];
  private rand: () => number;

  constructor(track: Track, players: PlayerInfo[], seed: number) {
    this.track = track;
    this.humanCount = players.filter((p) => !p.bot).length;
    this.rand = mulberry32(seed ^ 0x0b07);
    for (const [slot, info] of players.entries()) {
      if (!info.bot) continue;
      const n = track.center.length;
      const row = Math.floor(slot / 5);
      const idx = row === 0 ? 7 : 3;
      const lane = ((slot % 5) - 2) * 0.32;
      const a = track.center[idx];
      const b = track.center[(idx + 2) % n];
      this.bots.push({
        slot,
        p: botParams(info.botSkill ?? 'medium', this.rand),
        x: a.x + track.normal[idx].x * track.halfWidth * lane,
        y: a.y + track.normal[idx].y * track.halfWidth * lane,
        heading: Math.atan2(b.y - a.y, b.x - a.x),
        speed: 0,
        lap: 1,
        progress: progressAt(track, idx),
        prevProgress: progressAt(track, idx),
        halfway: false,
        centerHint: idx,
        lane: (this.rand() - 0.5) * 0.7,
        wobblePhase: this.rand() * Math.PI * 2,
        finished: false,
        spinT: 0, scareT: 0, slowT: 0, djT: 0, hypnoT: 0, hypnoSource: -1,
        spikeCd: 0, trapCd: 0,
        fireCd: 1 + this.rand() * 3,
        turretCd: new Map(),
        incomingRockets: [],
      });
    }
  }

  get count(): number {
    return this.bots.length;
  }

  drainOutbox(): BotOutMsg[] {
    return this.outbox.splice(0);
  }

  states(): { slot: number; state: KartState }[] {
    return this.bots.map((b) => ({
      slot: b.slot,
      state: {
        x: b.x, y: b.y, heading: b.heading, speed: b.speed,
        lap: Math.min(b.lap, RACE_LAPS), progress: b.progress,
        item: null,
        effect:
          b.spinT > 0 ? 'spin'
          : b.scareT > 0 ? 'scare'
          : b.hypnoT > 0 ? 'hypno'
          : b.slowT > 0 ? 'shrink'
          : b.djT > 0 ? 'dj'
          : null,
      },
    }));
  }

  /** Items used by anyone (host or peers) that can affect bots. */
  applyItem(fromSlot: number, item: ItemKind, targetSlot?: number, targetSlots?: number[]): void {
    for (const b of this.bots) {
      switch (item) {
        case 'jumpscare':
          b.scareT = 1.6;
          break;
        case 'lightning':
          b.slowT = 3.0;
          break;
        case 'scare2':
          if (targetSlots?.includes(b.slot)) b.scareT = 1.6;
          break;
        case 'dj':
          if (targetSlot === b.slot) b.djT = 5.0;
          break;
        case 'rocket':
          if (targetSlot === b.slot) b.incomingRockets.push({ t: ROCKET_FLIGHT_S, fromSlot });
          break;
        default:
          break; // oil arrives via engine.puddles; steal never targets bots
      }
    }
  }

  applyBoom(): void {
    const { track } = this;
    for (const b of this.bots) {
      if (b.finished) continue;
      const n = track.center.length;
      const row = Math.floor(b.slot / 5);
      const idx = row === 0 ? 7 : 3;
      const lane = ((b.slot % 5) - 2) * 0.32;
      b.x = track.center[idx].x + track.normal[idx].x * track.halfWidth * lane;
      b.y = track.center[idx].y + track.normal[idx].y * track.halfWidth * lane;
      const nx = track.center[(idx + 2) % n];
      b.heading = Math.atan2(nx.y - track.center[idx].y, nx.x - track.center[idx].x);
      b.speed = 0;
      b.spinT = 1.2;
      b.centerHint = idx;
      b.prevProgress = progressAt(track, idx);
      b.progress = b.prevProgress;
      b.halfway = false;
    }
  }

  applyHypno(masterSlot: number): void {
    for (const b of this.bots) {
      if (b.finished) continue;
      b.hypnoT = 6.0;
      b.hypnoSource = masterSlot;
    }
  }

  update(dt: number, engine: RaceEngine): void {
    if (!engine.running) return;
    const raceTime = engine.raceTime;
    for (const b of this.bots) {
      this.updateBot(b, dt, engine, raceTime);
    }
  }

  private updateBot(b: BotSim, dt: number, engine: RaceEngine, raceTime: number): void {
    const { track } = this;
    for (const key of ['spinT', 'scareT', 'slowT', 'djT', 'hypnoT', 'spikeCd', 'trapCd', 'fireCd'] as const) {
      b[key] = Math.max(0, b[key] - dt);
    }

    // incoming rockets land on schedule
    for (let i = b.incomingRockets.length - 1; i >= 0; i--) {
      const r = b.incomingRockets[i];
      r.t -= dt;
      if (r.t <= 0) {
        b.incomingRockets.splice(i, 1);
        this.spinOut(b, 0.95, 0.35);
        this.outbox.push({ kind: 'hit', victimSlot: b.slot, source: 'rocket', shooterSlot: r.fromSlot });
      }
    }

    if (b.finished) {
      b.speed = Math.max(0, b.speed - 260 * dt);
      this.move(b, dt);
      return;
    }

    // --- steering: chase a lookahead point on the centerline (with a lane
    // offset and some personality wobble), unless spinning or hypnotized
    const n = track.center.length;
    const spacing = track.totalLength / n;
    b.wobblePhase += dt * 0.9;
    const laneOff = (b.lane + Math.sin(b.wobblePhase) * 0.25) * track.halfWidth * 0.55;
    const aheadIdx = (b.centerHint + Math.max(8, Math.round((70 + b.speed * 0.42) / spacing))) % n;
    const tx = track.center[aheadIdx].x + track.normal[aheadIdx].x * laneOff;
    const ty = track.center[aheadIdx].y + track.normal[aheadIdx].y * laneOff;

    let desired = Math.atan2(ty - b.y, tx - b.x);
    let targetSpeed = MAX_SPEED * b.p.cruise * (b.slowT > 0 ? 0.5 : 1) * (b.djT > 0 ? 0.75 : 1);

    if (b.hypnoT > 0) {
      const master = this.masterView(b.hypnoSource, engine);
      if (master) {
        desired = master.heading;
        targetSpeed = master.speed;
      }
    } else {
      // slow into corners: how much does the road bend past the lookahead?
      const farIdx = (aheadIdx + Math.max(6, Math.round(150 / spacing))) % n;
      const roadAhead = Math.atan2(
        track.center[farIdx].y - track.center[aheadIdx].y,
        track.center[farIdx].x - track.center[aheadIdx].x,
      );
      const bend = Math.abs(angDiff(roadAhead, desired));
      targetSpeed *= Math.max(0.35, 1 - bend * b.p.corner);
    }

    if (b.spinT > 0) {
      b.speed *= Math.max(0, 1 - 1.6 * dt);
    } else {
      let turn = angDiff(desired, b.heading);
      if (b.scareT > 0) turn = -turn + (Math.random() * 2 - 1) * 1.2;
      else if (b.p.wobble > 0) turn += Math.sin(b.wobblePhase * 3.7) * b.p.wobble * 0.4;
      const maxTurn = BOT_STEER * dt;
      b.heading += Math.max(-maxTurn, Math.min(maxTurn, turn));
      const accel = b.speed < targetSpeed ? BOT_ACCEL : -BOT_ACCEL * 1.4;
      b.speed = Math.max(0, b.speed + accel * dt);
      if (accel > 0) b.speed = Math.min(b.speed, targetSpeed);
    }

    this.move(b, dt);
    this.collide(b, engine, raceTime);
    this.maybeFire(b, dt, engine);
    this.trackProgress(b, raceTime);
  }

  private move(b: BotSim, dt: number): void {
    const { track } = this;
    b.x += Math.cos(b.heading) * b.speed * dt;
    b.y += Math.sin(b.heading) * b.speed * dt;

    // cheap local centerline tracking (same trick as the engine)
    const nPts = track.center.length;
    const d2 = (i: number) => {
      const p = track.center[i];
      return (p.x - b.x) ** 2 + (p.y - b.y) ** 2;
    };
    let best = b.centerHint;
    let bestD = d2(best);
    let improved = true;
    while (improved) {
      improved = false;
      for (const step of [1, -1, 3, -3, 9, -9]) {
        const i = (best + step + nPts) % nPts;
        const d = d2(i);
        if (d < bestD) { bestD = d; best = i; improved = true; }
      }
    }
    b.centerHint = best;

    const cp = track.center[best];
    const dx = b.x - cp.x;
    const dy = b.y - cp.y;
    const d = Math.hypot(dx, dy);
    if (d > track.halfWidth) b.speed *= Math.pow(track.theme.offRoadKeep, dt * 60);
    const wall = track.halfWidth + WALL_MARGIN;
    if (d > wall && d > 0) {
      b.x = cp.x + (dx / d) * wall;
      b.y = cp.y + (dy / d) * wall;
      b.speed *= 0.6;
    }
  }

  private collide(b: BotSim, engine: RaceEngine, raceTime: number): void {
    if (b.finished) return;

    // oil puddles (host's shared view — includes the host's own drops)
    for (let i = engine.puddles.length - 1; i >= 0; i--) {
      const p = engine.puddles[i];
      if (Math.hypot(b.x - p.x, b.y - p.y) < 20 + KART_RADIUS) {
        engine.puddles.splice(i, 1);
        this.spinOut(b, 0.9, 0.4);
        break;
      }
    }

    // road blocks — crashing one credits whoever placed it
    for (let i = engine.roadBlocks.length - 1; i >= 0; i--) {
      const rb = engine.roadBlocks[i];
      if (Math.hypot(b.x - rb.x, b.y - rb.y) < 20 + KART_RADIUS) {
        engine.roadBlocks.splice(i, 1);
        this.spinOut(b, 1.0, 0.15);
        if (rb.placerSlot !== b.slot) {
          this.outbox.push({ kind: 'hit', victimSlot: b.slot, source: 'block', shooterSlot: rb.placerSlot });
        }
        break;
      }
    }

    // bullets fired by humans (bot bullets never hit bots)
    for (let i = engine.bullets.length - 1; i >= 0; i--) {
      const bl = engine.bullets[i];
      if (bl.shooterSlot === b.slot || bl.shooterSlot >= this.humanCount) continue;
      if (Math.hypot(b.x - bl.x, b.y - bl.y) < 14 + KART_RADIUS) {
        const { shooterSlot, source } = bl;
        engine.bullets.splice(i, 1);
        this.spinOut(b, 0.8, 0.35);
        this.outbox.push({ kind: 'hit', victimSlot: b.slot, source, shooterSlot });
        break;
      }
    }

    // track hazards
    for (const h of this.track.hazards) {
      if (Math.hypot(b.x - h.x, b.y - h.y) > h.radius + KART_RADIUS) continue;
      if (h.kind === 'spikes' && b.spikeCd === 0) {
        b.speed *= 0.3;
        b.spikeCd = 1.2;
      } else if (h.kind === 'trap' && b.trapCd === 0 && trapClosed(h, raceTime)) {
        this.spinOut(b, 1.0, 0.25);
        b.trapCd = 1.8;
      }
    }

    // turrets sting bots too (no bullet visual — just the zap + muzzle flash)
    for (const t of engine.turrets) {
      if (t.ownerSlot === b.slot) continue;
      const d = Math.hypot(b.x - t.x, b.y - t.y);
      if (d > TURRET_RANGE * 0.85) continue;
      const last = b.turretCd.get(t) ?? -99;
      if (raceTime - last < TURRET_BOT_INTERVAL) continue;
      b.turretCd.set(t, raceTime);
      t.lastShot = raceTime;
      this.spinOut(b, 0.8, 0.4);
      this.outbox.push({ kind: 'hit', victimSlot: b.slot, source: 'turret', shooterSlot: t.ownerSlot });
    }
  }

  private spinOut(b: BotSim, spin: number, keep: number): void {
    b.spinT = Math.max(b.spinT, spin);
    b.speed *= keep;
  }

  /** Aggressive bots take pot shots at humans who are roughly ahead of them. */
  private maybeFire(b: BotSim, dt: number, engine: RaceEngine): void {
    if (b.fireCd > 0 || b.spinT > 0 || b.scareT > 0 || b.p.aggression <= 0) return;
    if (Math.random() > b.p.aggression * dt) return;
    let target: { x: number; y: number } | null = null;
    let bestD = 460;
    for (let slot = 0; slot < this.humanCount; slot++) {
      const pos = slot === engine.slot ? engine : engine.peers.get(slot);
      if (!pos) continue;
      const d = Math.hypot(pos.x - b.x, pos.y - b.y);
      if (d > bestD) continue;
      const angle = Math.abs(angDiff(Math.atan2(pos.y - b.y, pos.x - b.x), b.heading));
      if (angle < 0.6) {
        bestD = d;
        target = { x: pos.x, y: pos.y };
      }
    }
    if (!target) return;
    b.fireCd = 1.4;
    const heading = Math.atan2(target.y - b.y, target.x - b.x);
    const x = b.x + Math.cos(heading) * (KART_RADIUS + 8);
    const y = b.y + Math.sin(heading) * (KART_RADIUS + 8);
    this.outbox.push({ kind: 'fire', slot: b.slot, x, y, heading });
  }

  private trackProgress(b: BotSim, raceTime: number): void {
    const p = progressAt(this.track, b.centerHint);
    b.progress = p;
    if (p > 0.4 && p < 0.6) b.halfway = true;
    const crossed = b.prevProgress > 0.8 && p < 0.2;
    b.prevProgress = p;
    if (!crossed || !b.halfway) return;
    b.halfway = false;
    if (b.lap >= RACE_LAPS) {
      b.finished = true;
      this.outbox.push({ kind: 'finish', slot: b.slot, timeMs: Math.round(raceTime * 1000) });
    } else {
      b.lap += 1;
    }
  }

  private masterView(slot: number, engine: RaceEngine): { heading: number; speed: number } | null {
    if (slot === engine.slot) return { heading: engine.heading, speed: engine.speed };
    const p = engine.peers.get(slot);
    return p ? { heading: p.heading, speed: p.speed } : null;
  }
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
