/** In-memory game rooms for up to MAX_PLAYERS racers. The host creates a room
 * and gets a 5-digit code; others join via /game/<code>. The host starts the
 * race when everyone's in. During the race the server relays kart state and
 * combat events between all racers, enforces ammo against wallets, and
 * persists placements + points to Piezas. All room state is ephemeral. */
import { WebSocket } from 'ws';
import { randomInt, randomUUID } from 'node:crypto';
import {
  MAX_PLAYERS,
  type ClientMessage,
  type PlayerInfo,
  type ServerMessage,
  type Standing,
} from '../shared/protocol';
import { BIOME_LIST, type Biome } from '../shared/track';
import type { HitSource, KartState } from '../shared/protocol';
import { HIT_BONUS, HIT_BONUS_CAP, placementPoints, type Wallet } from '../shared/economy';
import { colorForSlot, CAR_LIST, DEFAULT_CAR, isCarKind, isPlayerColor, type CarKind } from '../shared/cars';
import { isPetKind, type PetKind } from '../shared/pets';
import { BOT_NAMES, isBotSkill, MAX_BOTS, type BotSkill } from '../shared/bots';
import { mulberry32 } from '../shared/rng';
import { getWallet, recordRaceResult, type RaceUsage } from './piezas';
import type { SessionUser } from './session';

const WAITING_ROOM_TTL_MS = 30 * 60 * 1000;
const FINISH_GRACE_MS = 60 * 1000;
const READY_TIMEOUT_MS = 10 * 1000;

export interface GameClient {
  ws: WebSocket;
  playerId: string;
  username: string;
  room: Room | null;
  slot: number;
}

type Phase = 'waiting' | 'starting' | 'racing' | 'done';

const emptyUsage = (): RaceUsage => ({
  bulletsUsed: 0,
  blocksUsed: 0,
  armorBulletsUsed: 0,
  armorBlocksUsed: 0,
  turretsUsed: 0,
  boomsUsed: 0,
  hypnosUsed: 0,
});

interface Room {
  code: string;
  raceId: string;
  seed: number;
  level: number;
  biome: Biome;
  phase: Phase;
  players: PlayerInfo[]; // slot-indexed, frozen at start (bots appended after humans)
  clients: (GameClient | null)[]; // per slot; null after a player leaves (always null for bots)
  botCount: number; // AI racers the host asked for (added to the roster at start)
  botSkill: BotSkill;
  ready: boolean[];
  times: (number | null)[];
  bestLaps: (number | null)[];
  loadouts: (Wallet | null)[];
  usage: RaceUsage[];
  hitBonus: number[];
  boomUsed: boolean; // BOOM is once per race, first come first served
  hypnoUsed: boolean[]; // hypno is once per race per player
  expireTimer: NodeJS.Timeout | null;
  finishTimer: NodeJS.Timeout | null;
  readyTimer: NodeJS.Timeout | null;
  countdownTimers: NodeJS.Timeout[];
}

const rooms = new Map<string, Room>();

export function createClient(ws: WebSocket, user: SessionUser): GameClient {
  return { ws, playerId: user.playerId, username: user.username, room: null, slot: 0 };
}

