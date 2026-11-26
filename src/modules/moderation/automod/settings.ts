import type { Db } from '../../../core/database/connection.js';
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from '../duration.js';
import type { SpamRules } from './detector.js';

export interface AutomodSettings extends SpamRules {
  /** Exclusion immédiate à chaque infraction du bot (0 = aucune). */
  readonly timeoutMs: number;
  /** Une infraction à l'AutoMod de Discord vaut un avertissement. */
  readonly discordWarns: boolean;
}

export const DEFAULT_AUTOMOD: AutomodSettings = {
  floodMessages: 0,
  floodSeconds: 5,
  duplicateCount: 0,
  timeoutMs: 5 * 60_000,
  discordWarns: false,
};

export const FLOOD_MESSAGES = { min: 3, max: 50 } as const;
export const FLOOD_SECONDS = { min: 1, max: 60 } as const;
export const DUPLICATES = { min: 2, max: 20 } as const;

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const OFF = /^(0|off|non|aucun|aucune|désactivée?|desactivee?)?$/i;

/** « 6/5 » (6 messages en 5 s), « 6 / 5s » ; « 0 » ou vide pour désactiver. */
export function parseFlood(input: string): Parsed<{ floodMessages: number; floodSeconds: number } | null> {
  const s = input.trim();
  if (OFF.test(s)) return { ok: true, value: null };
  const m = /^(\d+)\s*\/\s*(\d+)\s*s?$/i.exec(s);
  const messages = Number(m?.[1]);
  const seconds = Number(m?.[2]);
  if (
    !m ||
    messages < FLOOD_MESSAGES.min ||
    messages > FLOOD_MESSAGES.max ||
    seconds < FLOOD_SECONDS.min ||
    seconds > FLOOD_SECONDS.max
  ) {
    return {
      ok: false,
      message:
        `Flood : écris « messages/secondes », par exemple \`6/5\` ` +
        `(${FLOOD_MESSAGES.min} à ${FLOOD_MESSAGES.max} messages, ${FLOOD_SECONDS.min} à ${FLOOD_SECONDS.max} s), ou 0 pour désactiver.`,
    };
  }
  return { ok: true, value: { floodMessages: messages, floodSeconds: seconds } };
}

/** Nombre de messages identiques ; « 0 » ou vide pour désactiver. */
export function parseDuplicates(input: string): Parsed<number> {
  const s = input.trim();
  if (OFF.test(s)) return { ok: true, value: 0 };
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!(n >= DUPLICATES.min && n <= DUPLICATES.max)) {
    return { ok: false, message: `Messages répétés : un nombre de ${DUPLICATES.min} à ${DUPLICATES.max}, ou 0 pour désactiver.` };
  }
  return { ok: true, value: n };
}

/** « 5m », « 1h »… ; « 0 » ou vide : pas d'exclusion. */
export function parseAutomodTimeout(input: string): Parsed<number> {
  const s = input.trim();
  if (OFF.test(s)) return { ok: true, value: 0 };
  const ms = parseDuration(s);
  if (ms === null || ms > MAX_TIMEOUT_MS) {
    return { ok: false, message: 'Exclusion : une durée comme `5m` ou `1h` (28 jours max), ou 0 pour aucune.' };
  }
  return { ok: true, value: ms };
}

export const formatFlood = (s: SpamRules) => (s.floodMessages > 0 ? `${s.floodMessages}/${s.floodSeconds}` : '0');

export function describeAutomod(s: AutomodSettings): string[] {
  return [
    `**Flood :** ${s.floodMessages > 0 ? `${s.floodMessages} messages en ${s.floodSeconds} s` : 'désactivé'}`,
    `**Messages répétés :** ${s.duplicateCount > 0 ? `${s.duplicateCount} identiques en 1 min` : 'désactivé'}`,
    `**Exclusion immédiate :** ${s.timeoutMs > 0 ? formatDuration(s.timeoutMs) : 'aucune'}`,
    `**AutoMod Discord :** ${s.discordWarns ? 'chaque infraction vaut un avertissement' : 'sans effet sur les avertissements'}`,
  ];
}

interface Row {
  floodMessages: number;
  floodSeconds: number;
  duplicateCount: number;
  timeoutMs: number;
  discordWarns: number;
}

/** Réglages de l'automod, lus à chaque message : gardés en cache, invalidé à l'écriture. */
export class AutomodSettingsStore {
  private readonly cache = new Map<string, AutomodSettings>();
  private readonly select;
  private readonly upsert;

  constructor(db: Db) {
    this.select = db.prepare<[string], Row>(
      `SELECT flood_messages AS floodMessages, flood_seconds AS floodSeconds, duplicate_count AS duplicateCount,
              timeout_ms AS timeoutMs, discord_warns AS discordWarns
       FROM automod_settings WHERE guild_id = ?`,
    );
    this.upsert = db.prepare(
      `INSERT INTO automod_settings (guild_id, flood_messages, flood_seconds, duplicate_count, timeout_ms, discord_warns)
       VALUES (@guildId, @floodMessages, @floodSeconds, @duplicateCount, @timeoutMs, @discordWarns)
       ON CONFLICT (guild_id) DO UPDATE SET
         flood_messages = excluded.flood_messages, flood_seconds = excluded.flood_seconds,
         duplicate_count = excluded.duplicate_count, timeout_ms = excluded.timeout_ms,
         discord_warns = excluded.discord_warns`,
    );
  }

  get(guildId: string): AutomodSettings {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    const row = this.select.get(guildId);
    const settings = row ? { ...row, discordWarns: row.discordWarns === 1 } : DEFAULT_AUTOMOD;
    this.cache.set(guildId, settings);
    return settings;
  }

  set(guildId: string, settings: AutomodSettings): void {
    this.upsert.run({ guildId, ...settings, discordWarns: settings.discordWarns ? 1 : 0 });
    this.cache.set(guildId, { ...settings });
  }
}
