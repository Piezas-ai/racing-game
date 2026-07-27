/** Client-side race simulation. Each player simulates their own kart and
 * broadcasts state; every other racer ("peer") is rendered from relayed
 * snapshots. Hits on ME are decided by MY simulation (victim-authoritative)
 * and reported to the server for scoring. */
import {
  BLOCK_RESPAWN_S,
  nearestCenterIndex,
  progressAt,
  trapClosed,
  type Track,
} from '../../../shared/track';
import { RACE_LAPS, type HitSource, type ItemKind, type KartState } from '../../../shared/protocol';
import { STARTER, type Wallet } from '../../../shared/economy';
import { CARS, DEFAULT_CAR, type CarKind, type CarSpec } from '../../../shared/cars';
import type { PetKind } from '../../../shared/pets';
import type { InputState } from './input';

export const KART_RADIUS = 12;
const ACCEL = 400;
export const MAX_SPEED = 410; // exported for the host's bot simulation
const REVERSE_MAX = 140;
const BRAKE = 650;
const FORWARD_DRAG = 0.65; // per second
const STEER_RATE = 2.8; // rad/s at full speed
const WALL_MARGIN = 26; // grass shoulder beyond road edge before the wall

/** Lucky-block item pool, weighted. */
const ITEM_POOL: ItemKind[] = [
  'jumpscare', 'jumpscare', 'jumpscare',
  'boost', 'boost', 'boost', 'boost',
  'oil', 'oil', 'oil',
  'lightning', 'lightning',
  'steal', 'steal', 'steal',
  'sword', 'sword', 'sword',
  'shield', 'shield',
  'dj', 'dj',
  'scare2', 'scare2',
  'rocket', 'rocket', 'rocket',
];

const BULLET_SPEED = 760;
const BULLET_TTL = 1.3;
const FIRE_COOLDOWN = 0.35;
const ROAD_BLOCK_RADIUS = 20;
const SWORD_DURATION = 3.0;
const BARRIER_DURATION = 4.0;
const HYPNO_DURATION = 6.0;
const DJ_DURATION = 5.0;
const DJ_SLOW = 0.75; // disco ball victims run at 75% speed
export const ROCKET_FLIGHT_S = 2.2; // homing rocket travel time (shield it!)
export const TURRET_LIFETIME = 30;
export const TURRET_RANGE = 340;
const TURRET_INTERVAL = 1.4;

export type EngineEvent =
  | { kind: 'pickup'; item: ItemKind }
  | { kind: 'use'; item: ItemKind; x?: number; y?: number; targetSlot?: number; targetSlots?: number[]; stolen?: ItemKind }
  | { kind: 'block'; blockId: number }
  | { kind: 'scared' }
  | { kind: 'zapped' }
  | { kind: 'disco'; bySlot: number } // I've got a disco ball on my head
  | { kind: 'rocketIncoming'; bySlot: number } // a rocket locked onto ME
  | { kind: 'noTarget' } // used a targeted item with nobody else around
  | { kind: 'spin' }
  | { kind: 'spike' }
  | { kind: 'trap' }
  | { kind: 'fire'; x: number; y: number; heading: number }
  | { kind: 'placeBlock'; x: number; y: number }
  | { kind: 'turret'; x: number; y: number }
  | { kind: 'boom' }
  | { kind: 'hypno' }
  | { kind: 'boomed'; bySlot: number } // I got blasted back to the start
  | { kind: 'hypnoed'; bySlot: number } // I'm under mind control
  | { kind: 'stolen'; bySlot: number } // my held item was stolen
  | { kind: 'stealFailed' } // nobody had anything to steal
  | { kind: 'deflect' } // my shield bubble blocked something
  | { kind: 'empty' } // tried to use something I don't have
  | { kind: 'hit'; source: HitSource; absorbed: boolean; shooterSlot: number } // something hit ME
  | { kind: 'lap'; lap: number }
  | { kind: 'finish'; timeMs: number; bestLapMs: number };

interface Puddle {
  x: number;
  y: number;
  mine: boolean;
}

export interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
  shooterSlot: number;
  source: 'bullet' | 'turret';
}

export interface RoadBlock {
  x: number;
  y: number;
  placerSlot: number;
  immuneUntil: number;
}

