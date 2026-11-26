import type { Db } from '../../core/database/connection.js';

/** Réglages du rôle du plus riche et des braquages (section `/config` « Rôles et braquage »). */
export interface EconomyExtras {
  readonly richestRoleId: string | null;
  /** Détenteur actuel du rôle du plus riche. */
  readonly richestUserId: string | null;
  readonly richestChannelId: string | null;
  readonly heistEnabled: boolean;
  /** Butin maximal d'un braquage. */
  readonly heistCap: number;
}

export const DEFAULT_EXTRAS: EconomyExtras = {
  richestRoleId: null,
  richestUserId: null,
  richestChannelId: null,
  heistEnabled: true,
  heistCap: 5_000,
};

interface Row extends Omit<EconomyExtras, 'heistEnabled'> {
  heistEnabled: number;
}

export class EconomyExtrasStore {
  private readonly stmts;

  constructor(db: Db) {
    this.stmts = {
      get: db.prepare<[string], Row>(
        `SELECT richest_role_id AS richestRoleId, richest_user_id AS richestUserId,
                richest_channel_id AS richestChannelId, heist_enabled AS heistEnabled, heist_cap AS heistCap
         FROM economy_extras WHERE guild_id = ?`,
      ),
      upsert: db.prepare(
        `INSERT INTO economy_extras (guild_id, richest_role_id, richest_user_id, richest_channel_id, heist_enabled, heist_cap)
         VALUES (@guildId, @richestRoleId, @richestUserId, @richestChannelId, @heistEnabled, @heistCap)
         ON CONFLICT (guild_id) DO UPDATE SET
           richest_role_id = excluded.richest_role_id, richest_user_id = excluded.richest_user_id,
           richest_channel_id = excluded.richest_channel_id, heist_enabled = excluded.heist_enabled,
           heist_cap = excluded.heist_cap`,
      ),
      withRichestRole: db.prepare<[], { guildId: string } & Row>(
        `SELECT guild_id AS guildId, richest_role_id AS richestRoleId, richest_user_id AS richestUserId,
                richest_channel_id AS richestChannelId, heist_enabled AS heistEnabled, heist_cap AS heistCap
         FROM economy_extras WHERE richest_role_id IS NOT NULL`,
      ),
    };
  }

  get(guildId: string): EconomyExtras {
    const row = this.stmts.get.get(guildId);
    return row ? { ...row, heistEnabled: row.heistEnabled === 1 } : DEFAULT_EXTRAS;
  }

  set(guildId: string, extras: EconomyExtras): void {
    this.stmts.upsert.run({ guildId, ...extras, heistEnabled: extras.heistEnabled ? 1 : 0 });
  }

  /** Serveurs qui ont un rôle du plus riche. */
  richestRoleGuilds(): ({ readonly guildId: string } & EconomyExtras)[] {
    return this.stmts.withRichestRole.all().map((r) => ({ ...r, heistEnabled: r.heistEnabled === 1 }));
  }
}
