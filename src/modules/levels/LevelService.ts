import type { Db } from '../../core/database/connection.js';
import { cryptoRng, type Rng } from '../../core/rng.js';
import { levelOf, MAX_XP } from './curve.js';
import type { RoleReward } from './rewards.js';

export type AnnounceMode = 'here' | 'channel' | 'off';

export interface LevelSettings {
  readonly messageXpMin: number;
  readonly messageXpMax: number;
  readonly cooldownSeconds: number;
  readonly voiceXpPerMinute: number;
  readonly announce: AnnounceMode;
  readonly announceChannelId: string | null;
  readonly stackRoles: boolean;
}

export const DEFAULT_LEVEL_SETTINGS: LevelSettings = {
  messageXpMin: 15,
  messageXpMax: 25,
  cooldownSeconds: 60,
  voiceXpPerMinute: 5,
  announce: 'here',
  announceChannelId: null,
  stackRoles: true,
};

export const MAX_XP_PER_GAIN = 1000;
export const MAX_COOLDOWN_SECONDS = 3600;

/** Résultat d'un gain ou d'un ajustement d'XP. */
export interface XpChange {
  readonly userId: string;
  readonly xpBefore: number;
  readonly xpAfter: number;
  readonly levelBefore: number;
  readonly levelAfter: number;
}

export interface MemberLevel {
  readonly xp: number;
  readonly messages: number;
  readonly voiceSeconds: number;
  /** Rang au classement (1 = premier), null sans XP. */
  readonly rank: number | null;
}

interface SettingsRow {
  messageXpMin: number;
  messageXpMax: number;
  cooldownSeconds: number;
  voiceXpPerMinute: number;
  announce: AnnounceMode;
  announceChannelId: string | null;
  stackRoles: number;
}

interface MemberRow {
  xp: number;
  messages: number;
  voiceSeconds: number;
  lastMessageXpAt: number;
}

function prepareStatements(db: Db) {
  return {
    settings: db.prepare<[string], SettingsRow>(
      `SELECT message_xp_min AS messageXpMin, message_xp_max AS messageXpMax, cooldown_seconds AS cooldownSeconds,
              voice_xp_per_minute AS voiceXpPerMinute, announce, announce_channel_id AS announceChannelId,
              stack_roles AS stackRoles
       FROM level_settings WHERE guild_id = ?`,
    ),
    upsertSettings: db.prepare(
      `INSERT INTO level_settings (guild_id, message_xp_min, message_xp_max, cooldown_seconds, voice_xp_per_minute,
                                   announce, announce_channel_id, stack_roles)
       VALUES (@guildId, @messageXpMin, @messageXpMax, @cooldownSeconds, @voiceXpPerMinute, @announce, @announceChannelId, @stackRoles)
       ON CONFLICT (guild_id) DO UPDATE SET
         message_xp_min = excluded.message_xp_min, message_xp_max = excluded.message_xp_max,
         cooldown_seconds = excluded.cooldown_seconds, voice_xp_per_minute = excluded.voice_xp_per_minute,
         announce = excluded.announce, announce_channel_id = excluded.announce_channel_id, stack_roles = excluded.stack_roles`,
    ),
    member: db.prepare<[string, string], MemberRow>(
      `SELECT xp, messages, voice_seconds AS voiceSeconds, last_message_xp_at AS lastMessageXpAt
       FROM level_members WHERE guild_id = ? AND user_id = ?`,
    ),
    ensureMember: db.prepare('INSERT INTO level_members (guild_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING'),
    countMessage: db.prepare('UPDATE level_members SET messages = messages + 1 WHERE guild_id = ? AND user_id = ?'),
    messageXp: db.prepare(
      'UPDATE level_members SET xp = @xp, last_message_xp_at = @now WHERE guild_id = @guildId AND user_id = @userId',
    ),
    voice: db.prepare(
      `UPDATE level_members SET xp = @xp, voice_seconds = voice_seconds + @seconds
       WHERE guild_id = @guildId AND user_id = @userId`,
    ),
    setXp: db.prepare('UPDATE level_members SET xp = @xp WHERE guild_id = @guildId AND user_id = @userId'),
    leaderboard: db.prepare<[string, number], { userId: string; xp: number }>(
      `SELECT user_id AS userId, xp FROM level_members
       WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, user_id LIMIT ?`,
    ),
    countAbove: db.prepare<[string, number], number>('SELECT COUNT(*) FROM level_members WHERE guild_id = ? AND xp > ?').pluck(),
    roles: db.prepare<[string], RoleReward>(
      'SELECT level, role_id AS roleId FROM level_roles WHERE guild_id = ? ORDER BY level',
    ),
    clearRoles: db.prepare('DELETE FROM level_roles WHERE guild_id = ?'),
    insertRole: db.prepare('INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?)'),
  };
}

export type SettingsResult = { ok: true; value: LevelSettings } | { ok: false; message: string };

/** Vérifie la cohérence des réglages (les bornes sont aussi garanties par les CHECK SQL). */
export function validateLevelSettings(s: LevelSettings): string | null {
  const int = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!int(s.messageXpMin) || !int(s.messageXpMax) || s.messageXpMax > MAX_XP_PER_GAIN || s.messageXpMin > s.messageXpMax) {
    return `XP par message : de 0 à ${MAX_XP_PER_GAIN}, minimum ≤ maximum (ex. \`15-25\`).`;
  }
  if (!int(s.cooldownSeconds) || s.cooldownSeconds > MAX_COOLDOWN_SECONDS) {
    return `Le délai entre deux gains va de 0 à ${MAX_COOLDOWN_SECONDS} secondes.`;
  }
  if (!int(s.voiceXpPerMinute) || s.voiceXpPerMinute > MAX_XP_PER_GAIN) return `XP vocal : de 0 à ${MAX_XP_PER_GAIN} par minute.`;
  if (s.announce === 'channel' && !s.announceChannelId) return 'Choisis le salon des annonces, ou un autre mode d’annonce.';
  return null;
}