export interface Turret {
  x: number;
  y: number;
  ownerSlot: number;
  expiresAt: number;
  lastShot: number;
  aimAngle: number;
}

/** A homing rocket chasing one kart. Every client simulates the visual; only
 * the target's own client applies the hit when it lands. */
export interface RocketMissile {
  targetSlot: number;
  fromSlot: number;
  t: number; // seconds until impact
  x: number;
  y: number;
}

export interface PeerView {
  slot: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  lap: number;
  progress: number;
  item: ItemKind | null;
  effect: string | null;
  targetX: number;
  targetY: number;
  targetHeading: number;
}

export class RaceEngine {
  readonly track: Track;
  readonly slot: number;
  readonly car: CarSpec;

  x: number;
  y: number;
  heading: number;
  vx = 0;
  vy = 0;
  lap = 1;
  progress = 0;
  item: ItemKind | null = null;
  finished = false;
  running = false;

  // Effect timers (seconds remaining)
  boostT = 0;
  spinT = 0;
  scareT = 0;
  slowT = 0;
  shakeT = 0;
  shieldT = 0; // armor-absorbed flash
  swordT = 0; // sword drawn — ram to strike
  barrierT = 0; // shield-item bubble
  hypnoT = 0; // I'm hypnotized
  hypnoSource = -1;
  djT = 0; // disco ball on my head — slowed and sparkling
  private spikeCd = 0;
  private trapCd = 0;
  private oilImmuneT = 0;
  private fireCd = 0;
  private meleeCd = 0;
  spinAngle = 0;

  // Consumables (server-corrected via 'ammo' messages)
  bulletsLeft = 0;
  blocksLeft = 0;
  turretsLeft = 0;
  boomsLeft = 0;
  hypnosLeft = 0;
  armorBullets = 0;
  armorBlocks = 0;
  bullets: Bullet[] = [];
  roadBlocks: RoadBlock[] = [];
  turrets: Turret[] = [];
  rockets: RocketMissile[] = [];

  raceTime = 0;
  private lapStartMs = 0;
  bestLapMs = 0;
  finishTimeMs = 0;

  puddles: Puddle[] = [];
  blockRespawn = new Map<number, number>();
  peers = new Map<number, PeerView>();

  private centerHint: number;
  private prevProgress = 0;
  private checkpoints = [false, false, false];
  private events: EngineEvent[] = [];
  private spawnX: number;
  private spawnY: number;
  private spawnHeading: number;

  /** Lucky-block grab reach (Magnet Cat extends it). */
  private pickupReach = 17 + KART_RADIUS;

  constructor(track: Track, slot: number, loadout: Wallet = STARTER, car: CarKind = DEFAULT_CAR, pet: PetKind | null = null) {
    this.track = track;
    this.slot = slot;
    // pet abilities stack multiplicatively on top of the car's
    const spec = { ...(CARS[car] ?? CARS[DEFAULT_CAR]) };
    if (pet === 'zoomie') {
      spec.maxSpeedMult *= 1.05;
      spec.accelMult *= 1.05;
    } else if (pet === 'tank') {
      spec.hitRecoveryMult *= 0.65;
    } else if (pet === 'magnet') {
      this.pickupReach += 26;
    }
    this.car = spec;
    this.bulletsLeft = loadout.bullets;
    this.blocksLeft = loadout.blocks;
    this.turretsLeft = loadout.turrets;
    this.boomsLeft = loadout.booms;
    this.hypnosLeft = loadout.hypnos;
    this.armorBullets = loadout.armorBullets;
    this.armorBlocks = loadout.armorBlocks;

    // Starting grid: rows of 5, staggered just past the start line.
    const n = track.center.length;
    const row = Math.floor(slot / 5);
    const idx = row === 0 ? 7 : 3;
    const lane = ((slot % 5) - 2) * 0.32;
    const a = track.center[idx];
    const b = track.center[(idx + 2) % n];
    this.x = a.x + track.normal[idx].x * track.halfWidth * lane;
    this.y = a.y + track.normal[idx].y * track.halfWidth * lane;
    this.heading = Math.atan2(b.y - a.y, b.x - a.x);
    this.spawnX = this.x;
    this.spawnY = this.y;
    this.spawnHeading = this.heading;
    this.centerHint = idx;
    this.prevProgress = progressAt(track, idx);
    this.progress = this.prevProgress;
  }

