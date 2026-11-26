import type { Db } from '../../core/database/connection.js';
import { daysUntil, isCelebratedOn, isValidBirthday, isValidTimeZone, type LocalTime } from './dates.js';

export interface Birthday {
  readonly userId: string;
  readonly month: number;
  readonly day: number;
}

export interface BirthdaySettings {
  /** Salon des annonces (null : pas d'annonce). */
  readonly channelId: string | null;
  /** Rôle du jour (null : aucun). */
  readonly roleId: string | null;
  /** Monnaie offerte (0 : aucune). */
  readonly bonus: number;
  /** Heure locale de l'annonce. */
  readonly hour: number;
  readonly timezone: string;
}

export const DEFAULT_BIRTHDAY_SETTINGS: BirthdaySettings = {
  channelId: null,
  roleId: null,
  bonus: 0,
  hour: 9,
  timezone: 'Europe/Paris',
};

export const MAX_BIRTHDAY_BONUS = 1_000_000;

export interface PendingRole {
  readonly userId: string;
  readonly year: number;
  readonly roleId: string;
}

/** Stockage des anniversaires, des réglages et des anniversaires déjà fêtés. Ne parle pas à Discord. */
export class BirthdayService {
  private readonly stmts;

  constructor(db: Db) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT INTO birthdays (guild_id, user_id, month, day) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET month = excluded.month, day = excluded.day`,
      ),
      get: db.prepare<[string, string], Birthday>(
        'SELECT user_id AS userId, month, day FROM birthdays WHERE guild_id = ? AND user_id = ?',
      ),
      remove: db.prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?'),
      all: db.prepare<[string], Birthday>('SELECT user_id AS userId, month, day FROM birthdays WHERE guild_id = ?'),
      // Le 29 février est fêté le 28 les années non bissextiles : on lit les deux jours et on filtre ensuite.
      onDays: db.prepare<[string, number, number, number], Birthday>(
        `SELECT user_id AS userId, month, day FROM birthdays
         WHERE guild_id = ? AND month = ? AND day IN (?, ?)`,
      ),
      settings: db.prepare<[string], BirthdaySettings>(
        `SELECT channel_id AS channelId, role_id AS roleId, bonus, hour, timezone
         FROM birthday_settings WHERE guild_id = ?`,
      ),
      saveSettings: db.prepare(
        `INSERT INTO birthday_settings (guild_id, channel_id, role_id, bonus, hour, timezone)
         VALUES (@guildId, @channelId, @roleId, @bonus, @hour, @timezone)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = excluded.channel_id, role_id = excluded.role_id,
           bonus = excluded.bonus, hour = excluded.hour, timezone = excluded.timezone`,
      ),
      configuredGuilds: db.prepare<[], { guildId: string; lastRun: string | null } & BirthdaySettings>(
        `SELECT guild_id AS guildId, last_run AS lastRun, channel_id AS channelId, role_id AS roleId, bonus, hour, timezone
         FROM birthday_settings`,
      ),
      markRun: db.prepare('UPDATE birthday_settings SET last_run = ? WHERE guild_id = ?'),
      celebrate: db.prepare(
        `INSERT OR IGNORE INTO birthday_celebrations (guild_id, user_id, year, date, role_id) VALUES (?, ?, ?, ?, NULL)`,
      ),
      setCelebrationRole: db.prepare(
        'UPDATE birthday_celebrations SET role_id = ? WHERE guild_id = ? AND user_id = ? AND year = ?',
      ),
      pendingRoles: db.prepare<[string, string], PendingRole>(
        `SELECT user_id AS userId, year, role_id AS roleId FROM birthday_celebrations
         WHERE guild_id = ? AND role_id IS NOT NULL AND role_removed = 0 AND date <> ?`,
      ),
      roleRemoved: db.prepare(
        'UPDATE birthday_celebrations SET role_removed = 1 WHERE guild_id = ? AND user_id = ? AND year = ?',
      ),
      currency: db.prepare<[string], string>('SELECT currency_name FROM guild_settings WHERE guild_id = ?').pluck(),
    };
  }

  setBirthday(guildId: string, userId: string, month: number, day: number): void {
    if (!isValidBirthday(month, day)) throw new RangeError(`Date invalide : ${day}/${month}`);
    this.stmts.upsert.run(guildId, userId, month, day);
  }

  getBirthday(guildId: string, userId: string): Birthday | null {
    return this.stmts.get.get(guildId, userId) ?? null;
  }

  removeBirthday(guildId: string, userId: string): boolean {
    return this.stmts.remove.run(guildId, userId).changes > 0;
  }

  /** Anniversaires fêtés à cette date locale (29 février compris, le 28 hors années bissextiles). */
  birthdaysOn(guildId: string, today: LocalTime): Birthday[] {
    const extra = today.month === 2 && today.day === 28 ? 29 : today.day;
    return this.stmts.onDays
      .all(guildId, today.month, today.day, extra)
      .filter((b) => isCelebratedOn(b.month, b.day, today));
  }

  /** Prochains anniversaires, du plus proche au plus lointain (aujourd'hui compris). */
  upcoming(guildId: string, today: LocalTime, limit = 10): (Birthday & { readonly inDays: number })[] {
    return this.stmts.all
      .all(guildId)
      .map((b) => ({ ...b, inDays: daysUntil(b.month, b.day, today) }))
      .sort((a, b) => a.inDays - b.inDays || a.userId.localeCompare(b.userId))
      .slice(0, limit);
  }

  getSettings(guildId: string): BirthdaySettings {
    return this.stmts.settings.get(guildId) ?? DEFAULT_BIRTHDAY_SETTINGS;
  }

  setSettings(guildId: string, s: BirthdaySettings): void {
    if (!Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23) throw new RangeError(`Heure invalide : ${s.hour}`);
    if (!Number.isInteger(s.bonus) || s.bonus < 0 || s.bonus > MAX_BIRTHDAY_BONUS) throw new RangeError(`Bonus invalide : ${s.bonus}`);
    if (!isValidTimeZone(s.timezone)) throw new RangeError(`Fuseau horaire inconnu : ${s.timezone}`);
    this.stmts.saveSettings.run({ guildId, ...s });
  }

  /** Serveurs qui ont enregistré des réglages, avec le dernier jour fêté. */
  configuredGuilds(): ({ readonly guildId: string; readonly lastRun: string | null } & BirthdaySettings)[] {
    return this.stmts.configuredGuilds.all();
  }

  markRun(guildId: string, date: string): void {
    this.stmts.markRun.run(date, guildId);
  }

  /** Enregistre la fête de cette année ; false si elle a déjà eu lieu (pas de second bonus ni de seconde annonce). */
  celebrate(guildId: string, userId: string, year: number, date: string): boolean {
    return this.stmts.celebrate.run(guildId, userId, year, date).changes > 0;
  }

  /** Note le rôle donné pour pouvoir le retirer le lendemain. */
  recordRole(guildId: string, userId: string, year: number, roleId: string): void {
    this.stmts.setCelebrationRole.run(roleId, guildId, userId, year);
  }

  /** Rôles d'anniversaire à retirer : donnés un autre jour que `today`. */
  pendingRoleRemovals(guildId: string, today: LocalTime): PendingRole[] {
    return this.stmts.pendingRoles.all(guildId, today.date);
  }

  markRoleRemoved(guildId: string, userId: string, year: number): void {
    this.stmts.roleRemoved.run(guildId, userId, year);
  }

  /** Nom de la monnaie du serveur (réglage partagé de `guild_settings`), pour l'annonce. */
  currencyName(guildId: string): string {
    return this.stmts.currency.get(guildId) ?? 'pièces';
  }
}

/**
 * Vrai si les anniversaires du jour doivent être fêtés maintenant sur ce serveur :
 * l'heure est passée et ce jour n'a pas encore été traité. Un jour déjà traité
 * plus récent (fuseau changé vers l'ouest) n'est pas rejoué.
 */
export function isDue(settings: Pick<BirthdaySettings, 'hour'>, lastRun: string | null, now: LocalTime): boolean {
  return now.hour >= settings.hour && (lastRun === null || lastRun < now.date);
}
