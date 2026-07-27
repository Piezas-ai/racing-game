/** WebSocket message protocol between game client and server.
 * A race room holds up to MAX_PLAYERS racers (plus up to MAX_BOTS AI robots
 * simulated by the host's client); each gets a stable slot index once the
 * host starts the race. */
import type { Biome } from './track';
import type { Wallet } from './economy';
import type { CarKind } from './cars';
import type { PetKind } from './pets';
import type { BotSkill } from './bots';

export const MAX_PLAYERS = 10;
export const RACE_LAPS = 3;
export const STATE_HZ = 20;

export type ItemKind =
  | 'jumpscare' | 'boost' | 'oil' | 'lightning' | 'steal' | 'sword' | 'shield'
  | 'dj' | 'scare2' | 'rocket';

export type HitSource = 'bullet' | 'block' | 'sword' | 'turret' | 'rocket';

export interface PlayerInfo {
  id: string;
  username: string;
  color: string; // hex from PLAYER_COLORS
  car: CarKind;
  pet?: PetKind | null; // equipped pet sidekick (cosmetic + passive ability)
  bot?: boolean; // AI racer simulated by the host's client
  botSkill?: BotSkill;
}

/** Kart state broadcast ~20 Hz. Positions are world coordinates. */
export interface KartState {
  x: number;
  y: number;
  heading: number;
  speed: number;
  lap: number;
  progress: number; // 0..1 along track centerline
  item: ItemKind | null;
  effect: string | null; // active effect for remote visuals (spin/scare/shrink/boost/dj)
}

export interface Standing {
  slot: number;
  username: string;
  timeMs: number | null; // null = did not finish
  points: number;
  placement: number | null; // null = left the race
}

export type ClientMessage =
  | { type: 'create'; level: number; biome: Biome | 'random'; color?: string; car?: CarKind; pet?: PetKind | null }
  | { type: 'join'; code: string; color?: string; car?: CarKind; pet?: PetKind | null }
  | { type: 'set_bots'; count: number; skill: BotSkill } // host only, waiting room
  | { type: 'start' } // host only: begin the race with everyone in the room
  | { type: 'ready' }
  | { type: 'state'; state: KartState }
  | { type: 'block'; blockId: number } // I picked up lucky block N (for respawn sync)
  // used an item; steal carries who was robbed and what was taken; dj/rocket
  // carry the random victim, scare2 carries its two victims
  | { type: 'item'; item: ItemKind; x?: number; y?: number; targetSlot?: number; targetSlots?: number[]; stolen?: ItemKind }
  | { type: 'fire'; x: number; y: number; heading: number } // shot a bullet (F)
  | { type: 'place_block'; x: number; y: number } // dropped a road block (B)
  | { type: 'turret'; x: number; y: number } // placed an auto-turret (T)
  | { type: 'boom' } // BOOM! everyone else back to the start (X, once per race)
  | { type: 'hypno' } // everyone else drives like me for 6s (H, once per race each)
  // I got hit (or my armor absorbed it); shooterSlot credits the attacker.
  // The host reports bot hits with victimSlot set to the bot's slot.
  | { type: 'hit'; source: HitSource; absorbed: boolean; shooterSlot: number; victimSlot?: number }
  | { type: 'finish'; timeMs: number; bestLapMs: number }
  // host only: batched bot kart states / a bot fired / a bot crossed the line
  | { type: 'bot_states'; states: { slot: number; state: KartState }[] }
  | { type: 'bot_fire'; slot: number; x: number; y: number; heading: number }
  | { type: 'bot_finish'; slot: number; timeMs: number }
  | { type: 'leave' };

export type ServerMessage =
  | { type: 'created'; code: string }
  | { type: 'error'; message: string }
  // staging room roster; host is slot 0 and presses Start
  | { type: 'lobby_update'; code: string; players: PlayerInfo[]; yourSlot: number; bots: { count: number; skill: BotSkill } }
  | {
      type: 'race_config';
      raceId: string;
      code: string;
      seed: number;
      level: number;
      biome: Biome;
      players: PlayerInfo[]; // slot-indexed; AI robots come after the humans
      yourSlot: number;
      loadout: Wallet; // your bullets/blocks/armor for this race
    }
  | { type: 'countdown'; value: number } // 3, 2, 1, 0 = GO
  | { type: 'peer_state'; slot: number; state: KartState }
  | { type: 'peer_bot_states'; states: { slot: number; state: KartState }[] }
  | { type: 'peer_block'; slot: number; blockId: number }
  | { type: 'peer_item'; slot: number; item: ItemKind; x?: number; y?: number; targetSlot?: number; targetSlots?: number[]; stolen?: ItemKind }
  | { type: 'peer_fire'; slot: number; x: number; y: number; heading: number }
  | { type: 'peer_place_block'; slot: number; x: number; y: number }
  | { type: 'peer_turret'; slot: number; x: number; y: number }
  | { type: 'peer_boom'; slot: number } // you (and everyone else) got sent back to start
  | { type: 'peer_hypno'; slot: number } // you are hypnotized by that racer for 6s
  // authoritative consumable counts after each use/denial
  | { type: 'ammo'; bullets: number; blocks: number; turrets: number; booms: number; hypnos: number }
  | { type: 'peer_finished'; slot: number; timeMs: number }
  | { type: 'peer_left'; slot: number }
  | {
      type: 'race_over';
      winnerSlot: number | null;
      winnerName: string | null;
      reason: 'completed' | 'forfeit' | 'timeout';
      standings: Standing[]; // sorted: placed racers first, then leavers
    };