  start(): void {
    this.running = true;
    this.raceTime = 0;
    this.lapStartMs = 0;
    if (this.car.startsWithItem && !this.item) {
      this.item = ITEM_POOL[Math.floor(Math.random() * ITEM_POOL.length)];
      this.events.push({ kind: 'pickup', item: this.item });
    }
  }

  drainEvents(): EngineEvent[] {
    return this.events.splice(0);
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  displayEffect(): string | null {
    if (this.spinT > 0) return 'spin';
    if (this.scareT > 0) return 'scare';
    if (this.hypnoT > 0) return 'hypno';
    if (this.slowT > 0) return 'shrink';
    if (this.djT > 0) return 'dj';
    if (this.swordT > 0) return 'sword';
    if (this.barrierT > 0) return 'barrier';
    if (this.shieldT > 0) return 'shield';
    if (this.boostT > 0) return 'boost';
    return null;
  }

  setAmmo(bullets: number, blocks: number, turrets: number, booms: number, hypnos: number): void {
    this.bulletsLeft = bullets;
    this.blocksLeft = blocks;
    this.turretsLeft = turrets;
    this.boomsLeft = booms;
    this.hypnosLeft = hypnos;
  }

  myState(): KartState {
    return {
      x: this.x,
      y: this.y,
      heading: this.heading,
      speed: this.speed,
      lap: this.lap,
      progress: this.progress,
      item: this.item,
      effect: this.displayEffect(),
    };
  }

  setPeerState(slot: number, s: KartState): void {
    let peer = this.peers.get(slot);
    if (!peer) {
      peer = {
        slot,
        x: s.x, y: s.y, heading: s.heading,
        speed: 0, lap: 1, progress: 0, item: null, effect: null,
        targetX: s.x, targetY: s.y, targetHeading: s.heading,
      };
      this.peers.set(slot, peer);
    }
    peer.targetX = s.x;
    peer.targetY = s.y;
    peer.targetHeading = s.heading;
    peer.speed = s.speed;
    peer.lap = s.lap;
    peer.progress = s.progress;
    peer.item = s.item;
    peer.effect = s.effect;
  }

  removePeer(slot: number): void {
    this.peers.delete(slot);
  }

  onPeerBlock(blockId: number): void {
    this.blockRespawn.set(blockId, this.raceTime + BLOCK_RESPAWN_S);
  }

  applyPeerItem(slot: number, item: ItemKind, x?: number, y?: number, targetSlot?: number, targetSlots?: number[]): void {
    switch (item) {
      case 'jumpscare':
        if (this.barrierT > 0) return void this.events.push({ kind: 'deflect' });
        this.scareT = 1.6 * this.car.hitRecoveryMult;
        this.events.push({ kind: 'scared' });
        break;
      case 'scare2':
        if (targetSlots?.includes(this.slot)) {
          if (this.barrierT > 0) return void this.events.push({ kind: 'deflect' });
          this.scareT = 1.6 * this.car.hitRecoveryMult;
          this.events.push({ kind: 'scared' });
        }
        break;
      case 'lightning':
        if (this.barrierT > 0) return void this.events.push({ kind: 'deflect' });
        this.slowT = 3.0 * this.car.hitRecoveryMult;
        this.events.push({ kind: 'zapped' });
        break;
      case 'dj':
        if (targetSlot === this.slot) {
          if (this.barrierT > 0) return void this.events.push({ kind: 'deflect' });
          this.djT = DJ_DURATION * this.car.hitRecoveryMult;
          this.events.push({ kind: 'disco', bySlot: slot });
        }
        break;
      case 'rocket':
        // everyone renders the chase; only the target eats the hit (in update)
        if (targetSlot !== undefined) {
          this.launchRocket(slot, targetSlot);
          if (targetSlot === this.slot) this.events.push({ kind: 'rocketIncoming', bySlot: slot });
        }
        break;
      case 'oil':
        if (x !== undefined && y !== undefined) this.puddles.push({ x, y, mine: false });
        break;
      case 'steal':
        if (targetSlot === this.slot && this.item) {
          this.item = null;
          this.events.push({ kind: 'stolen', bySlot: slot });
        }
        break;
      case 'boost':
      case 'sword':
      case 'shield':
        break; // visuals come through peer state.effect
    }
  }

  onPeerFire(slot: number, x: number, y: number, heading: number): void {
    this.bullets.push({
      x, y,
      vx: Math.cos(heading) * BULLET_SPEED,
      vy: Math.sin(heading) * BULLET_SPEED,
      ttl: BULLET_TTL,
      shooterSlot: slot,
      source: 'bullet',
    });
  }

  onPeerPlaceBlock(slot: number, x: number, y: number): void {
    this.roadBlocks.push({ x, y, placerSlot: slot, immuneUntil: 0 });
  }

  onPeerTurret(slot: number, x: number, y: number): void {
    this.turrets.push({ x, y, ownerSlot: slot, expiresAt: this.raceTime + TURRET_LIFETIME, lastShot: -99, aimAngle: 0 });
  }

  /** BOOM — I got sent back to the starting line. */
  onPeerBoom(slot: number): void {
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.heading = this.spawnHeading;
    this.vx = 0;
    this.vy = 0;
    this.spinT = 1.2 * this.car.hitRecoveryMult;
    this.centerHint = nearestCenterIndex(this.track, this.x, this.y);
    this.prevProgress = progressAt(this.track, this.centerHint);
    this.events.push({ kind: 'boomed', bySlot: slot });
  }

  onPeerHypno(slot: number): void {
    this.hypnoT = HYPNO_DURATION;
    this.hypnoSource = slot;
    this.events.push({ kind: 'hypnoed', bySlot: slot });
  }

  useItem(): void {
    if (!this.item || !this.running || this.finished) return;
    const item = this.item;
    this.item = null;
    switch (item) {
      case 'boost':
        this.boostT = 1.25;
        this.events.push({ kind: 'use', item });
        break;
      case 'jumpscare':
      case 'lightning':
        this.events.push({ kind: 'use', item });
        break;
      case 'oil': {
        const px = this.x - Math.cos(this.heading) * 36;
        const py = this.y - Math.sin(this.heading) * 36;
        this.puddles.push({ x: px, y: py, mine: true });
        this.oilImmuneT = 1.5;
        this.events.push({ kind: 'use', item, x: px, y: py });
        break;
      }
      case 'sword':
        this.swordT = SWORD_DURATION;
        this.events.push({ kind: 'use', item });
        break;
      case 'shield':
        this.barrierT = BARRIER_DURATION;
        this.events.push({ kind: 'use', item });
        break;
      case 'steal': {
        const candidates = [...this.peers.values()].filter((p) => p.item !== null);
        if (candidates.length === 0) {
          this.events.push({ kind: 'stealFailed' });
          this.events.push({ kind: 'use', item });
          break;
        }
        const victim = candidates[Math.floor(Math.random() * candidates.length)];
        this.item = victim.item;
        this.events.push({ kind: 'use', item, targetSlot: victim.slot, stolen: victim.item ?? undefined });
        this.events.push({ kind: 'pickup', item: this.item! });
        break;
      }
      case 'dj': {
        const target = this.randomPeerSlot(1);
        if (target.length === 0) {
          this.events.push({ kind: 'noTarget' });
          break;
        }
        this.events.push({ kind: 'use', item, targetSlot: target[0] });
        break;
      }
      case 'scare2': {
        const targets = this.randomPeerSlot(2);
        if (targets.length === 0) {
          this.events.push({ kind: 'noTarget' });
          break;
        }
        this.events.push({ kind: 'use', item, targetSlots: targets });
        break;
      }
      case 'rocket': {
        const target = this.randomPeerSlot(1);
        if (target.length === 0) {
          this.events.push({ kind: 'noTarget' });
          break;
        }
        this.launchRocket(this.slot, target[0]);
        this.events.push({ kind: 'use', item, targetSlot: target[0] });
        break;
      }
    }
  }

  /** Up to n distinct random peer slots (for dj / scare2 / rocket targeting). */
  private randomPeerSlot(n: number): number[] {
    const pool = [...this.peers.keys()];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
  }

  /** Spawn a homing rocket a bit behind its target. */
  launchRocket(fromSlot: number, targetSlot: number): void {
    const tp = this.rocketTargetPos(targetSlot);
    if (!tp) return;
    this.rockets.push({
      fromSlot,
      targetSlot,
      t: ROCKET_FLIGHT_S,
      x: tp.x - Math.cos(tp.heading) * 320,
      y: tp.y - Math.sin(tp.heading) * 320,
    });
  }

  private rocketTargetPos(slot: number): { x: number; y: number; heading: number } | null {
    if (slot === this.slot) return { x: this.x, y: this.y, heading: this.heading };
    const p = this.peers.get(slot);
    return p ? { x: p.x, y: p.y, heading: p.heading } : null;
  }

  private updateRockets(dt: number): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const tp = this.rocketTargetPos(r.targetSlot);
      if (!tp) {
        this.rockets.splice(i, 1);
        continue;
      }
      // home so it always arrives exactly when the timer runs out
      const k = Math.min(1, dt / Math.max(0.05, r.t));
      r.x += (tp.x - r.x) * k;
      r.y += (tp.y - r.y) * k;
      r.t -= dt;
      if (r.t > 0) continue;
      this.rockets.splice(i, 1);
      if (r.targetSlot === this.slot) {
        if (this.barrierT > 0) this.events.push({ kind: 'deflect' });
        else this.hitMe('rocket', r.fromSlot, 0.95, 0.35);
      }
    }
  }

  fire(): void {
    if (!this.running || this.finished || this.fireCd > 0) return;
    if (this.bulletsLeft <= 0) {
      this.events.push({ kind: 'empty' });
      return;
    }
    this.bulletsLeft -= 1;
    this.fireCd = FIRE_COOLDOWN;
    const nx = Math.cos(this.heading);
    const ny = Math.sin(this.heading);
    const bx = this.x + nx * (KART_RADIUS + 8);
    const by = this.y + ny * (KART_RADIUS + 8);
    this.bullets.push({
      x: bx, y: by,
      vx: nx * BULLET_SPEED + this.vx * 0.4,
      vy: ny * BULLET_SPEED + this.vy * 0.4,
      ttl: BULLET_TTL,
      shooterSlot: this.slot,
      source: 'bullet',
    });
    this.events.push({ kind: 'fire', x: bx, y: by, heading: this.heading });
  }

  placeRoadBlock(): void {
    if (!this.running || this.finished) return;
    if (this.blocksLeft <= 0) {
      this.events.push({ kind: 'empty' });
      return;
    }
    this.blocksLeft -= 1;
    const px = this.x - Math.cos(this.heading) * 42;
    const py = this.y - Math.sin(this.heading) * 42;
    this.roadBlocks.push({ x: px, y: py, placerSlot: this.slot, immuneUntil: this.raceTime + 2 });
    this.events.push({ kind: 'placeBlock', x: px, y: py });
  }

  placeTurret(): void {
    if (!this.running || this.finished) return;
    if (this.turretsLeft <= 0) {
      this.events.push({ kind: 'empty' });
      return;
    }
    this.turretsLeft -= 1;
    const px = this.x - Math.cos(this.heading) * 50;
    const py = this.y - Math.sin(this.heading) * 50;
    this.turrets.push({ x: px, y: py, ownerSlot: this.slot, expiresAt: this.raceTime + TURRET_LIFETIME, lastShot: -99, aimAngle: this.heading });
    this.events.push({ kind: 'turret', x: px, y: py });
  }

  useBoom(): void {
    if (!this.running || this.finished) return;
    if (this.boomsLeft <= 0) {
      this.events.push({ kind: 'empty' });
      return;
    }
    this.boomsLeft -= 1; // server re-syncs via ammo message
    this.events.push({ kind: 'boom' });
  }

  useHypno(): void {
    if (!this.running || this.finished) return;
    if (this.hypnosLeft <= 0) {
      this.events.push({ kind: 'empty' });
      return;
    }
    this.hypnosLeft -= 1; // server re-syncs via ammo message
    this.events.push({ kind: 'hypno' });
  }

  blockActive(blockId: number): boolean {
    const at = this.blockRespawn.get(blockId);
    return at === undefined || this.raceTime >= at;
  }

  myRank(): number {
    const mine = this.lap + this.progress;
    let ahead = 0;
    for (const p of this.peers.values()) {
      if (p.lap + p.progress > mine) ahead++;
    }
    return 1 + ahead;
  }

  update(
    dt: number,
    input: InputState,
    actions: { useItem: boolean; fire: boolean; place: boolean; turret: boolean; boom: boolean; hypno: boolean },
  ): void {
    if (this.running && !this.finished) this.raceTime += dt;

    for (const key of ['boostT', 'spinT', 'scareT', 'slowT', 'shakeT', 'shieldT', 'swordT', 'barrierT', 'hypnoT', 'djT'] as const) {
      this[key] = Math.max(0, this[key] - dt);
    }
    this.spikeCd = Math.max(0, this.spikeCd - dt);
    this.trapCd = Math.max(0, this.trapCd - dt);
    this.oilImmuneT = Math.max(0, this.oilImmuneT - dt);
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.meleeCd = Math.max(0, this.meleeCd - dt);

    if (actions.useItem) this.useItem();
    if (actions.fire) this.fire();
    if (actions.place) this.placeRoadBlock();
    if (actions.turret) this.placeTurret();
    if (actions.boom) this.useBoom();
    if (actions.hypno) this.useHypno();

    const theme = this.track.theme;
    const controllable = this.running && !this.finished && this.spinT === 0;

    // --- mind control: while hypnotized, drive like the hypnotist
    let throttle = input.throttle;
    let steer = input.steer;
    if (this.hypnoT > 0) {
      const master = this.peers.get(this.hypnoSource);
      if (master) {
        let dhm = master.heading - this.heading;
        while (dhm > Math.PI) dhm -= Math.PI * 2;
        while (dhm < -Math.PI) dhm += Math.PI * 2;
        steer = Math.max(-1, Math.min(1, dhm * 2.5));
        throttle = this.speed < master.speed ? 1 : 0;
      }
    }
    if (this.scareT > 0) steer = -steer + (Math.random() * 2 - 1) * 0.8;

    const fx = Math.cos(this.heading);
    const fy = Math.sin(this.heading);

    const maxSpeed = MAX_SPEED * this.car.maxSpeedMult * (this.boostT > 0 ? 1.55 : 1) * (this.slowT > 0 ? 0.5 : 1) * (this.djT > 0 ? DJ_SLOW : 1);
    if (controllable) {
      const accel = ACCEL * this.car.accelMult * (this.boostT > 0 ? 1.9 : 1);
      if (throttle > 0) {
        this.vx += fx * accel * throttle * dt;
        this.vy += fy * accel * throttle * dt;
      } else if (throttle < 0) {
        this.vx += fx * BRAKE * throttle * dt;
        this.vy += fy * BRAKE * throttle * dt;
      }
    }

    let vF = this.vx * fx + this.vy * fy;
    const lxAxis = -fy;
    const lyAxis = fx;
    let vL = this.vx * lxAxis + this.vy * lyAxis;
    vF *= Math.max(0, 1 - FORWARD_DRAG * dt);
    vL *= Math.max(0, 1 - 9 * Math.min(1.4, theme.grip * this.car.gripMult) * dt);
    vF = Math.max(-REVERSE_MAX, Math.min(maxSpeed, vF));
    if (this.spinT > 0) vF *= Math.max(0, 1 - 1.2 * dt);
    this.vx = fx * vF + lxAxis * vL;
    this.vy = fy * vF + lyAxis * vL;

    if (controllable && steer !== 0) {
      const speedFactor = Math.max(-1, Math.min(1, vF / MAX_SPEED));
      this.heading += steer * STEER_RATE * this.car.steerMult * speedFactor * dt;
    }
    if (this.spinT > 0) this.spinAngle += dt * 12;
    else this.spinAngle = 0;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.centerHint = nearestCenterIndex(this.track, this.x, this.y, this.centerHint);
    const cp = this.track.center[this.centerHint];
    const dx = this.x - cp.x;
    const dy = this.y - cp.y;
    const d = Math.hypot(dx, dy);
    const hw = this.track.halfWidth;
    if (d > hw) {
      const keep = Math.pow(theme.offRoadKeep, dt * 60);
      this.vx *= keep;
      this.vy *= keep;
    }
    const wall = hw + WALL_MARGIN;
    if (d > wall && d > 0) {
      const nx = dx / d;
      const ny = dy / d;
      this.x = cp.x + nx * wall;
      this.y = cp.y + ny * wall;
      const outward = this.vx * nx + this.vy * ny;
      if (outward > 0) {
        this.vx -= 1.4 * outward * nx;
        this.vy -= 1.4 * outward * ny;
      }
    }

    if (this.running && !this.finished) {
      this.updateTurrets(dt);
      this.updateBullets(dt);
      this.updateRockets(dt);
      this.checkRoadBlocks();
      this.checkSwords();
      this.checkHazards();
      this.checkPuddles();
      this.checkBlocks();
      this.checkLap();
    }

    const k = 1 - Math.exp(-dt * 12);
    for (const p of this.peers.values()) {
      p.x += (p.targetX - p.x) * k;
      p.y += (p.targetY - p.y) * k;
      let dhp = p.targetHeading - p.heading;
      while (dhp > Math.PI) dhp -= Math.PI * 2;
      while (dhp < -Math.PI) dhp += Math.PI * 2;
      p.heading += dhp * k;
    }
  }

  /** Turrets aim at the nearest non-owner kart; each client only spawns the
   * bullets that target ITSELF (victim-authoritative, like everything else). */
  private updateTurrets(dt: number): void {
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      if (this.raceTime > t.expiresAt) {
        this.turrets.splice(i, 1);
        continue;
      }
      // aim at nearest kart that isn't the owner (me or a peer) for visuals
      let best: { x: number; y: number; d: number } | null = null;
      if (t.ownerSlot !== this.slot) {
        best = { x: this.x, y: this.y, d: Math.hypot(this.x - t.x, this.y - t.y) };
      }
      for (const p of this.peers.values()) {
        if (p.slot === t.ownerSlot) continue;
        const pd = Math.hypot(p.x - t.x, p.y - t.y);
        if (!best || pd < best.d) best = { x: p.x, y: p.y, d: pd };
      }
      if (best && best.d < TURRET_RANGE) {
        const target = Math.atan2(best.y - t.y, best.x - t.x);
        let da = target - t.aimAngle;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        t.aimAngle += da * Math.min(1, dt * 6);
      }
      // fire at ME if I'm in range and not the owner
      if (t.ownerSlot !== this.slot) {
        const dMe = Math.hypot(this.x - t.x, this.y - t.y);
        if (dMe < TURRET_RANGE && this.raceTime - t.lastShot >= TURRET_INTERVAL) {
          t.lastShot = this.raceTime;
          const aim = Math.atan2(this.y + this.vy * 0.25 - t.y, this.x + this.vx * 0.25 - t.x);
          this.bullets.push({
            x: t.x + Math.cos(aim) * 14,
            y: t.y + Math.sin(aim) * 14,
            vx: Math.cos(aim) * BULLET_SPEED * 0.85,
            vy: Math.sin(aim) * BULLET_SPEED * 0.85,
            ttl: BULLET_TTL,
            shooterSlot: t.ownerSlot,
            source: 'turret',
          });
        }
      }
    }
  }

  private hitMe(source: HitSource, shooterSlot: number, spin: number, keep: number): void {
    const armored = (source === 'bullet' || source === 'turret') ? this.armorBullets > 0 : source === 'block' && this.armorBlocks > 0;
    if (armored) {
      if (source === 'block') this.armorBlocks -= 1;
      else this.armorBullets -= 1;
      this.shieldT = 0.8;
      this.events.push({ kind: 'hit', source, absorbed: true, shooterSlot });
    } else {
      this.spinT = spin * this.car.hitRecoveryMult;
      this.vx *= keep;
      this.vy *= keep;
      this.events.push({ kind: 'hit', source, absorbed: false, shooterSlot });
    }
  }

  private updateBullets(dt: number): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.ttl -= dt;
      if (b.ttl <= 0) {
        this.bullets.splice(i, 1);
        continue;
      }
      if (b.shooterSlot === this.slot) {
        for (const p of this.peers.values()) {
          if (Math.hypot(b.x - p.x, b.y - p.y) < 24) {
            this.bullets.splice(i, 1);
            break;
          }
        }
        continue;
      }
      if (Math.hypot(b.x - this.x, b.y - this.y) < 14 + KART_RADIUS) {
        const { shooterSlot, source } = b;
        this.bullets.splice(i, 1);
        if (this.barrierT > 0) {
          this.events.push({ kind: 'deflect' });
        } else {
          this.hitMe(source, shooterSlot, 0.8, 0.35);
        }
      }
    }
  }

  private checkRoadBlocks(): void {
    for (let i = this.roadBlocks.length - 1; i >= 0; i--) {
      const rb = this.roadBlocks[i];
      if (rb.placerSlot === this.slot && this.raceTime < rb.immuneUntil) continue;
      if (Math.hypot(this.x - rb.x, this.y - rb.y) < ROAD_BLOCK_RADIUS + KART_RADIUS) {
        this.roadBlocks.splice(i, 1);
        this.hitMe('block', rb.placerSlot, 1.0, 0.15);
      }
    }
  }

  /** Ramming: a peer with their sword drawn slices me on contact. */
  private checkSwords(): void {
    if (this.meleeCd > 0 || this.barrierT > 0) return;
    for (const p of this.peers.values()) {
      if (p.effect !== 'sword') continue;
      if (Math.hypot(this.x - p.x, this.y - p.y) < KART_RADIUS * 2 + 8) {
        this.meleeCd = 1.2;
        this.spinT = 0.9 * this.car.hitRecoveryMult;
        this.vx *= 0.3;
        this.vy *= 0.3;
        this.events.push({ kind: 'hit', source: 'sword', absorbed: false, shooterSlot: p.slot });
        break;
      }
    }
  }

  private checkHazards(): void {
    for (const h of this.track.hazards) {
      const d = Math.hypot(this.x - h.x, this.y - h.y);
      if (d > h.radius + KART_RADIUS) continue;
      if (h.kind === 'spikes' && this.spikeCd === 0) {
        this.vx *= 0.3;
        this.vy *= 0.3;
        this.shakeT = 0.4;
        this.spikeCd = 1.2;
        this.events.push({ kind: 'spike' });
      } else if (h.kind === 'trap' && this.trapCd === 0 && trapClosed(h, this.raceTime)) {
        this.vx *= 0.25;
        this.vy *= 0.25;
        this.spinT = 1.0 * this.car.hitRecoveryMult;
        this.trapCd = 1.8;
        this.events.push({ kind: 'trap' });
      }
    }
  }

  private checkPuddles(): void {
    if (this.barrierT > 0) return;
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      const p = this.puddles[i];
      if (p.mine && this.oilImmuneT > 0) continue;
      if (Math.hypot(this.x - p.x, this.y - p.y) < 20 + KART_RADIUS) {
        this.puddles.splice(i, 1);
        this.spinT = 0.9 * this.car.hitRecoveryMult;
        this.vx *= 0.4;
        this.vy *= 0.4;
        this.events.push({ kind: 'spin' });
      }
    }
  }

  private checkBlocks(): void {
    if (this.item) return;
    for (const b of this.track.blocks) {
      if (!this.blockActive(b.id)) continue;
      if (Math.hypot(this.x - b.x, this.y - b.y) < this.pickupReach) {
        this.blockRespawn.set(b.id, this.raceTime + BLOCK_RESPAWN_S);
        this.item = ITEM_POOL[Math.floor(Math.random() * ITEM_POOL.length)];
        this.events.push({ kind: 'pickup', item: this.item });
        this.events.push({ kind: 'block', blockId: b.id });
        break;
      }
    }
  }

  private checkLap(): void {
    const p = progressAt(this.track, this.centerHint);
    this.progress = p;
    if (p > 0.2 && p < 0.3) this.checkpoints[0] = true;
    if (p > 0.45 && p < 0.55) this.checkpoints[1] = true;
    if (p > 0.7 && p < 0.8) this.checkpoints[2] = true;

    const crossedForward = this.prevProgress > 0.8 && p < 0.2;
    this.prevProgress = p;
    if (!crossedForward) return;
    if (!this.checkpoints.every(Boolean)) return;

    this.checkpoints = [false, false, false];
    const nowMs = this.raceTime * 1000;
    const lapMs = nowMs - this.lapStartMs;
    this.lapStartMs = nowMs;
    if (this.bestLapMs === 0 || lapMs < this.bestLapMs) this.bestLapMs = lapMs;

    if (this.lap >= RACE_LAPS) {
      this.finished = true;
      this.finishTimeMs = Math.round(nowMs);
      this.events.push({ kind: 'finish', timeMs: this.finishTimeMs, bestLapMs: Math.round(this.bestLapMs) });
    } else {
      this.lap += 1;
      this.events.push({ kind: 'lap', lap: this.lap });
    }
  }
}
