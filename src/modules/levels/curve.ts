/**
 * Courbe d'XP : passer du niveau L au niveau L+1 coûte 5L² + 50L + 100 XP
 * (100 pour le niveau 1, 155 pour le 2, ~1 000 vers le niveau 10). Avec les gains
 * par défaut (15 à 25 XP par minute active), le niveau 10 demande environ 4 h de
 * discussion et le niveau 30 une centaine d'heures.
 */
export const MAX_XP = 1_000_000_000;

export function xpToNextLevel(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** XP total nécessaire pour atteindre `level` depuis zéro. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNextLevel(l);
  return total;
}

export interface LevelInfo {
  readonly level: number;
  /** XP accumulé dans le niveau en cours. */
  readonly into: number;
  /** XP à accumuler dans ce niveau pour passer au suivant. */
  readonly needed: number;
}

export function levelInfo(xp: number): LevelInfo {
  let level = 0;
  let rest = Math.max(0, Math.floor(xp));
  while (rest >= xpToNextLevel(level)) {
    rest -= xpToNextLevel(level);
    level++;
  }
  return { level, into: rest, needed: xpToNextLevel(level) };
}

export const levelOf = (xp: number): number => levelInfo(xp).level;

/** « ▰▰▰▰▱▱▱▱▱▱ » : barre de progression textuelle. */
export function progressBar(fraction: number, width = 12): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
