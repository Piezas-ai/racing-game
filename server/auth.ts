/** App auth over the Piezas users service. Racers sign in with a username;
 * the users service is email-keyed, so usernames map to synthetic non-routable
 * emails (username@racers.local) and the real username rides in the account
 * profile. Game data (stats, wallet, garage) stays on the player entity
 * record — the platform owns credentials and sessions. */
import { Router, type Request, type Response } from 'express';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import {
  APP_ID,
  createPlayer,
  deletePlayer,
  findPlayerByUsername,
  getPlayer,
  listTopPlayers,
  updatePlayerData,
  users,
} from './piezas';
import { applyPurchase, walletFromData, PRICES, type ShopItem } from '../shared/economy';
import { DEFAULT_CAR, isCarKind, isPlayerColor, PLAYER_COLORS } from '../shared/cars';
import { isPetKind, PETS, type PetKind } from '../shared/pets';
import {
  clearSessionCookie,
  invalidateSessionToken,
  sessionCookie,
  tokenFromCookieHeader,
  verifySessionToken,
  type SessionUser,
} from './session';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

/** Deterministic, non-routable email for a username (the users service key). */
function synthEmail(username: string): string {
  return `${username.toLowerCase()}@racers.local`;
}

/** Verify a pre-migration scrypt salt:hash — only used to lazily migrate. */
function verifyLegacyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Session user from the cookie; re-sets the cookie on a sliding refresh. */
export async function requestUser(req: Request, res?: Response): Promise<SessionUser | null> {
  const token = tokenFromCookieHeader(req.headers.cookie);
  if (!token) return null;
  const verified = await verifySessionToken(token);
  if (!verified) return null;
  if (verified.refreshedToken && res) {
    res.setHeader('Set-Cookie', sessionCookie(verified.refreshedToken));
  }
  return verified.user;
}

function publicStats(data: Record<string, unknown>) {
  return {
    wins: Number(data.wins ?? 0),
    losses: Number(data.losses ?? 0),
    races: Number(data.races ?? 0),
    bestLapMs: Number(data.bestLapMs ?? 0) || null,
  };
}

function petsFromData(data: Record<string, unknown>): PetKind[] {
  try {
    const arr = JSON.parse(String(data.pets ?? '[]'));
    return Array.isArray(arr) ? arr.filter(isPetKind) : [];
  } catch {
    return [];
  }
}

function userPayload(id: string, username: string, data: Record<string, unknown>) {
  const pets = petsFromData(data);
  return {
    id,
    username,
    stats: publicStats(data),
    wallet: walletFromData(data),
    color: isPlayerColor(data.color) ? data.color : PLAYER_COLORS[0],
    car: isCarKind(data.car) ? data.car : DEFAULT_CAR,
    pets,
    activePet: isPetKind(data.activePet) && pets.includes(data.activePet) ? data.activePet : null,
  };
}

/** Password sign-in against the users service; null means bad credentials.
 * (Policy has MFA off — a challenge can never come back for this app.) */
async function signInUsers(username: string, password: string) {
  try {
    const result = await users().signIn(APP_ID, { email: synthEmail(username), password });
    return result.session && result.user ? { session: result.session, user: result.user } : null;
  } catch {
    return null;
  }
}

export const authRouter = Router();

authRouter.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-16 letters, numbers, or _' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (await findPlayerByUsername(username)) {
      return res.status(409).json({ error: 'That username is taken' });
    }

    // Record first so its id can ride in the account profile (sign-up is the
    // only moment the users service accepts profile data).
    const rec = await createPlayer(username);
    await users().signUp(APP_ID, {
      email: synthEmail(username),
      password,
      profile: { username, playerId: rec.id },
    });
    // Duplicate sign-ups return a decoy user (anti-enumeration), so the only
    // proof the account is really ours is signing in with it.
    const signedIn = await signInUsers(username, password);
    if (!signedIn) {
      await deletePlayer(rec.id).catch(() => undefined);
      return res.status(409).json({ error: 'That username is taken' });
    }
    const updated = await updatePlayerData(rec.id, { ...rec.data, userId: signedIn.user.id });
    res.setHeader('Set-Cookie', sessionCookie(signedIn.session.token));
    res.json(userPayload(updated.id, username, updated.data));
  } catch (err) {
    console.error('register failed:', err);
    res.status(500).json({ error: 'Registration failed, try again' });
  }
});

