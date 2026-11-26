/** Multiplicateur maximal accordé à un camp minoritaire. */
export const MAX_REWARD_MULTIPLIER = 3;

/**
 * Récompense par gagnant. Un camp minoritaire qui gagne est mieux payé :
 * la taupe seule contre 4 agents touche base × 3 (plafonné), alors que
 * 4 agents qui battent la taupe touchent chacun la base.
 * multiplicateur = clamp(perdants / gagnants, 1, MAX_REWARD_MULTIPLIER)
 */
export function computeGameReward(base: number, winners: number, losers: number): number {
  if (base <= 0 || winners <= 0) return 0;
  const multiplier = Math.min(MAX_REWARD_MULTIPLIER, Math.max(1, losers / winners));
  return Math.round(base * multiplier);
}
