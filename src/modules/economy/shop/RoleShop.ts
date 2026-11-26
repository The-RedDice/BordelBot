import type { Db } from '../../../core/database/connection.js';
import { fail, type EconomyService, type EcoResult, type ShopItem } from '../EconomyService.js';

export interface RoleGrant {
  readonly guildId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly itemKey: string;
  /** null = permanent. */
  readonly expiresAt: number | null;
}

export interface RolePurchase {
  readonly item: ShopItem;
  readonly roleId: string;
  readonly price: number;
  readonly balance: number;
  /** Nouvelle échéance ; null = permanent. */
  readonly expiresAt: number | null;
  /** Droit d'avant l'achat (pour l'annuler si Discord refuse le rôle) ; null s'il n'y en avait pas. */
  readonly previous: RoleGrant | null;
}

/**
 * Rôles vendus en boutique. Un rôle permanent ne s'achète qu'une fois ; racheter
 * un rôle temporaire prolonge sa durée (à partir de l'échéance en cours).
 * L'argent et le droit sont enregistrés ensemble ; c'est la couche Discord qui
 * attribue le rôle, et qui annule l'achat (`undo`) si Discord le refuse.
 */
export class RoleShop {
  private readonly stmts;

  constructor(
    db: Db,
    private readonly eco: EconomyService,
    private readonly clock: () => number = Date.now,
  ) {
    this.stmts = {
      get: db.prepare<[string, string, string], RoleGrant>(
        `SELECT guild_id AS guildId, user_id AS userId, role_id AS roleId, item_key AS itemKey, expires_at AS expiresAt
         FROM role_grants WHERE guild_id = ? AND user_id = ? AND role_id = ?`,
      ),
      list: db.prepare<[string, string], RoleGrant>(
        `SELECT guild_id AS guildId, user_id AS userId, role_id AS roleId, item_key AS itemKey, expires_at AS expiresAt
         FROM role_grants WHERE guild_id = ? AND user_id = ? ORDER BY expires_at IS NULL, expires_at`,
      ),
      upsert: db.prepare(
        `INSERT INTO role_grants (guild_id, user_id, role_id, item_key, expires_at, granted_at)
         VALUES (@guildId, @userId, @roleId, @itemKey, @expiresAt, @now)
         ON CONFLICT (guild_id, user_id, role_id) DO UPDATE SET
           item_key = excluded.item_key, expires_at = excluded.expires_at`,
      ),
      remove: db.prepare('DELETE FROM role_grants WHERE guild_id = ? AND user_id = ? AND role_id = ?'),
    };
  }

  grant(guildId: string, userId: string, roleId: string): RoleGrant | null {
    return this.stmts.get.get(guildId, userId, roleId) ?? null;
  }

  /** Rôles achetés par un membre, les temporaires d'abord (du plus proche de l'échéance au plus lointain). */
  grants(guildId: string, userId: string): RoleGrant[] {
    return this.stmts.list.all(guildId, userId);
  }

  buy(guildId: string, userId: string, key: string): EcoResult<RolePurchase> {
    return this.eco.transact((ledger) => {
      const item = this.eco.getItem(guildId, key.trim().toLowerCase());
      if (!item || !item.enabled) fail('ITEM_NOT_FOUND', "Cet article n'est pas en vente.");
      const roleId = item.roleId;
      if (!roleId) fail('INVALID_ITEM', "Cet article n'est pas un rôle.");

      const previous = this.grant(guildId, userId, roleId);
      if (previous && previous.expiresAt === null) fail('ALREADY_OWNED', 'Tu as déjà ce rôle, de façon permanente.');
      const now = this.clock();
      const expiresAt =
        item.roleDurationMs === null ? null : Math.max(now, previous?.expiresAt ?? now) + item.roleDurationMs;

      const balance =
        item.price > 0
          ? ledger.apply({ guildId, userId, delta: -item.price, kind: 'purchase', reference: item.key, note: `rôle ${item.name}` })
          : ledger.balance(guildId, userId);
      this.stmts.upsert.run({ guildId, userId, roleId, itemKey: item.key, expiresAt, now });
      return { item, roleId, price: item.price, balance, expiresAt, previous };
    });
  }

  /** Annule un achat : rembourse et rétablit le droit d'avant (Discord a refusé d'attribuer le rôle). */
  undo(guildId: string, userId: string, p: RolePurchase): EcoResult<void> {
    return this.eco.transact((ledger) => {
      if (p.price > 0) {
        ledger.apply({
          guildId,
          userId,
          delta: p.price,
          kind: 'purchase',
          reference: p.item.key,
          note: `remboursement rôle ${p.item.name}`,
        });
      }
      if (p.previous) this.stmts.upsert.run({ ...p.previous, now: this.clock() });
      else this.stmts.remove.run(guildId, userId, p.roleId);
    });
  }

  /** Oublie un droit (rôle retiré à l'échéance, ou membre parti). */
  revoke(guildId: string, userId: string, roleId: string): void {
    this.stmts.remove.run(guildId, userId, roleId);
  }
}

/** Clé de la tâche d'expiration d'un rôle : une par membre et par rôle (replanifiée à chaque prolongation). */
export const roleExpiryKey = (guildId: string, userId: string, roleId: string): string => `role:${guildId}:${userId}:${roleId}`;
