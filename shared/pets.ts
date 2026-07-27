/** Pet sidekicks: one-time shop purchases stored on the Piezas player record
 * (`pets` = owned list, `activePet` = equipped). Each pet gives a passive
 * ability; the equipped pet rides along visibly next to the kart. */

export type PetKind = 'zoomie' | 'tank' | 'magnet';

export interface PetSpec {
  label: string;
  emoji: string;
  desc: string;
  price: number;
}

export const PETS: Record<PetKind, PetSpec> = {
  zoomie: {
    label: 'Zoomie the Pup', emoji: '🐶',
    desc: 'Faster: +5% top speed and acceleration', price: 500,
  },
  tank: {
    label: 'Tank the Turtle', emoji: '🐢',
    desc: 'Stronger: recover 35% faster from oil, blocks and bullets', price: 500,
  },
  magnet: {
    label: 'Magnet Cat', emoji: '🐱',
    desc: 'Grabs lucky blocks from farther away', price: 350,
  },
};

export const PET_LIST = Object.keys(PETS) as PetKind[];

export function isPetKind(v: unknown): v is PetKind {
  return typeof v === 'string' && v in PETS;
}
