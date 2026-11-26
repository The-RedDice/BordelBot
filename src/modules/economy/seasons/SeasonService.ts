import type { Db } from '../../../core/database/connection.js';
import { monthId, monthLabel, monthRange, PARIS } from '../../../core/time.js';
import type { EconomyService, EcoResult } from '../EconomyService.js';
import type { EventSettingsStore } from '../eventsSettings.js';

/**
 * Opérations qui ne comptent pas dans les gains d'une saison : recevoir de
 * l'argent d'un ami ou d'un admin ne fait pas grimper au classement, et
 * dépenser en boutique n'y fait pas perdre de place.
 */
export const EXCLUDED_KINDS = ['transfer_in', 'transfer_out', 'admin_adjust', 'purchase'] as const;
const EXCLUDED_SQL = EXCLUDED_KINDS.map((k) => `'${k}'`).join(', ');

export interface SeasonRow {
  readonly userId: string;
  readonly value: number;
}

export interface PodiumEntry {
  readonly rank: 1 | 2 | 3;
  readonly userId: string;
  readonly score: number;
  readonly reward: number;
}

export interface SeasonClose {
  readonly season: string;
  readonly podium: readonly PodiumEntry[];
}

/**
 * Saisons mensuelles (mois de l'heure de Paris). Seuls les classements de saison
 * repartent de zéro : les soldes ne bougent pas. Le podium officiel classe les
 * gains du mois ; il est archivé, et le top 3 reçoit un bonus à la clôture.
 */
export class SeasonService {
  private readonly stmts;

  constructor(
    db: Db,
    private readonly eco: EconomyService,
    private readonly settings: EventSettingsStore,
    private readonly clock: () => number = Date.now,
  ) {
    const earnings = `SELECT user_id AS userId, SUM(amount) AS value FROM economy_transactions
       WHERE guild_id = @guildId AND created_at >= @start AND created_at < @end AND kind NOT IN (${EXCLUDED_SQL})
       GROUP BY user_id HAVING SUM(amount) > 0`;
    this.stmts = {
      earnings: db.prepare<{ guildId: string; start: number; end: number; limit: number }, SeasonRow>(
        `${earnings} ORDER BY value DESC, user_id LIMIT @limit`,
      ),
      earningsOf: db
        .prepare<{ guildId: string; start: number; end: number; userId: string }, number>(
          `SELECT COALESCE(SUM(amount), 0) FROM economy_transactions
           WHERE guild_id = @guildId AND user_id = @userId AND created_at >= @start AND created_at < @end
             AND kind NOT IN (${EXCLUDED_SQL})`,
        )
        .pluck(),
      earningsRank: db
        .prepare<{ guildId: string; start: number; end: number; value: number; userId: string }, number>(
          `SELECT COUNT(*) + 1 FROM (${earnings}) WHERE value > @value OR (value = @value AND userId < @userId)`,
        )
        .pluck(),
      addWin: db.prepare(
        `INSERT INTO season_stats (guild_id, season, user_id, wins) VALUES (?, ?, ?, 1)
         ON CONFLICT (guild_id, season, user_id) DO UPDATE SET wins = wins + 1`,
      ),
      wins: db.prepare<[string, string, number], SeasonRow>(
        `SELECT user_id AS userId, wins AS value FROM season_stats WHERE guild_id = ? AND season = ? AND wins > 0
         ORDER BY wins DESC, user_id LIMIT ?`,
      ),
      winsOf: db
        .prepare<[string, string, string], number>('SELECT wins FROM season_stats WHERE guild_id = ? AND season = ? AND user_id = ?')
        .pluck(),
      hasResults: db.prepare<[string, string], number>('SELECT 1 FROM season_results WHERE guild_id = ? AND season = ?').pluck(),
      insertResult: db.prepare(
        'INSERT INTO season_results (guild_id, season, rank, user_id, score, reward) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      results: db.prepare<[string, string], PodiumEntry>(
        `SELECT rank, user_id AS userId, score, reward FROM season_results WHERE guild_id = ? AND season = ? ORDER BY rank`,
      ),
      lastSeason: db
        .prepare<[string], string>('SELECT season FROM season_results WHERE guild_id = ? ORDER BY season DESC LIMIT 1')
        .pluck(),
      guilds: db.prepare<[], string>('SELECT DISTINCT guild_id FROM economy_accounts').pluck(),
    };
  }

  currentSeason(): string {
    return monthId(this.clock(), PARIS);
  }

  /** Fin de la saison en cours. */
  seasonEnd(season = this.currentSeason()): number {
    return monthRange(season, PARIS).end;
  }

  earningsBoard(guildId: string, season: string, limit = 10): SeasonRow[] {
    return this.stmts.earnings.all({ guildId, ...monthRange(season, PARIS), limit });
  }

  /** Gains du membre sur la saison et son rang (null s'il n'est pas classé). */
  earningsOf(guildId: string, season: string, userId: string): { value: number; rank: number | null } {
    const range = monthRange(season, PARIS);
    const value = this.stmts.earningsOf.get({ guildId, userId, ...range }) ?? 0;
    return { value, rank: value > 0 ? (this.stmts.earningsRank.get({ guildId, userId, value, ...range }) ?? null) : null };
  }

  /** Compte une victoire dans la saison du moment où la partie s'est terminée. */
  addWin(guildId: string, userId: string, at: number): void {
    this.stmts.addWin.run(guildId, monthId(at, PARIS), userId);
  }

  winsBoard(guildId: string, season: string, limit = 10): SeasonRow[] {
    return this.stmts.wins.all(guildId, season, limit);
  }

  winsOf(guildId: string, season: string, userId: string): number {
    return this.stmts.winsOf.get(guildId, season, userId) ?? 0;
  }

  results(guildId: string, season: string): PodiumEntry[] {
    return this.stmts.results.all(guildId, season);
  }

  /** Dernière saison archivée du serveur, ou null. */
  lastSeason(guildId: string): string | null {
    return this.stmts.lastSeason.get(guildId) ?? null;
  }

  /** Serveurs qui ont une économie (candidats à la clôture). */
  guilds(): string[] {
    return this.stmts.guilds.all();
  }

  /**
   * Clôture une saison : archive le podium des gains et verse les bonus, en une
   * transaction. Idempotent : null si la saison est déjà archivée.
   */
  close(guildId: string, season: string): EcoResult<SeasonClose | null> {
    return this.eco.transact((ledger) => {
      if (this.stmts.hasResults.get(guildId, season) !== undefined) return null;
      const { rewards } = this.settings.get(guildId);
      const podium = this.earningsBoard(guildId, season, 3).map((row, idx): PodiumEntry => {
        const rank = (idx + 1) as 1 | 2 | 3;
        const reward = rewards[idx] ?? 0;
        this.stmts.insertResult.run(guildId, season, rank, row.userId, row.value, reward);
        if (reward > 0) {
          ledger.apply({
            guildId,
            userId: row.userId,
            delta: reward,
            kind: 'season_reward',
            reference: season,
            note: `${rank}ᵉ de la saison ${monthLabel(season)}`.replace('1ᵉ', '1ᵉʳ'),
          });
        }
        return { rank, userId: row.userId, score: row.value, reward };
      });
      return { season, podium };
    });
  }
}
