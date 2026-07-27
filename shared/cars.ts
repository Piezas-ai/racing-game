/** Car classes (each with a passive special ability) and the character color
 * palette. Both are cosmetic + physics data shared by client and server. */

export type CarKind = 'blaze' | 'boulder' | 'drift' | 'lucky';
export const DEFAULT_CAR: CarKind = 'blaze';

export interface CarSpec {
  label: string;
  emoji: string;
  desc: string;
  maxSpeedMult: number;
  accelMult: number;
  steerMult: number;
  gripMult: number;
  /** multiplies spin/scare/slow durations — lower recovers faster */
  hitRecoveryMult: number;
  /** starts every race already holding a random item */
  startsWithItem: boolean;
}

export const CARS: Record<CarKind, CarSpec> = {
  blaze: {
    label: 'Blaze', emoji: '🏎️', desc: '+8% top speed',
    maxSpeedMult: 1.08, accelMult: 1.05, steerMult: 1.0, gripMult: 1.0,
    hitRecoveryMult: 1.0, startsWithItem: false,
  },
  boulder: {
    label: 'Boulder', emoji: '🚜', desc: 'Shrugs off hits 40% faster',
    maxSpeedMult: 0.97, accelMult: 1.0, steerMult: 0.95, gripMult: 1.05,
    hitRecoveryMult: 0.6, startsWithItem: false,
  },
  drift: {
    label: 'Drift King', emoji: '🏁', desc: 'Razor steering, grips on ice',
    maxSpeedMult: 1.0, accelMult: 1.0, steerMult: 1.25, gripMult: 1.35,
    hitRecoveryMult: 1.0, startsWithItem: false,
  },
  lucky: {
    label: 'Lucky Bug', emoji: '🐞', desc: 'Starts every race holding an item',
    maxSpeedMult: 1.0, accelMult: 1.0, steerMult: 1.05, gripMult: 1.0,
    hitRecoveryMult: 0.9, startsWithItem: true,
  },
};

export const CAR_LIST = Object.keys(CARS) as CarKind[];

export function isCarKind(v: unknown): v is CarKind {
  return typeof v === 'string' && v in CARS;
}

/** Character colors players can pick in the garage. */
export const PLAYER_COLORS = [
  '#ff5252', '#3da9fc', '#ffd23e', '#7bd88f', '#c792ea', '#ff9f43',
  '#4dd0e1', '#f06292', '#8d6e63', '#aeea00', '#ff6e40', '#eeeeee',
];

export function isPlayerColor(v: unknown): v is string {
  return typeof v === 'string' && PLAYER_COLORS.includes(v);
}

/** Fallback color when a player never picked one: stable per slot. */
export function colorForSlot(slot: number): string {
  return PLAYER_COLORS[slot % PLAYER_COLORS.length];
}
