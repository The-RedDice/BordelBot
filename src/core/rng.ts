import { randomBytes } from 'node:crypto';

/** Générateur uniforme dans [0, 1). */
export type Rng = () => number;

/** 48 bits aléatoires : entier exact en double, de 0 à 2⁴⁸ − 1. */
const RANGE = 2 ** 48;

/**
 * Production : imprévisible (rôles secrets, jeux d’argent, bourse).
 * Pas `crypto.randomInt(0, 2 ** 48)` : son écart maximal est 2⁴⁸ − 1 et il lève ERR_OUT_OF_RANGE.
 */
export const cryptoRng: Rng = () => randomBytes(6).readUIntBE(0, 6) / RANGE;

/** Tests : déterministe (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: Rng, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError(`maxExclusive invalide : ${maxExclusive}`);
  return Math.floor(rng() * maxExclusive);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick() sur une liste vide');
  return items[randomInt(rng, items.length)] as T;
}

/** Fisher-Yates, renvoie une copie. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
