/** Thin fetch helpers for the server's auth/shop/profile/leaderboard API. */
import type { ShopItem, Wallet } from '../../shared/economy';
import type { CarKind } from '../../shared/cars';
import type { PetKind } from '../../shared/pets';

export interface PlayerStats {
  wins: number;
  losses: number;
  races: number;
  bestLapMs: number | null;
}

export interface User {
  id: string;
  username: string;
  stats: PlayerStats;
  wallet: Wallet;
  color: string;
  car: CarKind;
  pets: PetKind[];
  activePet: PetKind | null;
}

export interface LeaderboardRow extends PlayerStats {
  username: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  me: () => req<User>('/api/me'),
  register: (username: string, password: string) =>
    req<User>('/api/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    req<User>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req<{ ok: boolean }>('/api/logout', { method: 'POST' }),
  leaderboard: () => req<{ players: LeaderboardRow[] }>('/api/leaderboard'),
  buy: (item: ShopItem, qty: number) =>
    req<User>('/api/shop/buy', { method: 'POST', body: JSON.stringify({ item, qty }) }),
  buyPet: (pet: PetKind) =>
    req<User>('/api/shop/pet', { method: 'POST', body: JSON.stringify({ pet }) }),
  profile: (patch: { color?: string; car?: CarKind; activePet?: PetKind | null }) =>
    req<User>('/api/profile', { method: 'POST', body: JSON.stringify(patch) }),
};

export function formatMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
