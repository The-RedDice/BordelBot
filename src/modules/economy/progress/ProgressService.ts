import type { Db } from '../../../core/database/connection.js';
import type { EconomyService } from '../EconomyService.js';
import { ACHIEVEMENTS, type AchievementDef, type StatKey } from './achievements.js';

/** `add` incrémente un compteur ; `max` ne garde que le record. */
export type StatUpdate =
  | { readonly stat: StatKey; readonly add: number }
  | { readonly stat: StatKey; readonly max: number };

export interface UnlockedAchievement {
  readonly achievement: AchievementDef;
  /** Récompense réellement versée (0 si le plafond de solde l'a empêchée). */
  readonly reward: number;
}

export interface AchievementProgress {
  readonly achievement: AchievementDef;
  readonly unlockedAt: number | null;
  readonly current: number;
}

function prepareStatements(db: Db) {
  return {
    add: db.prepare(
      `INSERT INTO user_stats (guild_id, user_id, stat, value) VALUES (@guildId, @userId, @stat, @value)
       ON CONFLICT (guild_id, user_id, stat) DO UPDATE SET value = value + excluded.value`,
    ),
    max: db.prepare(
      `INSERT INTO user_stats (guild_id, user_id, stat, value) VALUES (@guildId, @userId, @stat, @value)
       ON CONFLICT (guild_id, user_id, stat) DO UPDATE SET value = MAX(value, excluded.value)`,
    ),
    stats: db.prepare<[string, string], { stat: StatKey; value: number }>(
      'SELECT stat, value FROM user_stats WHERE guild_id = ? AND user_id = ?',
    ),
    unlocked: db.prepare<[string, string], { achievement: string; unlockedAt: number }>(
      'SELECT achievement, unlocked_at AS unlockedAt FROM achievements WHERE guild_id = ? AND user_id = ?',
    ),
    unlock: db.prepare(
      `INSERT INTO achievements (guild_id, user_id, achievement, unlocked_at)
       VALUES (@guildId, @userId, @achievement, @now) ON CONFLICT DO NOTHING`,
    ),
  };
}

/**
 * Statistiques par membre et succès qui en découlent. Les commandes appellent
 * `record` après une action réussie et affichent les succès renvoyés.
 */
export class ProgressService {
  private readonly stmts: ReturnType<typeof prepareStatements>;

  constructor(
    db: Db,
    private readonly eco: EconomyService,
  ) {
    this.stmts = prepareStatements(db);
  }

  stats(guildId: string, userId: string): Partial<Record<StatKey, number>> {
    return Object.fromEntries(this.stmts.stats.all(guildId, userId).map((r) => [r.stat, r.value]));
  }

  progress(guildId: string, userId: string): AchievementProgress[] {
    const stats = this.stats(guildId, userId);
    const unlocked = new Map(this.stmts.unlocked.all(guildId, userId).map((r) => [r.achievement, r.unlockedAt]));
    return ACHIEVEMENTS.map((achievement) => ({
      achievement,
      unlockedAt: unlocked.get(achievement.key) ?? null,
      current: stats[achievement.stat] ?? 0,
    }));
  }

  /**
   * Met à jour les statistiques puis débloque (et paie) les succès atteints.
   * Atomique : statistiques, déblocages et récompenses sont écrits ensemble.
   */
  record(guildId: string, userId: string, updates: readonly StatUpdate[]): UnlockedAchievement[] {
    if (updates.length === 0) return [];
    const r = this.eco.transact((ledger) => {
      for (const u of updates) {
        if ('add' in u) {
          if (u.add !== 0) this.stmts.add.run({ guildId, userId, stat: u.stat, value: u.add });
        } else {
          this.stmts.max.run({ guildId, userId, stat: u.stat, value: u.max });
        }
      }
      const touched = new Set(updates.map((u) => u.stat));
      const stats = this.stats(guildId, userId);
      const unlocked: UnlockedAchievement[] = [];
      for (const a of ACHIEVEMENTS) {
        if (!touched.has(a.stat) || (stats[a.stat] ?? 0) < a.threshold) continue;
        const { changes } = this.stmts.unlock.run({ guildId, userId, achievement: a.key, now: ledger.now() });
        if (changes === 0) continue; // déjà débloqué
        let reward = 0;
        if (a.reward > 0) {
          // applyDelta vérifie le plafond avant toute écriture : l'échec ne laisse rien à moitié fait.
          try {
            ledger.apply({ guildId, userId, delta: a.reward, kind: 'achievement', reference: a.key, note: a.name });
            reward = a.reward;
          } catch {
            // Plafond de solde atteint : le succès est débloqué sans récompense.
          }
        }
        unlocked.push({ achievement: a, reward });
      }
      return unlocked;
    });
    if (!r.ok) throw new Error(`Échec de l'enregistrement des statistiques : ${r.error.code}`);
    return r.value;
  }
}
