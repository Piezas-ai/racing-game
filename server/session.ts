/** Session glue over the Piezas users service. The httpOnly cookie carries the
 * platform-issued ES256 session token; verification goes through
 * users.getSession with a short in-memory cache so ordinary API traffic and
 * WebSocket upgrades don't pay a network round-trip each time. */
import { users, APP_ID } from './piezas';

const COOKIE_NAME = 'pk_session';
/** Mirrors the sessionTtlSeconds configured in setupPiezas. */
const TTL_S = 7 * 24 * 60 * 60;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

export interface SessionUser {
  playerId: string;
  username: string;
  userId: string;
}

export interface VerifiedSession {
  user: SessionUser;
  /** Present when the service sliding-refreshed the token — re-set the cookie. */
  refreshedToken?: string;
}

const cache = new Map<string, { session: VerifiedSession; until: number }>();

export async function verifySessionToken(token: string): Promise<VerifiedSession | null> {
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.session;
  try {
    const res = await users().getSession(APP_ID, token);
    // username + playerId ride in the account profile (set at sign-up/import),
    // so a verify never needs an extra entity lookup.
    const username = res.user?.profile?.username;
    const playerId = res.user?.profile?.playerId;
    if (!res.valid || !res.user || typeof username !== 'string' || typeof playerId !== 'string') {
      return null;
    }
    const session: VerifiedSession = {
      user: { playerId, username, userId: res.user.id },
      refreshedToken: res.refreshedToken,
    };
    if (cache.size >= CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
      if (cache.size >= CACHE_MAX) cache.clear();
    }
    cache.set(token, { session, until: Date.now() + CACHE_TTL_MS });
    if (res.refreshedToken) {
      cache.set(res.refreshedToken, {
        session: { user: session.user },
        until: Date.now() + CACHE_TTL_MS,
      });
    }
    return session;
  } catch {
    return null;
  }
}

/** Forget a token locally (the platform revocation is users.signOut). */
export function invalidateSessionToken(token: string): void {
  cache.delete(token);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function tokenFromCookieHeader(header: string | undefined): string | null {
  return parseCookies(header)[COOKIE_NAME] || null;
}

export async function sessionFromCookieHeader(
  header: string | undefined,
): Promise<VerifiedSession | null> {
  const token = tokenFromCookieHeader(header);
  return token ? verifySessionToken(token) : null;
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_S}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
