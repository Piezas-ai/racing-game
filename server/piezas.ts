/** Piezas glue: SDK init, idempotent entity setup, and the few durable
 * operations the game needs. All business data lives in Piezas — the game
 * server keeps only ephemeral room state in memory. */
import {
  Piezas,
  EntityClient,
  EntityRecord,
  buildJsonSchema,
  type EntityDefinition,
  type UsersClient,
} from '@piezas/sdk';
import { walletFromData, type Wallet } from '../shared/economy';

/** Tenant app id for the users service — the deploy slug from piezas.manifest.json. */
export const APP_ID = 'racing-game-7725';

let players: EntityClient | null = null;
let races: EntityClient | null = null;
let usersClient: UsersClient | null = null;

const PLAYER_FIELDS: EntityDefinition['fields'] = {
  username: { type: 'text', required: true },
  // users-service account reference — credentials live in the platform, never here
  userId: { type: 'text' },
  wins: { type: 'integer' },
  losses: { type: 'integer' },
  races: { type: 'integer' },
  bestLapMs: { type: 'integer' },
  // combat economy wallet
  points: { type: 'integer' },
  bullets: { type: 'integer' },
  blocks: { type: 'integer' },
  armorBullets: { type: 'integer' },
  armorBlocks: { type: 'integer' },
  turrets: { type: 'integer' },
  booms: { type: 'integer' },
  hypnos: { type: 'integer' },
  // garage: character color + car class
  color: { type: 'text' },
  car: { type: 'text' },
  // pet sidekicks: owned list (JSON array) + the equipped one
  pets: { type: 'longtext' },
  activePet: { type: 'text' },
};

const RACE_FIELDS: EntityDefinition['fields'] = {
  level: { type: 'integer' },
  biome: { type: 'text' },
  seed: { type: 'integer' },
  playerCount: { type: 'integer' },
  winnerId: { type: 'text' },
  winnerName: { type: 'text' },
  /** JSON array of { slot, id, username, timeMs, points, placement } */
  resultsJson: { type: 'longtext' },
  status: { type: 'select', options: ['completed', 'forfeit', 'timeout'] },
  finishedAt: { type: 'datetime' },
};

export async function setupPiezas(): Promise<void> {
  const apiKey = process.env.PIEZAS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'PIEZAS_API_KEY is missing. Run `npx piezas init --key <key>` or place the dashboard .env in the project root.',
    );
  }
  const piezas = new Piezas({
    apiKey,
    // One base points every service client (entities, users, ...) at the gateway.
    apiBaseUrl: process.env.PIEZAS_API_URL || 'https://api.piezas.ai',
  });
  usersClient = piezas.users;

  // App end-user accounts/sessions live in the platform users service.
  // Racer "emails" are synthetic (username@racers.local), so no verification
  // mail can ever arrive and MFA factors stay off.
  await piezas.users.configurePolicy(APP_ID, {
    methods: ['password'],
    sessionTtlSeconds: 7 * 24 * 3600,
    requireEmailVerification: false,
    passwordMinLength: 6,
    mfa: 'off',
  });

  const defined = await piezas.defineEntities(
    {
      player: { fields: PLAYER_FIELDS },
      race: { fields: RACE_FIELDS },
    },
    { onDrift: 'ignore' },
  );
  players = defined.player;
  races = defined.race;

  // defineEntities never migrates an existing schema, so push the current
  // field set explicitly (idempotent) — this is how the wallet fields landed.
  await piezas.entities.updateSchema(players.getEntityTypeId(), {
    jsonSchema: buildJsonSchema(PLAYER_FIELDS),
  });
  await piezas.entities.updateSchema(races.getEntityTypeId(), {
    jsonSchema: buildJsonSchema(RACE_FIELDS),
  });
}

function playersClient(): EntityClient {
  if (!players) throw new Error('Piezas not initialized');
  return players;
}
export function users(): UsersClient {
  if (!usersClient) throw new Error('Piezas not initialized');
  return usersClient;
}
function racesClient(): EntityClient {
  if (!races) throw new Error('Piezas not initialized');
  return races;
}

export async function findPlayerByUsername(username: string): Promise<EntityRecord | null> {
  const exact = (rec: EntityRecord) =>
    typeof rec.data.username === 'string' &&
    rec.data.username.toLowerCase() === username.toLowerCase();

  const listed = await playersClient().list({ filter: { username }, limit: 25 });
  const fromList = listed.data.find(exact);
  if (fromList) return fromList;

  // Defensive fallback in case data-field filtering is loose server-side.
  const searched = await playersClient().search({ q: username, limit: 25 });
  return searched.data.find(exact) ?? null;
}

export async function createPlayer(username: string): Promise<EntityRecord> {
  return playersClient().create({
    title: username,
    data: { username, wins: 0, losses: 0, races: 0 },
  });
}

