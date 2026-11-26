import { randomInt, type Rng } from '../../../core/rng.js';

/** Roulette européenne : 0 à 36, un seul zéro (la banque garde 1/37 des mises en moyenne). */
export const ROULETTE_NUMBERS = 37;

export const RED_NUMBERS: ReadonlySet<number> = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export type SimpleBet = 'rouge' | 'noir' | 'pair' | 'impair' | 'manque' | 'passe';

export type RouletteBet =
  | { readonly kind: SimpleBet }
  | { readonly kind: 'douzaine'; readonly n: 1 | 2 | 3 }
  | { readonly kind: 'numero'; readonly n: number };

/** Valeurs de l'option `pari` de la commande. */
export const BET_CHOICES = [
  { name: 'Rouge (×2)', value: 'rouge' },
  { name: 'Noir (×2)', value: 'noir' },
  { name: 'Pair (×2)', value: 'pair' },
  { name: 'Impair (×2)', value: 'impair' },
  { name: 'Manque : 1 à 18 (×2)', value: 'manque' },
  { name: 'Passe : 19 à 36 (×2)', value: 'passe' },
  { name: '1re douzaine : 1 à 12 (×3)', value: 'd1' },
  { name: '2e douzaine : 13 à 24 (×3)', value: 'd2' },
  { name: '3e douzaine : 25 à 36 (×3)', value: 'd3' },
  { name: 'Numéro plein (×36)', value: 'numero' },
] as const;

export type BetChoice = (typeof BET_CHOICES)[number]['value'];

/** Pari à partir des options de la commande ; null si un numéro manque ou est invalide. */
export function parseBet(choice: string, numero: number | null): RouletteBet | null {
  switch (choice) {
    case 'rouge':
    case 'noir':
    case 'pair':
    case 'impair':
    case 'manque':
    case 'passe':
      return { kind: choice };
    case 'd1':
    case 'd2':
    case 'd3':
      return { kind: 'douzaine', n: Number(choice[1]) as 1 | 2 | 3 };
    case 'numero':
      return numero !== null && Number.isInteger(numero) && numero >= 0 && numero < ROULETTE_NUMBERS
        ? { kind: 'numero', n: numero }
        : null;
    default:
      return null;
  }
}

export function spinRoulette(rng: Rng): number {
  return randomInt(rng, ROULETTE_NUMBERS);
}

/** Multiplicateur du gain total (mise comprise) ; 0 si perdu. Le zéro fait perdre les paris simples. */
export function rouletteMultiplier(bet: RouletteBet, result: number): number {
  if (bet.kind === 'numero') return bet.n === result ? 36 : 0;
  if (result === 0) return 0;
  switch (bet.kind) {
    case 'rouge':
      return RED_NUMBERS.has(result) ? 2 : 0;
    case 'noir':
      return RED_NUMBERS.has(result) ? 0 : 2;
    case 'pair':
      return result % 2 === 0 ? 2 : 0;
    case 'impair':
      return result % 2 === 1 ? 2 : 0;
    case 'manque':
      return result <= 18 ? 2 : 0;
    case 'passe':
      return result >= 19 ? 2 : 0;
    case 'douzaine':
      return Math.ceil(result / 12) === bet.n ? 3 : 0;
  }
}

export function colorEmoji(n: number): string {
  return n === 0 ? '🟢' : RED_NUMBERS.has(n) ? '🔴' : '⚫';
}

export function describeBet(bet: RouletteBet): string {
  switch (bet.kind) {
    case 'numero':
      return `n° ${bet.n}`;
    case 'douzaine':
      return `${bet.n === 1 ? '1re' : `${bet.n}e`} douzaine`;
    default:
      return bet.kind;
  }
}
