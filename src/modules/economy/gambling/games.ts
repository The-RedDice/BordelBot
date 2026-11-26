import { randomInt, type Rng } from '../../../core/rng.js';

// ---------- Pile ou face ----------

export type CoinSide = 'pile' | 'face';

export function flipCoin(rng: Rng): CoinSide {
  return rng() < 0.5 ? 'pile' : 'face';
}

/** Gain total (mise comprise) : quitte ou double, sans avantage pour la banque. */
export const COIN_MULTIPLIER = 2;

// ---------- Machine à sous ----------

export interface SlotSymbol {
  readonly emoji: string;
  /** Fréquence relative sur chaque rouleau. */
  readonly weight: number;
  /** Multiplicateur pour trois symboles identiques. */
  readonly three: number;
  /** Multiplicateur pour exactement deux symboles identiques (0 = rien). */
  readonly two: number;
}

/**
 * Taux de redistribution théorique ≈ 95 % (vérifié par les tests) : la banque garde
 * en moyenne 5 % des mises, ce qui retire un peu d'argent de l'économie.
 */
export const SLOT_SYMBOLS: readonly SlotSymbol[] = [
  { emoji: '🍒', weight: 6, three: 8, two: 0 },
  { emoji: '🍋', weight: 5, three: 10, two: 0 },
  { emoji: '🔔', weight: 4, three: 15, two: 2 },
  { emoji: '🍀', weight: 3, three: 25, two: 2 },
  { emoji: '⭐', weight: 2, three: 50, two: 3 },
  { emoji: '💎', weight: 1, three: 200, two: 5 },
];

const TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

export interface SlotSpin {
  readonly reels: readonly [SlotSymbol, SlotSymbol, SlotSymbol];
  /** Gain total = mise × multiplicateur (0 = perdu). */
  readonly multiplier: number;
}

function spinReel(rng: Rng): SlotSymbol {
  let roll = randomInt(rng, TOTAL_WEIGHT);
  for (const s of SLOT_SYMBOLS) {
    if (roll < s.weight) return s;
    roll -= s.weight;
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1] as SlotSymbol;
}

export function slotMultiplier(reels: readonly SlotSymbol[]): number {
  const [a, b, c] = reels;
  if (a === b && b === c && a) return a.three;
  const pair = a === b || a === c ? a : b === c ? b : undefined;
  return pair?.two ?? 0;
}

export function spinSlots(rng: Rng): SlotSpin {
  const reels = [spinReel(rng), spinReel(rng), spinReel(rng)] as const;
  return { reels, multiplier: slotMultiplier(reels) };
}

/** Espérance de gain par unité misée (taux de redistribution), calculée exactement. */
export function slotsReturnToPlayer(): number {
  let expected = 0;
  for (const a of SLOT_SYMBOLS) {
    for (const b of SLOT_SYMBOLS) {
      for (const c of SLOT_SYMBOLS) {
        const p = (a.weight * b.weight * c.weight) / TOTAL_WEIGHT ** 3;
        expected += p * slotMultiplier([a, b, c]);
      }
    }
  }
  return expected;
}
