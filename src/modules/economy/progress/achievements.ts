/** Compteurs suivis par membre et par serveur (table user_stats). */
export type StatKey =
  | 'games_played'
  | 'games_won'
  | 'daily_best_streak'
  | 'transferred_total'
  | 'wagered_total'
  | 'gambles_won'
  | 'biggest_win'
  | 'best_multiplier'
  | 'duels_won'
  | 'market_trades'
  | 'market_profit_total';

export interface AchievementDef {
  readonly key: string;
  readonly emoji: string;
  readonly name: string;
  readonly description: string;
  readonly stat: StatKey;
  /** Débloqué quand la statistique atteint ce seuil. */
  readonly threshold: number;
  /** Versé une seule fois, au déblocage. */
  readonly reward: number;
}

/** Ordre d'affichage de `/succes`. Une clé ne doit jamais être renommée (elle est stockée). */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { key: 'premiere-victoire', emoji: '🏆', name: 'Première victoire', description: 'Gagner une partie', stat: 'games_won', threshold: 1, reward: 50 },
  { key: 'habitue', emoji: '🎲', name: 'Habitué', description: 'Jouer 25 parties', stat: 'games_played', threshold: 25, reward: 250 },
  { key: 'champion', emoji: '👑', name: 'Champion', description: 'Gagner 25 parties', stat: 'games_won', threshold: 25, reward: 500 },
  { key: 'regulier', emoji: '📅', name: 'Régulier', description: 'Atteindre une série de 7 daily', stat: 'daily_best_streak', threshold: 7, reward: 200 },
  { key: 'inebranlable', emoji: '🔥', name: 'Inébranlable', description: 'Atteindre une série de 30 daily', stat: 'daily_best_streak', threshold: 30, reward: 1_000 },
  { key: 'genereux', emoji: '🤝', name: 'Généreux', description: 'Donner 1 000 au total à d’autres membres', stat: 'transferred_total', threshold: 1_000, reward: 100 },
  { key: 'flambeur', emoji: '🎰', name: 'Flambeur', description: 'Miser 10 000 au total aux jeux d’argent', stat: 'wagered_total', threshold: 10_000, reward: 250 },
  { key: 'jackpot', emoji: '💎', name: 'Jackpot', description: 'Remporter 20 fois sa mise d’un coup', stat: 'best_multiplier', threshold: 20, reward: 500 },
  { key: 'duelliste', emoji: '⚔️', name: 'Duelliste', description: 'Gagner 5 duels', stat: 'duels_won', threshold: 5, reward: 200 },
  { key: 'investisseur', emoji: '📈', name: 'Investisseur', description: 'Passer un premier ordre en bourse', stat: 'market_trades', threshold: 1, reward: 50 },
  { key: 'loup-de-wall-street', emoji: '🐺', name: 'Loup de Wall Street', description: 'Cumuler 5 000 de plus-values en bourse', stat: 'market_profit_total', threshold: 5_000, reward: 1_000 },
];

export const ACHIEVEMENTS_BY_KEY: ReadonlyMap<string, AchievementDef> = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));