function send(client: GameClient | null, msg: ServerMessage): void {
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

function broadcast(room: Room, msg: ServerMessage, exceptSlot?: number): void {
  for (const c of room.clients) {
    if (c && c.slot !== exceptSlot) send(c, msg);
  }
}

function connectedCount(room: Room): number {
  return room.clients.filter(Boolean).length;
}

function allocCode(): string {
  for (let tries = 0; tries < 50; tries++) {
    const code = String(randomInt(10000, 100000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('No free game codes');
}

function clearRoomTimers(room: Room): void {
  for (const t of [room.expireTimer, room.finishTimer, room.readyTimer, ...room.countdownTimers]) {
    if (t) clearTimeout(t);
  }
  room.expireTimer = null;
  room.finishTimer = null;
  room.readyTimer = null;
  room.countdownTimers = [];
}

function destroyRoom(room: Room): void {
  clearRoomTimers(room);
  rooms.delete(room.code);
  for (const c of room.clients) {
    if (c && c.room === room) c.room = null;
  }
}

function sendLobbyUpdate(room: Room): void {
  const bots = { count: room.botCount, skill: room.botSkill };
  for (const c of room.clients) {
    if (c) send(c, { type: 'lobby_update', code: room.code, players: room.players, yourSlot: c.slot, bots });
  }
}

function playerInfo(client: GameClient, slot: number, color?: string, car?: CarKind, pet?: PetKind | null): PlayerInfo {
  return {
    id: client.playerId,
    username: client.username,
    color: isPlayerColor(color) ? color : colorForSlot(slot),
    car: isCarKind(car) ? car : DEFAULT_CAR,
    pet: isPetKind(pet) ? pet : null,
  };
}

function isBotSlot(room: Room, slot: number): boolean {
  return Number.isInteger(slot) && !!room.players[slot]?.bot;
}

function handleCreate(client: GameClient, level: number, biome: Biome | 'random', color?: string, car?: CarKind, pet?: PetKind | null): void {
  if (client.room) detach(client);
  const lvl = Math.max(1, Math.min(5, Math.round(Number(level) || 1)));
  const chosenBiome: Biome =
    biome !== 'random' && (BIOME_LIST as readonly string[]).includes(biome)
      ? biome
      : BIOME_LIST[randomInt(0, BIOME_LIST.length)];

  const room: Room = {
    code: allocCode(),
    raceId: randomUUID(),
    seed: randomInt(1, 2 ** 31),
    level: lvl,
    biome: chosenBiome,
    phase: 'waiting',
    players: [playerInfo(client, 0, color, car, pet)],
    clients: [client],
    botCount: 0,
    botSkill: 'medium',
    ready: [],
    times: [],
    bestLaps: [],
    loadouts: [],
    usage: [],
    hitBonus: [],
    boomUsed: false,
    hypnoUsed: [],
    expireTimer: null,
    finishTimer: null,
    readyTimer: null,
    countdownTimers: [],
  };
  room.expireTimer = setTimeout(() => destroyRoom(room), WAITING_ROOM_TTL_MS);
  rooms.set(room.code, room);
  client.room = room;
  client.slot = 0;
  send(client, { type: 'created', code: room.code });
  sendLobbyUpdate(room);
}

function handleJoin(client: GameClient, code: string, color?: string, car?: CarKind, pet?: PetKind | null): void {
  const room = rooms.get(String(code).trim());
  if (!room || room.phase === 'done') {
    return send(client, { type: 'error', message: 'Game not found — check the code' });
  }
  if (room.phase !== 'waiting') {
    return send(client, { type: 'error', message: 'That race already started' });
  }
  if (room.players.length >= MAX_PLAYERS) {
    return send(client, { type: 'error', message: `Race is full (${MAX_PLAYERS} players max)` });
  }
  if (client.room) detach(client);

  client.room = room;
  client.slot = room.players.length;
  room.players.push(playerInfo(client, client.slot, color, car, pet));
  room.clients.push(client);
  sendLobbyUpdate(room);
}

/** Host picks how many AI robots race along, and how good they are. */
function handleSetBots(client: GameClient, count: number, skill: BotSkill): void {
  const room = client.room;
  if (!room || room.phase !== 'waiting') return;
  if (client.slot !== 0) {
    return send(client, { type: 'error', message: 'Only the host can add robot racers' });
  }
  room.botCount = Math.max(0, Math.min(MAX_BOTS, Math.round(Number(count) || 0)));
  room.botSkill = isBotSkill(skill) ? skill : 'medium';
  sendLobbyUpdate(room);
}

/** Append AI racers to the frozen roster (slots after the humans). */
function appendBots(room: Room): void {
  if (room.botCount <= 0) return;
  const rand = mulberry32(room.seed ^ 0xb07);
  // seeded shuffle so every race gets a fresh mix of robot names
  const names = [...BOT_NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  for (let i = 0; i < room.botCount; i++) {
    const slot = room.players.length;
    room.players.push({
      id: `bot:${i}`,
      username: names[i % names.length],
      color: colorForSlot(slot),
      car: CAR_LIST[Math.floor(rand() * CAR_LIST.length)],
      pet: null,
      bot: true,
      botSkill: room.botSkill,
    });
    room.clients.push(null);
    room.loadouts.push(null);
  }
}

async function handleStart(client: GameClient): Promise<void> {
  const room = client.room;
  if (!room || room.phase !== 'waiting') return;
  if (client.slot !== 0) {
    return send(client, { type: 'error', message: 'Only the host can start the race' });
  }

  if (room.expireTimer) clearTimeout(room.expireTimer);
  room.expireTimer = null;
  room.phase = 'starting';

  try {
    // humans only at this point — bots have no wallets
    room.loadouts = await Promise.all(room.players.map((p) => getWallet(p.id)));
  } catch (err) {
    console.error('failed to load wallets:', err);
    broadcast(room, { type: 'error', message: 'Could not start race, try again' });
    room.phase = 'waiting';
    room.expireTimer = setTimeout(() => destroyRoom(room), WAITING_ROOM_TTL_MS);
    return;
  }
  if (room.phase !== 'starting') return; // room fell apart while loading

  appendBots(room);
  const n = room.players.length;
  room.ready = Array(n).fill(false);
  room.times = Array(n).fill(null);
  room.bestLaps = Array(n).fill(null);
  room.usage = Array.from({ length: n }, emptyUsage);
  room.hitBonus = Array(n).fill(0);
  room.boomUsed = false;
  room.hypnoUsed = Array(n).fill(false);

  for (const c of room.clients) {
    if (c) {
      send(c, {
        type: 'race_config',
        raceId: room.raceId,
        code: room.code,
        seed: room.seed,
        level: room.level,
        biome: room.biome,
        players: room.players,
        yourSlot: c.slot,
        loadout: room.loadouts[c.slot]!,
      });
    }
  }
  // don't hang forever on a client that never reports ready
  room.readyTimer = setTimeout(() => beginCountdown(room), READY_TIMEOUT_MS);
}

function beginCountdown(room: Room): void {
  if (room.phase !== 'starting') return;
  if (room.readyTimer) clearTimeout(room.readyTimer);
  room.readyTimer = null;
  // 3-2-1-GO, one tick per second; 0 flips the room into racing.
  for (const value of [3, 2, 1, 0]) {
    room.countdownTimers.push(
      setTimeout(() => {
        if (value === 0) room.phase = 'racing';
        broadcast(room, { type: 'countdown', value });
      }, (3 - value) * 1000),
    );
  }
}

function handleReady(client: GameClient): void {
  const room = client.room;
  if (!room || room.phase !== 'starting') return;
  room.ready[client.slot] = true;
  const allReady = room.clients.every((c, slot) => !c || room.ready[slot]);
  if (allReady) beginCountdown(room);
}

function ammoLeft(room: Room, slot: number) {
  const loadout = room.loadouts[slot];
  const use = room.usage[slot];
  return {
    bullets: Math.max(0, (loadout?.bullets ?? 0) - use.bulletsUsed),
    blocks: Math.max(0, (loadout?.blocks ?? 0) - use.blocksUsed),
    turrets: Math.max(0, (loadout?.turrets ?? 0) - use.turretsUsed),
    booms: Math.max(0, (loadout?.booms ?? 0) - use.boomsUsed),
    hypnos: Math.max(0, (loadout?.hypnos ?? 0) - use.hypnosUsed),
  };
}

function handleFire(client: GameClient, x: number, y: number, heading: number): void {
  const room = client.room;
  if (!room || room.phase !== 'racing') return;
  const left = ammoLeft(room, client.slot);
  if (left.bullets <= 0) {
    return send(client, { type: 'ammo', ...left }); // out of bullets — correct the client
  }
  room.usage[client.slot].bulletsUsed += 1;
  broadcast(room, { type: 'peer_fire', slot: client.slot, x, y, heading }, client.slot);
  send(client, { type: 'ammo', ...ammoLeft(room, client.slot) });
}

function handlePlaceBlock(client: GameClient, x: number, y: number): void {
  const room = client.room;
  if (!room || room.phase !== 'racing') return;
  const left = ammoLeft(room, client.slot);
  if (left.blocks <= 0) {
    return send(client, { type: 'ammo', ...left });
  }
  room.usage[client.slot].blocksUsed += 1;
  broadcast(room, { type: 'peer_place_block', slot: client.slot, x, y }, client.slot);
  send(client, { type: 'ammo', ...ammoLeft(room, client.slot) });
}

function handleTurret(client: GameClient, x: number, y: number): void {
  const room = client.room;
  if (!room || room.phase !== 'racing') return;
  const left = ammoLeft(room, client.slot);
  if (left.turrets <= 0) {
    return send(client, { type: 'ammo', ...left });
  }
  room.usage[client.slot].turretsUsed += 1;
  broadcast(room, { type: 'peer_turret', slot: client.slot, x, y }, client.slot);
  send(client, { type: 'ammo', ...ammoLeft(room, client.slot) });
}

function handleBoom(client: GameClient): void {
  const room = client.room;
  if (!room || room.phase !== 'racing') return;
  const left = ammoLeft(room, client.slot);
  if (left.booms <= 0) {
    return send(client, { type: 'ammo', ...left });
  }
  if (room.boomUsed) {
    send(client, { type: 'error', message: 'The BOOM was already used this race!' });
    return send(client, { type: 'ammo', ...left });
  }
  room.boomUsed = true;
  room.usage[client.slot].boomsUsed += 1;
  broadcast(room, { type: 'peer_boom', slot: client.slot }, client.slot);
  send(client, { type: 'ammo', ...ammoLeft(room, client.slot) });
}

function handleHypno(client: GameClient): void {
  const room = client.room;
  if (!room || room.phase !== 'racing') return;
  const left = ammoLeft(room, client.slot);
  if (left.hypnos <= 0) {
    return send(client, { type: 'ammo', ...left });
  }
  if (room.hypnoUsed[client.slot]) {
    send(client, { type: 'error', message: 'You already hypnotized everyone this race!' });
    return send(client, { type: 'ammo', ...left });
  }
  room.hypnoUsed[client.slot] = true;
  room.usage[client.slot].hypnosUsed += 1;
  broadcast(room, { type: 'peer_hypno', slot: client.slot }, client.slot);
  send(client, { type: 'ammo', ...ammoLeft(room, client.slot) });
}

/** Victim-reported hit: either their armor absorbed it (consume armor) or it
 * landed (credit the shooter's hit bonus). The host reports hits ON BOTS with
 * victimSlot set (bots have no armor — those always credit the shooter). */
function handleHit(client: GameClient, source: HitSource, absorbed: boolean, shooterSlot: number, victimSlot?: number): void {
  const room = client.room;
  if (!room || room.phase !== 'racing') return;
  let victim = client.slot;
  if (victimSlot !== undefined) {
    if (client.slot !== 0 || !isBotSlot(room, victimSlot)) return;
    victim = victimSlot;
  }
  if (absorbed && victim === client.slot) {
    const use = room.usage[client.slot];
    const armor = room.loadouts[client.slot];
    if (source === 'bullet' && use.armorBulletsUsed < (armor?.armorBullets ?? 0)) use.armorBulletsUsed += 1;
    if (source === 'block' && use.armorBlocksUsed < (armor?.armorBlocks ?? 0)) use.armorBlocksUsed += 1;
  } else if (!absorbed && Number.isInteger(shooterSlot) && shooterSlot >= 0 && shooterSlot < room.players.length && shooterSlot !== victim) {
    room.hitBonus[shooterSlot] = Math.min(HIT_BONUS_CAP, room.hitBonus[shooterSlot] + HIT_BONUS);
  }
}

/** Host-reported: a bot crossed the finish line. */
function handleBotFinish(client: GameClient, slot: number, timeMs: number): void {
  const room = client.room;
  if (!room || room.phase !== 'racing' || client.slot !== 0) return;
  if (!isBotSlot(room, slot) || room.times[slot] !== null) return;
  room.times[slot] = Math.max(1, Math.round(timeMs));
  broadcast(room, { type: 'peer_finished', slot, timeMs }, 0);
  maybeFinishRace(room);
}

function maybeFinishRace(room: Room): void {
  // conclude when every HUMAN slot has finished or left (bots have null
  // clients so they never block conclusion — stragglers get placed anyway)
  const allDone = room.players.every((_, slot) => room.times[slot] !== null || !room.clients[slot]);
  if (allDone) {
    conclude(room, 'completed');
  } else if (!room.finishTimer && room.times.some((t, slot) => t !== null && !isBotSlot(room, slot))) {
    // the straggler clock starts on the first HUMAN finish — a fast bot
    // shouldn't put everyone on a 60s timer
    room.finishTimer = setTimeout(() => conclude(room, 'timeout'), FINISH_GRACE_MS);
  }
}

function handleFinish(client: GameClient, timeMs: number, bestLapMs: number): void {
  const room = client.room;
  if (!room || room.phase !== 'racing' || room.times[client.slot] !== null) return;
  room.times[client.slot] = Math.max(1, Math.round(timeMs));
  room.bestLaps[client.slot] = bestLapMs > 0 ? Math.round(bestLapMs) : null;
  broadcast(room, { type: 'peer_finished', slot: client.slot, timeMs }, client.slot);
  maybeFinishRace(room);
}

function conclude(room: Room, reason: 'completed' | 'forfeit' | 'timeout'): void {
  if (room.phase === 'done') return;
  room.phase = 'done';
  clearRoomTimers(room);

  // Placements: finishers by time, then still-connected non-finishers, then
  // unfinished bots, then leavers (no placement, no points).
  const slots = room.players.map((_, slot) => slot);
  const finishers = slots
    .filter((s) => room.times[s] !== null)
    .sort((a, b) => room.times[a]! - room.times[b]!);
  const stayers = slots.filter((s) => room.times[s] === null && room.clients[s]);
  const botStragglers = slots.filter((s) => room.times[s] === null && !room.clients[s] && isBotSlot(room, s));
  const leavers = slots.filter((s) => room.times[s] === null && !room.clients[s] && !isBotSlot(room, s));

  const placed = [...finishers, ...stayers, ...botStragglers];
  const solo = room.players.length < 2;
  const points = Array(room.players.length).fill(0);
  const placementOf: (number | null)[] = Array(room.players.length).fill(null);
  placed.forEach((slot, i) => {
    placementOf[slot] = i + 1;
    points[slot] = solo ? 0 : placementPoints(i + 1, placed.length, room.level) + room.hitBonus[slot];
  });

  const winnerSlot = finishers.length > 0 ? finishers[0] : null;
  const winnerName = winnerSlot !== null ? room.players[winnerSlot].username : null;

  const standings: Standing[] = [...placed, ...leavers].map((slot) => ({
    slot,
    username: room.players[slot].username,
    timeMs: room.times[slot],
    points: points[slot],
    placement: placementOf[slot],
  }));

  broadcast(room, { type: 'race_over', winnerSlot, winnerName, reason, standings });

  recordRaceResult({
    level: room.level,
    biome: room.biome,
    seed: room.seed,
    winnerSlot,
    status: reason,
    entries: room.players.map((p, slot) => ({
      id: p.id,
      username: p.username,
      slot,
      timeMs: room.times[slot],
      bestLapMs: room.bestLaps[slot],
      points: points[slot],
      placement: placementOf[slot],
      usage: room.usage[slot],
      bot: p.bot,
    })),
  }).catch((err) => console.error('failed to persist race result:', err));

  destroyRoom(room);
}

/** Player left mid-flow (socket close or explicit leave). */
function detach(client: GameClient): void {
  const room = client.room;
  if (!room) return;
  client.room = null;

  if (room.phase === 'waiting') {
    if (client.slot === 0) {
      // host left — the staging room dissolves
      broadcast(room, { type: 'error', message: 'The host left the race' }, client.slot);
      destroyRoom(room);
    } else {
      // compact the roster; slots shift, everyone gets a fresh lobby_update
      room.players.splice(client.slot, 1);
      room.clients.splice(client.slot, 1);
      room.clients.forEach((c, i) => { if (c) c.slot = i; });
      sendLobbyUpdate(room);
    }
    return;
  }

  room.clients[client.slot] = null;
  broadcast(room, { type: 'peer_left', slot: client.slot });

  if (room.phase === 'starting') {
    if (connectedCount(room) === 0) destroyRoom(room);
    else handleReadyCheck(room);
  } else if (room.phase === 'racing') {
    const botsRacing = room.players.some((p) => p.bot);
    if (connectedCount(room) === 0) {
      conclude(room, 'forfeit');
    } else if (connectedCount(room) === 1 && !botsRacing && room.times.every((t) => t === null)) {
      // everyone else quit before anyone finished — last kart standing wins
      // (unless bots are still racing them!)
      conclude(room, 'forfeit');
    } else {
      maybeFinishRace(room);
    }
  }
}

function handleReadyCheck(room: Room): void {
  if (room.phase !== 'starting') return;
  const allReady = room.clients.every((c, slot) => !c || room.ready[slot]);
  if (allReady) beginCountdown(room);
}

export function handleClose(client: GameClient): void {
  detach(client);
}

export function handleMessage(client: GameClient, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const room = client.room;
  switch (msg.type) {
    case 'create':
      return handleCreate(client, msg.level, msg.biome, msg.color, msg.car, msg.pet);
    case 'join':
      return handleJoin(client, msg.code, msg.color, msg.car, msg.pet);
    case 'set_bots':
      return handleSetBots(client, msg.count, msg.skill);
    case 'start':
      void handleStart(client);
      return;
    case 'ready':
      return handleReady(client);
    case 'state':
      if (room && (room.phase === 'racing' || room.phase === 'starting')) {
        broadcast(room, { type: 'peer_state', slot: client.slot, state: msg.state }, client.slot);
      }
      return;
    case 'bot_states':
      // host-simulated bot karts, fanned out to everyone else in one message
      if (room && client.slot === 0 && (room.phase === 'racing' || room.phase === 'starting')) {
        const states = Array.isArray(msg.states)
          ? msg.states.filter((s): s is { slot: number; state: KartState } => isBotSlot(room, s?.slot))
          : [];
        if (states.length > 0) broadcast(room, { type: 'peer_bot_states', states }, 0);
      }
      return;
    case 'bot_fire':
      // bots have no wallets — their bullets are free but host-only
      if (room && client.slot === 0 && room.phase === 'racing' && isBotSlot(room, msg.slot)) {
        broadcast(room, { type: 'peer_fire', slot: msg.slot, x: msg.x, y: msg.y, heading: msg.heading }, 0);
      }
      return;
    case 'bot_finish':
      return handleBotFinish(client, msg.slot, msg.timeMs);
    case 'block':
      if (room && room.phase === 'racing') {
        broadcast(room, { type: 'peer_block', slot: client.slot, blockId: msg.blockId }, client.slot);
      }
      return;
    case 'item':
      if (room && room.phase === 'racing') {
        broadcast(room, {
          type: 'peer_item', slot: client.slot, item: msg.item,
          x: msg.x, y: msg.y, targetSlot: msg.targetSlot, targetSlots: msg.targetSlots, stolen: msg.stolen,
        }, client.slot);
      }
      return;
    case 'fire':
      return handleFire(client, msg.x, msg.y, msg.heading);
    case 'place_block':
      return handlePlaceBlock(client, msg.x, msg.y);
    case 'turret':
      return handleTurret(client, msg.x, msg.y);
    case 'boom':
      return handleBoom(client);
    case 'hypno':
      return handleHypno(client);
    case 'hit':
      return handleHit(client, msg.source, msg.absorbed, msg.shooterSlot, msg.victimSlot);
    case 'finish':
      return handleFinish(client, msg.timeMs, msg.bestLapMs);
    case 'leave':
      return detach(client);
  }
}