export interface LevelServiceOptions {
  readonly clock?: () => number;
  readonly rng?: Rng;
}

/**
 * XP et niveaux par serveur. Ne dépend pas de discord.js : le module Discord
 * appelle `onMessage` / `onVoice` et applique rôles et annonces selon les
 * `XpChange` renvoyés. Le niveau se déduit toujours de l'XP total (curve.ts).
 */
export class LevelService {
  private readonly stmts: ReturnType<typeof prepareStatements>;
  private readonly clock: () => number;
  private readonly rng: Rng;

  constructor(
    private readonly db: Db,
    options: LevelServiceOptions = {},
  ) {
    this.stmts = prepareStatements(db);
    this.clock = options.clock ?? Date.now;
    this.rng = options.rng ?? cryptoRng;
  }

  getSettings(guildId: string): LevelSettings {
    const row = this.stmts.settings.get(guildId);
    if (!row) return DEFAULT_LEVEL_SETTINGS;
    return { ...row, stackRoles: row.stackRoles === 1 };
  }

  updateSettings(guildId: string, settings: LevelSettings): SettingsResult {
    const error = validateLevelSettings(settings);
    if (error) return { ok: false, message: error };
    this.stmts.upsertSettings.run({
      guildId,
      ...settings,
      announceChannelId: settings.announce === 'channel' ? settings.announceChannelId : null,
      stackRoles: settings.stackRoles ? 1 : 0,
    });
    return { ok: true, value: this.getSettings(guildId) };
  }

  /**
   * Un message a été posté : il est compté, et rapporte de l'XP si le délai
   * depuis le dernier gain est écoulé. Renvoie le changement, ou null sans gain.
   */
  onMessage(guildId: string, userId: string): XpChange | null {
    const s = this.getSettings(guildId);
    return this.db.transaction((): XpChange | null => {
      this.stmts.ensureMember.run(guildId, userId);
      this.stmts.countMessage.run(guildId, userId);
      if (s.messageXpMax <= 0) return null;
      const row = this.stmts.member.get(guildId, userId) as MemberRow;
      const now = this.clock();
      if (now - row.lastMessageXpAt < s.cooldownSeconds * 1000) return null;
      const gain = s.messageXpMin + Math.floor(this.rng() * (s.messageXpMax - s.messageXpMin + 1));
      const xp = Math.min(MAX_XP, row.xp + gain);
      this.stmts.messageXp.run({ guildId, userId, xp, now });
      return change(userId, row.xp, xp);
    })();
  }

  /** Temps passé en vocal par des membres actifs : `seconds` × le taux par minute du serveur. */
  onVoice(guildId: string, userIds: readonly string[], seconds: number): XpChange[] {
    const rate = this.getSettings(guildId).voiceXpPerMinute;
    if (rate <= 0 || seconds <= 0 || userIds.length === 0) return [];
    const gain = Math.floor((rate * seconds) / 60);
    return this.db.transaction(() =>
      userIds.map((userId) => {
        this.stmts.ensureMember.run(guildId, userId);
        const before = (this.stmts.member.get(guildId, userId) as MemberRow).xp;
        const xp = Math.min(MAX_XP, before + gain);
        this.stmts.voice.run({ guildId, userId, xp, seconds });
        return change(userId, before, xp);
      }),
    )();
  }

  /** Ajustement admin : ajoute (ou retire, delta < 0) de l'XP, borné à [0, MAX_XP]. */
  adjustXp(guildId: string, userId: string, delta: number): XpChange {
    return this.db.transaction(() => {
      const before = this.member(guildId, userId).xp;
      return this.writeXp(guildId, userId, before, before + delta);
    })();
  }

  setXp(guildId: string, userId: string, xp: number): XpChange {
    return this.db.transaction(() => this.writeXp(guildId, userId, this.member(guildId, userId).xp, xp))();
  }

  member(guildId: string, userId: string): MemberLevel {
    const row = this.stmts.member.get(guildId, userId);
    const xp = row?.xp ?? 0;
    return {
      xp,
      messages: row?.messages ?? 0,
      voiceSeconds: row?.voiceSeconds ?? 0,
      rank: xp > 0 ? (this.stmts.countAbove.get(guildId, xp) ?? 0) + 1 : null,
    };
  }

  leaderboard(guildId: string, limit = 10): { userId: string; xp: number }[] {
    return this.stmts.leaderboard.all(guildId, limit);
  }

  getRoleRewards(guildId: string): RoleReward[] {
    return this.stmts.roles.all(guildId);
  }

  setRoleRewards(guildId: string, rewards: readonly RoleReward[]): void {
    this.db.transaction(() => {
      this.stmts.clearRoles.run(guildId);
      for (const r of rewards) this.stmts.insertRole.run(guildId, r.level, r.roleId);
    })();
  }

  private writeXp(guildId: string, userId: string, before: number, target: number): XpChange {
    const xp = Math.max(0, Math.min(MAX_XP, Math.round(target)));
    this.stmts.ensureMember.run(guildId, userId);
    this.stmts.setXp.run({ guildId, userId, xp });
    return change(userId, before, xp);
  }
}

function change(userId: string, xpBefore: number, xpAfter: number): XpChange {
  return { userId, xpBefore, xpAfter, levelBefore: levelOf(xpBefore), levelAfter: levelOf(xpAfter) };
}
