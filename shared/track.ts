/** Deterministic procedural track generation.
 *
 * generateTrack(seed, level, biome) must produce byte-identical results on both
 * players' machines — all randomness comes from the seeded RNG, no Math.random.
 *
 * Level 1 is a giant oval; higher levels add more corners (more control points),
 * stronger radial noise (sharper turns), a narrower road, and more spikes,
 * traps, and lucky blocks.
 */
import { mulberry32 } from './rng';

export type Biome = 'jungle' | 'snow' | 'desert' | 'volcano';
export const BIOME_LIST: readonly Biome[] = ['jungle', 'snow', 'desert', 'volcano'];

export interface BiomeTheme {
  label: string;
  emoji: string;
  ground: string;
  groundDots: string; // texture speckles on the ground
  road: string;
  roadEdge: string;
  startLine: string;
  decoKinds: string[]; // rendered by the client per kind
  sky: string; // page/backdrop tint
  /** lateral grip multiplier (snow < 1 = drifty) */
  grip: number;
  /** velocity kept per tick while off the road (lower = harsher) */
  offRoadKeep: number;
}

export const BIOMES: Record<Biome, BiomeTheme> = {
  jungle: {
    label: 'Jungle', emoji: '🌴',
    ground: '#1e4d2b', groundDots: '#2a6339', road: '#6b5a44', roadEdge: '#f5e9c9',
    startLine: '#ffffff', decoKinds: ['tree', 'bush', 'flower'], sky: '#0d2818',
    grip: 1.0, offRoadKeep: 0.9,
  },
  snow: {
    label: 'Snow', emoji: '❄️',
    ground: '#dfe9f2', groundDots: '#ffffff', road: '#4a5560', roadEdge: '#d64545',
    startLine: '#ffffff', decoKinds: ['pine', 'snowman', 'rock'], sky: '#aebfd1',
    grip: 0.6, offRoadKeep: 0.93,
  },
  desert: {
    label: 'Desert', emoji: '🌵',
    ground: '#d9b56c', groundDots: '#c9a355', road: '#8a7454', roadEdge: '#fff3d6',
    startLine: '#ffffff', decoKinds: ['cactus', 'skull', 'rock'], sky: '#c98f3d',
    grip: 1.0, offRoadKeep: 0.92,
  },
  volcano: {
    label: 'Volcano', emoji: '🌋',
    ground: '#2b1a1a', groundDots: '#3d2222', road: '#4d4348', roadEdge: '#ff7b39',
    startLine: '#ffd23e', decoKinds: ['lava', 'boulder', 'ember'], sky: '#1a0d0d',
    grip: 1.0, offRoadKeep: 0.85,
  },
};

export interface Vec2 { x: number; y: number; }

export interface Hazard {
  kind: 'spikes' | 'trap';
  x: number;
  y: number;
  angle: number;
  /** traps: phase offset (s) of the open/close cycle */
  phase: number;
  radius: number;
}

export interface LuckyBlock {
  id: number;
  x: number;
  y: number;
}

export interface Decoration { x: number; y: number; kind: string; size: number; }

export interface Track {
  seed: number;
  level: number;
  biome: Biome;
  theme: BiomeTheme;
  /** dense closed-loop centerline, index 0 = start/finish */
  center: Vec2[];
  /** unit normals (points to the left of travel direction) per center point */
  normal: Vec2[];
  halfWidth: number;
  hazards: Hazard[];
  blocks: LuckyBlock[];
  decorations: Decoration[];
  /** cumulative arc length at each center index */
  cumLength: number[];
  totalLength: number;
  /** world-space bounds for the minimap */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export const TRAP_PERIOD_S = 2.6; // open→snap cycle
export const TRAP_CLOSED_FRACTION = 0.35; // last 35% of the cycle = snapped shut
export const BLOCK_RESPAWN_S = 5;

/** Is a snapping trap closed (dangerous) at race time t (seconds since GO)? */
export function trapClosed(hazard: Hazard, raceTimeS: number): boolean {
  const t = (raceTimeS + hazard.phase) % TRAP_PERIOD_S;
  return t > TRAP_PERIOD_S * (1 - TRAP_CLOSED_FRACTION);
}

function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

export function generateTrack(seed: number, level: number, biome: Biome): Track {
  const rand = mulberry32(seed * 7919 + level * 104729 + 13);
  const lvl = Math.max(1, Math.min(5, Math.round(level)));

  // Control ring: more points = more corners; more noise = sharper corners.
  const nCtrl = 12 + lvl * 3;
  const baseRx = 640;
  const baseRy = 470;
  const amp = (lvl - 1) * 0.085; // radius multiplier noise; 0 at level 1 → oval

  let mults: number[] = [];
  for (let i = 0; i < nCtrl; i++) {
    mults.push(1 + (rand() * 2 - 1) * amp);
  }
  // One neighbor-smoothing pass keeps high levels twisty but drivable and
  // avoids self-intersecting loops.
  if (lvl >= 2) {
    mults = mults.map((m, i) => {
      const prev = mults[(i - 1 + nCtrl) % nCtrl];
      const next = mults[(i + 1) % nCtrl];
      return Math.max(0.6, Math.min(1.4, 0.25 * prev + 0.5 * m + 0.25 * next));
    });
  }

  const ctrl: Vec2[] = [];
  for (let i = 0; i < nCtrl; i++) {
    const th = (i / nCtrl) * Math.PI * 2;
    ctrl.push({ x: Math.cos(th) * baseRx * mults[i], y: Math.sin(th) * baseRy * mults[i] });
  }

  // Dense centerline via closed Catmull-Rom.
  const perSeg = Math.max(20, Math.ceil(720 / nCtrl));
  const center: Vec2[] = [];
  for (let i = 0; i < nCtrl; i++) {
    const p0 = ctrl[(i - 1 + nCtrl) % nCtrl];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % nCtrl];
    const p3 = ctrl[(i + 2) % nCtrl];
    for (let s = 0; s < perSeg; s++) {
      center.push(catmullRom(p0, p1, p2, p3, s / perSeg));
    }
  }
  const n = center.length;