authRouter.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password required' });
    }

    let signedIn = await signInUsers(username, password);
    if (!signedIn) {
      // Lazy migration: accounts from before the users service keep a scrypt
      // hash on the player record. Verify it once, import the account with the
      // plaintext in hand (the service re-hashes), then drain the old hash.
      const rec = await findPlayerByUsername(username);
      const legacyHash = String(rec?.data.passwordHash ?? '');
      if (!rec || !legacyHash || !verifyLegacyPassword(password, legacyHash)) {
        return res.status(401).json({ error: 'Wrong username or password' });
      }
      const name = String(rec.data.username);
      const imported = await users().importUsers(APP_ID, [
        { email: synthEmail(name), password, profile: { username: name, playerId: rec.id } },
      ]);
      if (imported.results[0]?.error) {
        console.error('lazy user import failed:', imported.results[0]);
        return res.status(500).json({ error: 'Login failed, try again' });
      }
      signedIn = await signInUsers(name, password);
      if (!signedIn) return res.status(500).json({ error: 'Login failed, try again' });
      await updatePlayerData(rec.id, { ...rec.data, userId: signedIn.user.id });
    }

    const playerId = signedIn.user.profile.playerId;
    if (typeof playerId !== 'string') {
      return res.status(500).json({ error: 'Login failed, try again' });
    }
    const rec = await getPlayer(playerId);
    res.setHeader('Set-Cookie', sessionCookie(signedIn.session.token));
    res.json(userPayload(rec.id, String(rec.data.username), rec.data));
  } catch (err) {
    console.error('login failed:', err);
    res.status(500).json({ error: 'Login failed, try again' });
  }
});

authRouter.post('/api/logout', async (req, res) => {
  const token = tokenFromCookieHeader(req.headers.cookie);
  if (token) {
    invalidateSessionToken(token);
    await users().signOut(APP_ID, token).catch(() => undefined);
  }
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

authRouter.get('/api/me', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  try {
    const rec = await getPlayer(user.playerId);
    res.json(userPayload(rec.id, user.username, rec.data));
  } catch {
    // Record gone (e.g. wiped tenant) — treat as signed out.
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.status(401).json({ error: 'Not signed in' });
  }
});

authRouter.post('/api/profile', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  try {
    const { color, car, activePet } = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (color !== undefined) {
      if (!isPlayerColor(color)) return res.status(400).json({ error: 'Pick a color from the palette' });
      patch.color = color;
    }
    if (car !== undefined) {
      if (!isCarKind(car)) return res.status(400).json({ error: 'Unknown car' });
      patch.car = car;
    }
    const rec = await getPlayer(user.playerId);
    if (activePet !== undefined) {
      if (activePet === null || activePet === '') {
        patch.activePet = '';
      } else if (!isPetKind(activePet) || !petsFromData(rec.data).includes(activePet)) {
        return res.status(400).json({ error: 'You don’t own that pet yet' });
      } else {
        patch.activePet = activePet;
      }
    }
    const updated = await updatePlayerData(user.playerId, { ...rec.data, ...patch });
    res.json(userPayload(updated.id, user.username, updated.data));
  } catch (err) {
    console.error('profile update failed:', err);
    res.status(500).json({ error: 'Could not save, try again' });
  }
});

authRouter.post('/api/shop/buy', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  try {
    const { item, qty } = req.body ?? {};
    if (typeof item !== 'string' || !(item in PRICES)) {
      return res.status(400).json({ error: 'Unknown shop item' });
    }
    const rec = await getPlayer(user.playerId);
    const result = applyPurchase(walletFromData(rec.data), item as ShopItem, Number(qty ?? 1));
    if (typeof result === 'string') return res.status(400).json({ error: result });
    const updated = await updatePlayerData(user.playerId, { ...rec.data, ...result });
    res.json(userPayload(updated.id, user.username, updated.data));
  } catch (err) {
    console.error('shop buy failed:', err);
    res.status(500).json({ error: 'Purchase failed, try again' });
  }
});

/** Pets are one-time purchases: pay once, own forever, equip in the garage. */
authRouter.post('/api/shop/pet', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  try {
    const { pet } = req.body ?? {};
    if (!isPetKind(pet)) return res.status(400).json({ error: 'Unknown pet' });
    const rec = await getPlayer(user.playerId);
    const wallet = walletFromData(rec.data);
    const pets = petsFromData(rec.data);
    if (pets.includes(pet)) return res.status(400).json({ error: 'You already own that pet' });
    const price = PETS[pet].price;
    if (wallet.points < price) {
      return res.status(400).json({ error: `Not enough points (need ${price}, have ${wallet.points})` });
    }
    const hasActive = isPetKind(rec.data.activePet) && pets.includes(rec.data.activePet);
    const updated = await updatePlayerData(user.playerId, {
      ...rec.data,
      points: wallet.points - price,
      pets: JSON.stringify([...pets, pet]),
      // a freshly bought first pet hops straight into the kart
      activePet: hasActive ? rec.data.activePet : pet,
    });
    res.json(userPayload(updated.id, user.username, updated.data));
  } catch (err) {
    console.error('pet buy failed:', err);
    res.status(500).json({ error: 'Purchase failed, try again' });
  }
});

authRouter.get('/api/leaderboard', async (_req, res) => {
  try {
    const top = await listTopPlayers(10);
    res.json({
      players: top.map((rec) => ({
        username: String(rec.data.username ?? rec.title),
        ...publicStats(rec.data),
      })),
    });
  } catch (err) {
    console.error('leaderboard failed:', err);
    res.status(500).json({ error: 'Could not load leaderboard' });
  }
});