export async function deletePlayer(id: string): Promise<void> {
  return playersClient().delete(id);
}

export async function getPlayer(id: string): Promise<EntityRecord> {
  return playersClient().get(id);
}

export async function updatePlayerData(
  id: string,
  data: Record<string, unknown>,
): Promise<EntityRecord> {
  // Records from before the users-service migration still carry passwordHash.
  // Updates merge data (omitting a key keeps it), so blank it explicitly to
  // drain credentials out of entity data (PZ-69).
  const clean = { ...data };
  if ('passwordHash' in clean) clean.passwordHash = '';
  return playersClient().update(id, { data: clean });
}

export async function listTopPlayers(limit = 10): Promise<EntityRecord[]> {
  // The records API caps limit at 100 — page through (bounded for sanity).
  const all: EntityRecord[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const res = await playersClient().list({ limit: 100, offset });
    all.push(...res.data);
    if (all.length >= res.total || res.data.length === 0) break;
  }
  return all
    .sort((a, b) => Number(b.data.wins ?? 0) - Number(a.data.wins ?? 0))
    .slice(0, limit);
}

/** Consumables spent and absorbed during one race, per player. */
export interface RaceUsage {
  bulletsUsed: number;
  blocksUsed: number;
  armorBulletsUsed: number;
  armorBlocksUsed: number;
  turretsUsed: number;
  boomsUsed: number;
  hypnosUsed: number;
}

export interface RaceEntry {
  id: string;
  username: string;
  slot: number;
  timeMs: number | null;
  bestLapMs: number | null;
  points: number;
  placement: number | null; // null = left the race
  usage: RaceUsage;
  /** AI robot — shows up in the results, never gets stats/wallet updates */
  bot?: boolean;
}

export interface RaceResultInput {
  level: number;
  biome: string;
  seed: number;
  winnerSlot: number | null;
  entries: RaceEntry[];
  status: 'completed' | 'forfeit' | 'timeout';
}

/** Persist a finished race and roll every racer's stats + wallet forward.
 * Bots appear in the results record but never touch player records. */
export async function recordRaceResult(input: RaceResultInput): Promise<void> {
  const winner = input.entries.find((e) => e.slot === input.winnerSlot) ?? null;
  const humans = input.entries.filter((e) => !e.bot);
  const botCount = input.entries.length - humans.length;
  const names =
    humans.map((e) => e.username).join(' vs ') + (botCount > 0 ? ` + ${botCount} bots` : '');

  await racesClient().create({
    title: `${names} — L${input.level} ${input.biome}`,
    data: {
      level: input.level,
      biome: input.biome,
      seed: input.seed,
      playerCount: input.entries.length,
      winnerId: winner && !winner.bot ? winner.id : '',
      winnerName: winner?.username ?? '',
      resultsJson: JSON.stringify(
        input.entries.map(({ id, username, slot, timeMs, points, placement, bot }) => ({
          id, username, slot, timeMs, points, placement, bot: bot || undefined,
        })),
      ),
      status: input.status,
      finishedAt: new Date().toISOString(),
    },
  });

  // Sequential read-modify-write so the same account in several slots
  // (testing in multiple tabs) doesn't clobber its own stats. Beating a
  // field of bots still counts as a win — that's half the fun.
  const competitive = input.entries.length >= 2;
  for (const entry of humans) {
    const rec = await getPlayer(entry.id);
    const won = entry.placement === 1;
    const prevBest = Number(rec.data.bestLapMs ?? 0);
    const lap = entry.bestLapMs;
    const bestLapMs = lap && lap > 0 && (prevBest === 0 || lap < prevBest) ? lap : prevBest;
    const wallet = walletFromData(rec.data);
    const use = entry.usage;
    await updatePlayerData(entry.id, {
      ...rec.data,
      wins: Number(rec.data.wins ?? 0) + (competitive && won ? 1 : 0),
      losses: Number(rec.data.losses ?? 0) + (competitive && !won ? 1 : 0),
      races: Number(rec.data.races ?? 0) + 1,
      bestLapMs,
      points: wallet.points + entry.points,
      bullets: Math.max(0, wallet.bullets - use.bulletsUsed),
      blocks: Math.max(0, wallet.blocks - use.blocksUsed),
      armorBullets: Math.max(0, wallet.armorBullets - use.armorBulletsUsed),
      armorBlocks: Math.max(0, wallet.armorBlocks - use.armorBlocksUsed),
      turrets: Math.max(0, wallet.turrets - use.turretsUsed),
      booms: Math.max(0, wallet.booms - use.boomsUsed),
      hypnos: Math.max(0, wallet.hypnos - use.hypnosUsed),
    });
  }
}

export async function getWallet(playerId: string): Promise<Wallet> {
  const rec = await getPlayer(playerId);
  return walletFromData(rec.data);
}
