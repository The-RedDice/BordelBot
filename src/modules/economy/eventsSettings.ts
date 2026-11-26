import type { Db } from '../../core/database/connection.js';

/** Réglages de la loterie et des saisons (section `/config` « Loterie et saisons »). */
export interface EventSettings {
  /** Prix du ticket ; 0 = loterie désactivée. */
  readonly ticketPrice: number;
  /** Salon des annonces : tirage de la loterie, podium de la saison. */
  readonly channelId: string | null;
  readonly championRoleId: string | null;
  /** Détenteur actuel du rôle de champion. */
  readonly championUserId: string | null;
  /** Bonus du podium : 1er, 2e, 3e. */
  readonly rewards: readonly [number, number, number];
}

export const DEFAULT_EVENT_SETTINGS: EventSettings = {
  ticketPrice: 100,
  channelId: null,
  championRoleId: null,
  championUserId: null,
  rewards: [1_000, 500, 250],
};

interface Row {
  ticketPrice: number;
  channelId: string | null;
  championRoleId: string | null;
  championUserId: string | null;
  reward1: number;
  reward2: number;
  reward3: number;
}

const toSettings = (r: Row): EventSettings => ({
  ticketPrice: r.ticketPrice,
  channelId: r.channelId,
  championRoleId: r.championRoleId,
  championUserId: r.championUserId,
  rewards: [r.reward1, r.reward2, r.reward3],
});

export class EventSettingsStore {
  private readonly stmts;

  constructor(db: Db) {
    this.stmts = {
      get: db.prepare<[string], Row>(
        `SELECT ticket_price AS ticketPrice, channel_id AS channelId, champion_role_id AS championRoleId,
                champion_user_id AS championUserId, reward1, reward2, reward3
         FROM economy_events WHERE guild_id = ?`,
      ),
      upsert: db.prepare(
        `INSERT INTO economy_events
           (guild_id, ticket_price, channel_id, champion_role_id, champion_user_id, reward1, reward2, reward3)
         VALUES (@guildId, @ticketPrice, @channelId, @championRoleId, @championUserId, @reward1, @reward2, @reward3)
         ON CONFLICT (guild_id) DO UPDATE SET
           ticket_price = excluded.ticket_price, channel_id = excluded.channel_id,
           champion_role_id = excluded.champion_role_id, champion_user_id = excluded.champion_user_id,
           reward1 = excluded.reward1, reward2 = excluded.reward2, reward3 = excluded.reward3`,
      ),
    };
  }

  get(guildId: string): EventSettings {
    const row = this.stmts.get.get(guildId);
    return row ? toSettings(row) : DEFAULT_EVENT_SETTINGS;
  }

  set(guildId: string, s: EventSettings): void {
    const [reward1, reward2, reward3] = s.rewards;
    this.stmts.upsert.run({
      guildId,
      ticketPrice: s.ticketPrice,
      channelId: s.channelId,
      championRoleId: s.championRoleId,
      championUserId: s.championUserId,
      reward1,
      reward2,
      reward3,
    });
  }
}
