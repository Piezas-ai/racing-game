/** AI robot racers. The host picks how many (0–20) and a skill setting in the
 * waiting room; the server adds them to the roster as extra slots and the
 * HOST's client simulates them (same victim-authoritative model as everything
 * else — the host is the bots' authority). */

export type BotSkill = 'easy' | 'medium' | 'hard' | 'random';

export const MAX_BOTS = 20;

export const BOT_SKILLS: readonly BotSkill[] = ['easy', 'medium', 'hard', 'random'];

export const BOT_SKILL_LABELS: Record<BotSkill, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  random: 'Surprise mix',
};

export function isBotSkill(v: unknown): v is BotSkill {
  return typeof v === 'string' && (BOT_SKILLS as readonly string[]).includes(v);
}

export interface BotParams {
  /** cruising speed as a fraction of the human top speed */
  cruise: number;
  /** how hard corners scrub speed (higher = more cautious) */
  corner: number;
  /** steering noise — sloppy driving */
  wobble: number;
  /** roughly bullets-per-second urge when someone is in front */
  aggression: number;
}

/** Per-bot driving parameters. `rand` is a seeded 0..1 generator so the host
 * derives stable params per slot; 'random' rolls a fresh personality each. */
export function botParams(skill: BotSkill, rand: () => number): BotParams {
  switch (skill) {
    case 'easy':
      return { cruise: 0.52 + rand() * 0.06, corner: 0.62, wobble: 0.35, aggression: 0.04 };
    case 'medium':
      return { cruise: 0.66 + rand() * 0.06, corner: 0.5, wobble: 0.18, aggression: 0.12 };
    case 'hard':
      return { cruise: 0.8 + rand() * 0.07, corner: 0.4, wobble: 0.07, aggression: 0.25 };
    case 'random':
      return { cruise: 0.5 + rand() * 0.38, corner: 0.35 + rand() * 0.3, wobble: rand() * 0.4, aggression: rand() * 0.3 };
  }
}

export const BOT_NAMES = [
  'Robo Rex', 'Beep Boop', 'Sir Zooms', 'Crash Test', 'Turbo Toast',
  'Captain Bolt', 'Gigawatt', 'Sparky', 'Widget', 'Gizmo',
  'Pixel', 'Zappy', 'Rusty', 'Nutbolt', 'Waffle-Bot',
  'Chip', 'Blinky', 'Vroomba', 'Motor Mouth', 'Tin Lizzy',
];