  // Normals + arc length.
  const normal: Vec2[] = [];
  const cumLength: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = center[i];
    const b = center[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    normal.push({ x: -dy / len, y: dx / len });
    if (i > 0) cumLength.push(cumLength[i - 1] + len);
  }
  const last = center[n - 1];
  const totalLength = cumLength[n - 1] + Math.hypot(center[0].x - last.x, center[0].y - last.y);

  const halfWidth = 62 - (lvl - 1) * 6; // 62 → 38

  // --- Hazards: spikes (always slow you) + snapping traps (spin when closed).
  // Keep the first ~10% after the start line clean.
  const hazards: Hazard[] = [];
  const usedIdx: number[] = [];
  const minGap = Math.floor(n * 0.03);
  const pickIndex = (): number => {
    for (let tries = 0; tries < 60; tries++) {
      const idx = Math.floor((0.1 + rand() * 0.86) * n);
      if (usedIdx.every((u) => Math.abs(u - idx) > minGap && Math.abs(u - idx) < n - minGap)) {
        usedIdx.push(idx);
        return idx;
      }
    }
    return Math.floor(rand() * n);
  };

  const nSpikes = 2 + lvl * 2;
  for (let i = 0; i < nSpikes; i++) {
    const idx = pickIndex();
    const off = (rand() * 2 - 1) * halfWidth * 0.55;
    hazards.push({
      kind: 'spikes',
      x: center[idx].x + normal[idx].x * off,
      y: center[idx].y + normal[idx].y * off,
      angle: Math.atan2(normal[idx].y, normal[idx].x),
      phase: 0,
      radius: 16,
    });
  }
  const nTraps = Math.max(1, lvl * 2 - 1);
  for (let i = 0; i < nTraps; i++) {
    const idx = pickIndex();
    const off = (rand() * 2 - 1) * halfWidth * 0.4;
    hazards.push({
      kind: 'trap',
      x: center[idx].x + normal[idx].x * off,
      y: center[idx].y + normal[idx].y * off,
      angle: rand() * Math.PI * 2,
      phase: rand() * TRAP_PERIOD_S,
      radius: 17,
    });
  }

  // --- Lucky blocks: Mario-Kart-style rows of 2, more rows at higher levels.
  const blocks: LuckyBlock[] = [];
  const nRows = 4 + lvl;
  let blockId = 0;
  for (let r = 0; r < nRows; r++) {
    const idx = Math.floor(((r + 0.5) / nRows) * 0.9 * n + 0.08 * n) % n;
    for (const lane of [-0.45, 0.45]) {
      blocks.push({
        id: blockId++,
        x: center[idx].x + normal[idx].x * halfWidth * lane,
        y: center[idx].y + normal[idx].y * halfWidth * lane,
      });
    }
  }

  // --- Biome decorations sprinkled outside the road.
  const theme = BIOMES[biome];
  const decorations: Decoration[] = [];
  const clearance = halfWidth + 30;
  for (let tries = 0; tries < 320 && decorations.length < 90; tries++) {
    const th = rand() * Math.PI * 2;
    const rr = (0.15 + rand() * 1.25) * Math.max(baseRx, baseRy);
    const p = { x: Math.cos(th) * rr, y: Math.sin(th) * rr };
    let minD = Infinity;
    for (let i = 0; i < n; i += 6) {
      const d = Math.hypot(center[i].x - p.x, center[i].y - p.y);
      if (d < minD) minD = d;
    }
    if (minD > clearance) {
      decorations.push({
        x: p.x, y: p.y,
        kind: theme.decoKinds[Math.floor(rand() * theme.decoKinds.length)],
        size: 14 + rand() * 22,
      });
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of center) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const pad = halfWidth + 60;

  return {
    seed, level: lvl, biome, theme,
    center, normal, halfWidth, hazards, blocks, decorations,
    cumLength, totalLength,
    bounds: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad },
  };
}

/** Nearest centerline index to a world point. `hint` makes it a cheap local
 * search during play; without it, does a full scan (used on spawn). */
export function nearestCenterIndex(track: Track, x: number, y: number, hint?: number): number {
  const n = track.center.length;
  const dist2 = (i: number) => {
    const p = track.center[i];
    return (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
  };
  if (hint === undefined) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = dist2(i);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  let best = ((hint % n) + n) % n;
  let bestD = dist2(best);
  let improved = true;
  while (improved) {
    improved = false;
    for (const step of [1, -1, 3, -3, 9, -9]) {
      const i = (best + step + n) % n;
      const d = dist2(i);
      if (d < bestD) { bestD = d; best = i; improved = true; }
    }
  }
  return best;
}

/** Fraction of the lap completed at centerline index i (0..1). */
export function progressAt(track: Track, i: number): number {
  return track.cumLength[i] / track.totalLength;
}
