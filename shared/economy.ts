/** Combat economy: shared between server (authoritative) and client (display).
 * Points are banked to the Piezas player record after every race. */

export interface Wallet {
  points: number;
  bullets: number;
  blocks: number;
  armorBullets: number;
  armorBlocks: number;
  turrets: number;
  booms: number;
  hypnos: number;
}

export const STARTER: Wallet = {
  points: 0,
  bullets: 30,
  blocks: 10,
  armorBullets: 0,
  armorBlocks: 0,
  turrets: 0,
  booms: 0,
  hypnos: 0,
};

export const PRICES = {
  bullet: 5,
  block: 8,
  armorBullet: 15,
  armorBlock: 15,
  turret: 300, // auto-shoots rivals for you
  boom: 400, // sends everyone else back to the start; ONE per race, total
  hypno: 2000, // everyone else drives like you for 6s; once per race per player
} as const;

export type ShopItem = keyof typeof PRICES;

export const CAPS = {
  bullets: 200,
  blocks: 100, // hard limit: no player may own more than 100 road blocks
  armorBullets: 20,
  armorBlocks: 20,
  turrets: 10,
  booms: 3,
  hypnos: 2,
} as const;

export const HIT_BONUS = 5;
export const HIT_BONUS_CAP = 50;

/** Points by finishing position. 1st gets the win rate (80 + 20×level), last
 * gets the participation rate (20 + 5×level), places between are on a linear
 * scale. `field` is how many racers are being placed (min 2 for the curve —
 * a lone survivor of a mass-quit still gets 1st-place points). Solo races
 * (started with one player) earn nothing — pass field = 1. */
export function placementPoints(placement: number, field: number, level: number): number {
  if (field <= 1) return 0;
  const win = 80 + 20 * level;
  const loss = 20 + 5 * level;
  const n = Math.max(field, 2);
  return Math.round(loss + ((win - loss) * (n - placement)) / (n - 1));
}

export function walletFromData(data: Record<string, unknown>): Wallet {
  const n = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    points: n(data.points, STARTER.points),
    bullets: n(data.bullets, STARTER.bullets),
    blocks: n(data.blocks, STARTER.blocks),
    armorBullets: n(data.armorBullets, STARTER.armorBullets),
    armorBlocks: n(data.armorBlocks, STARTER.armorBlocks),
    turrets: n(data.turrets, STARTER.turrets),
    booms: n(data.booms, STARTER.booms),
    hypnos: n(data.hypnos, STARTER.hypnos),
  };
}

const ITEM_TO_FIELD: Record<ShopItem, keyof Wallet> = {
  bullet: 'bullets',
  block: 'blocks',
  armorBullet: 'armorBullets',
  armorBlock: 'armorBlocks',
  turret: 'turrets',
  boom: 'booms',
  hypno: 'hypnos',
};

/** Validate a purchase against points and caps. Returns the new wallet or an error string. */
export function applyPurchase(wallet: Wallet, item: ShopItem, qty: number): Wallet | string {
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) return 'Quantity must be 1-100';
  const cost = PRICES[item] * qty;
  if (wallet.points < cost) return `Not enough points (need ${cost}, have ${wallet.points})`;
  const field = ITEM_TO_FIELD[item];
  const cap = CAPS[field as keyof typeof CAPS];
  if (wallet[field] + qty > cap) return `That would exceed the ${cap} ${String(field)} limit`;
  return { ...wallet, points: wallet.points - cost, [field]: wallet[field] + qty };
}
