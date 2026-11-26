import type { BotContext } from '../../core/context.js';
import type { Db } from '../../core/database/connection.js';
import type { ModerationAction } from '../../core/events.js';
import type { ThresholdAction, WarnThreshold } from './thresholds.js';

export type { ModerationAction };

export const MAX_REASON_LENGTH = 500;
export const MAX_WARN_EXPIRY_DAYS = 3650;
const DAY_MS = 86_400_000;

export interface ModerationCase {
  readonly id: number;
  readonly guildId: string;
  /** Numéro lisible, propre à chaque serveur (#1, #2…). */
  readonly caseNumber: number;
  readonly action: ModerationAction;
  /** Utilisateur visé, ou salon pour une purge. */
  readonly targetId: string;
  readonly moderatorId: string;
  readonly reason: string | null;
  readonly durationMs: number | null;
  readonly expiresAt: number | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly revoked: boolean;
  readonly createdAt: number;
  /** Ban temporaire levé, ou verrouillage annulé. */
  readonly resolvedAt: number | null;
}

export interface NewCase {
  readonly guildId: string;
  readonly action: ModerationAction;
  readonly targetId: string;
  readonly moderatorId: string;
  readonly reason?: string | null;
  readonly durationMs?: number | null;
  readonly metadata?: Record<string, unknown> | null;
}

export type RevokeResult =
  | { readonly ok: true; readonly case: ModerationCase }
  | { readonly ok: false; readonly code: 'NOT_FOUND' | 'NOT_A_WARN' | 'ALREADY_REVOKED'; readonly message: string };

interface CaseRow {
  id: number;
  guildId: string;
  caseNumber: number;
  action: ModerationAction;
  targetId: string;
  moderatorId: string;
  reason: string | null;
  durationMs: number | null;
  expiresAt: number | null;
  metadata: string | null;
  revoked: number;
  createdAt: number;
  resolvedAt: number | null;
}

const CASE_COLUMNS = `id, guild_id AS guildId, case_number AS caseNumber, action, target_id AS targetId,
  moderator_id AS moderatorId, reason, duration_ms AS durationMs, expires_at AS expiresAt, metadata,
  revoked, created_at AS createdAt, resolved_at AS resolvedAt`;

function toCase(r: CaseRow): ModerationCase {
  return { ...r, revoked: r.revoked === 1, metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null };
}

function prepareStatements(db: Db) {
  return {
    nextNumber: db
      .prepare<[string], number>('SELECT COALESCE(MAX(case_number), 0) + 1 FROM moderation_cases WHERE guild_id = ?')
      .pluck(),
    insert: db.prepare(
      `INSERT INTO moderation_cases
         (guild_id, case_number, action, target_id, moderator_id, reason, duration_ms, expires_at, metadata, created_at)
       VALUES (@guildId, @caseNumber, @action, @targetId, @moderatorId, @reason, @durationMs, @expiresAt, @metadata, @now)`,
    ),
    byId: db.prepare<[number], CaseRow>(`SELECT ${CASE_COLUMNS} FROM moderation_cases WHERE id = ?`),
    byNumber: db.prepare<[string, number], CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM moderation_cases WHERE guild_id = ? AND case_number = ?`,
    ),
    forTarget: db.prepare<[string, string, number, number], CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM moderation_cases
       WHERE guild_id = ? AND target_id = ? AND (? = 1 OR revoked = 0)
       ORDER BY case_number DESC LIMIT ?`,
    ),
    activeWarns: db
      .prepare<[string, string, number], number>(
        `SELECT COUNT(*) FROM moderation_cases
         WHERE guild_id = ? AND target_id = ? AND action = 'warn' AND revoked = 0 AND created_at >= ?`,
      )
      .pluck(),
    dueBans: db.prepare<[number, number], CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM moderation_cases
       WHERE action = 'ban' AND expires_at IS NOT NULL AND resolved_at IS NULL AND expires_at <= ?
       ORDER BY expires_at LIMIT ?`,
    ),
    resolve: db.prepare('UPDATE moderation_cases SET resolved_at = @now WHERE id = @id AND resolved_at IS NULL'),
    resolveBansFor: db.prepare(
      `UPDATE moderation_cases SET resolved_at = @now
       WHERE guild_id = @guildId AND target_id = @targetId AND action = 'ban' AND resolved_at IS NULL`,
    ),
    openLock: db.prepare<[string, string], CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM moderation_cases
       WHERE guild_id = ? AND target_id = ? AND action = 'lock' AND resolved_at IS NULL
       ORDER BY case_number DESC LIMIT 1`,
    ),
    getExpiry: db.prepare<[string], number>('SELECT warn_expiry_days FROM guild_settings WHERE guild_id = ?').pluck(),
    setExpiry: db.prepare(
      `INSERT INTO guild_settings (guild_id, warn_expiry_days, created_at, updated_at)
       VALUES (@guildId, @days, @now, @now)
       ON CONFLICT (guild_id) DO UPDATE SET warn_expiry_days = excluded.warn_expiry_days, updated_at = excluded.updated_at`,
    ),
    thresholds: db.prepare<[string], { warnCount: number; action: ThresholdAction; durationMs: number | null }>(
      `SELECT warn_count AS warnCount, action, duration_ms AS durationMs
       FROM moderation_thresholds WHERE guild_id = ? ORDER BY warn_count`,
    ),
    clearThresholds: db.prepare('DELETE FROM moderation_thresholds WHERE guild_id = ?'),
    insertThreshold: db.prepare(
      `INSERT INTO moderation_thresholds (guild_id, warn_count, action, duration_ms)
       VALUES (@guildId, @warnCount, @action, @durationMs)`,
    ),
    revoke: db.prepare('UPDATE moderation_cases SET revoked = 1, metadata = @metadata WHERE id = @id'),
    getLogChannel: db
      .prepare<[string], string | null>('SELECT mod_log_channel_id FROM guild_settings WHERE guild_id = ?')
      .pluck(),
    setLogChannel: db.prepare(
      `INSERT INTO guild_settings (guild_id, mod_log_channel_id, created_at, updated_at)
       VALUES (@guildId, @channelId, @now, @now)
       ON CONFLICT (guild_id) DO UPDATE SET mod_log_channel_id = excluded.mod_log_channel_id, updated_at = excluded.updated_at`,
    ),
    getMessageLogChannel: db
      .prepare<[string], string | null>('SELECT message_log_channel_id FROM guild_settings WHERE guild_id = ?')
      .pluck(),
    setMessageLogChannel: db.prepare(
      `INSERT INTO guild_settings (guild_id, message_log_channel_id, created_at, updated_at)
       VALUES (@guildId, @channelId, @now, @now)
       ON CONFLICT (guild_id) DO UPDATE SET
         message_log_channel_id = excluded.message_log_channel_id, updated_at = excluded.updated_at`,
    ),
    insertNote: db.prepare(
      `INSERT INTO moderation_notes (guild_id, target_id, author_id, content, created_at)
       VALUES (@guildId, @targetId, @authorId, @content, @now)`,
    ),
    noteById: db.prepare<[number, string], ModerationNote>(
      `SELECT ${NOTE_COLUMNS} FROM moderation_notes WHERE id = ? AND guild_id = ?`,
    ),
    notesFor: db.prepare<[string, string, number], ModerationNote>(
      `SELECT ${NOTE_COLUMNS} FROM moderation_notes WHERE guild_id = ? AND target_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ),
    countNotes: db
      .prepare<[string, string], number>('SELECT COUNT(*) FROM moderation_notes WHERE guild_id = ? AND target_id = ?')
      .pluck(),
    deleteNote: db.prepare('DELETE FROM moderation_notes WHERE id = ? AND guild_id = ?'),
  };
}

export const MAX_NOTE_LENGTH = 1000;

/** Note interne sur un membre : visible des modérateurs seulement, sans effet sur les sanctions. */
export interface ModerationNote {
  readonly id: number;
  readonly guildId: string;
  readonly targetId: string;
  readonly authorId: string;
  readonly content: string;
  readonly createdAt: number;
}

const NOTE_COLUMNS = `id, guild_id AS guildId, target_id AS targetId, author_id AS authorId, content,
  created_at AS createdAt`;

/**
 * Journal des sanctions. Ne parle pas à Discord : la couche Discord exécute
 * l'action, puis enregistre le cas ici seulement si l'action a réussi.
 */
export class ModerationService {
  private readonly stmts: ReturnType<typeof prepareStatements>;
  private readonly clock: () => number;

  constructor(
    private readonly ctx: Pick<BotContext, 'db' | 'bus'>,
    options: { clock?: () => number } = {},
  ) {
    this.stmts = prepareStatements(ctx.db);
    this.clock = options.clock ?? Date.now;
  }

  createCase(input: NewCase): ModerationCase {
    const now = this.clock();
    const reason = input.reason?.trim().slice(0, MAX_REASON_LENGTH) || null;
    const durationMs = input.durationMs ?? null;

    const created = this.ctx.db.transaction(() => {
      const caseNumber = this.stmts.nextNumber.get(input.guildId) ?? 1;
      const { lastInsertRowid } = this.stmts.insert.run({
        guildId: input.guildId,
        caseNumber,
        action: input.action,
        targetId: input.targetId,
        moderatorId: input.moderatorId,
        reason,
        durationMs,
        expiresAt: durationMs === null ? null : now + durationMs,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      });
      return this.stmts.byId.get(Number(lastInsertRowid));
    })();
    if (!created) throw new Error('Cas de modération introuvable juste après son insertion');

    const c = toCase(created);
    void this.ctx.bus.emit('moderation:caseCreated', {
      caseId: c.id,
      guildId: c.guildId,
      action: c.action,
      targetId: c.targetId,
      moderatorId: c.moderatorId,
    });
    return c;
  }

  getCase(guildId: string, caseNumber: number): ModerationCase | null {
    const row = this.stmts.byNumber.get(guildId, caseNumber);
    return row ? toCase(row) : null;
  }

  listCases(guildId: string, targetId: string, options: { limit?: number; includeRevoked?: boolean } = {}): ModerationCase[] {
    return this.stmts.forTarget
      .all(guildId, targetId, options.includeRevoked ? 1 : 0, options.limit ?? 15)
      .map(toCase);
  }

  /** Avertissements non révoqués et non expirés. */
  countActiveWarns(guildId: string, targetId: string): number {
    return this.stmts.activeWarns.get(guildId, targetId, this.warnCutoff(guildId)) ?? 0;
  }

  /** Un avertissement créé avant cette date est expiré (0 si les avertissements n'expirent pas). */
  warnCutoff(guildId: string): number {
    const days = this.getWarnExpiryDays(guildId);
    return days > 0 ? this.clock() - days * DAY_MS : 0;
  }

  isWarnExpired(c: ModerationCase): boolean {
    return c.action === 'warn' && c.createdAt < this.warnCutoff(c.guildId);
  }

  getWarnExpiryDays(guildId: string): number {
    return this.stmts.getExpiry.get(guildId) ?? 0;
  }

  setWarnExpiryDays(guildId: string, days: number): void {
    if (!Number.isInteger(days) || days < 0 || days > MAX_WARN_EXPIRY_DAYS) {
      throw new RangeError(`Durée d'expiration invalide : ${days}`);
    }
    this.stmts.setExpiry.run({ guildId, days, now: this.clock() });
  }

  // ----- Paliers de sanctions automatiques -----

  getThresholds(guildId: string): WarnThreshold[] {
    return this.stmts.thresholds.all(guildId);
  }

  /** Remplace tous les paliers du serveur. */
  setThresholds(guildId: string, thresholds: readonly WarnThreshold[]): void {
    this.ctx.db.transaction(() => {
      this.stmts.clearThresholds.run(guildId);
      for (const t of thresholds) this.stmts.insertThreshold.run({ guildId, ...t });
    })();
  }

  /** Palier déclenché quand un membre atteint exactement ce nombre d'avertissements. */
  thresholdFor(guildId: string, warnCount: number): WarnThreshold | null {
    return this.getThresholds(guildId).find((t) => t.warnCount === warnCount) ?? null;
  }

  // ----- Tâches différées : bans temporaires, verrouillages -----

  /** Bans temporaires arrivés à échéance et pas encore levés, tous serveurs confondus. */
  dueTempbans(limit = 50): ModerationCase[] {
    return this.stmts.dueBans.all(this.clock(), limit).map(toCase);
  }

  resolveCase(caseId: number): void {
    this.stmts.resolve.run({ id: caseId, now: this.clock() });
  }

  /** Un débannissement manuel clôt les bans temporaires en attente de ce membre. */
  resolveBans(guildId: string, targetId: string): void {
    this.stmts.resolveBansFor.run({ guildId, targetId, now: this.clock() });
  }

  /** Dernier verrouillage encore actif d'un salon (pour restaurer les permissions d'origine). */
  openLock(guildId: string, channelId: string): ModerationCase | null {
    const row = this.stmts.openLock.get(guildId, channelId);
    return row ? toCase(row) : null;
  }

  /** Annule un avertissement (il reste dans le journal, marqué révoqué, avec l'auteur et le motif). */
  revokeWarn(guildId: string, caseNumber: number, moderatorId: string, reason: string | null): RevokeResult {
    const c = this.getCase(guildId, caseNumber);
    if (!c) return { ok: false, code: 'NOT_FOUND', message: `Aucun cas #${caseNumber} sur ce serveur.` };
    if (c.action !== 'warn') {
      return { ok: false, code: 'NOT_A_WARN', message: `Le cas #${caseNumber} n'est pas un avertissement.` };
    }
    if (c.revoked) return { ok: false, code: 'ALREADY_REVOKED', message: `Le cas #${caseNumber} est déjà révoqué.` };

    const metadata = {
      ...(c.metadata ?? {}),
      revokedBy: moderatorId,
      revokedAt: this.clock(),
      revokeReason: reason?.trim().slice(0, MAX_REASON_LENGTH) || null,
    };
    this.stmts.revoke.run({ id: c.id, metadata: JSON.stringify(metadata) });
    return { ok: true, case: { ...c, revoked: true, metadata } };
  }

  getLogChannel(guildId: string): string | null {
    return this.stmts.getLogChannel.get(guildId) ?? null;
  }

  setLogChannel(guildId: string, channelId: string | null): void {
    this.stmts.setLogChannel.run({ guildId, channelId, now: this.clock() });
  }

  /** Salon des messages modifiés et supprimés (distinct du salon des sanctions). */
  getMessageLogChannel(guildId: string): string | null {
    return this.stmts.getMessageLogChannel.get(guildId) ?? null;
  }

  setMessageLogChannel(guildId: string, channelId: string | null): void {
    this.stmts.setMessageLogChannel.run({ guildId, channelId, now: this.clock() });
  }

  // ----- Notes de modération -----

  addNote(guildId: string, targetId: string, authorId: string, content: string): ModerationNote {
    const text = content.trim().slice(0, MAX_NOTE_LENGTH);
    if (!text) throw new RangeError('Note vide');
    const { lastInsertRowid } = this.stmts.insertNote.run({ guildId, targetId, authorId, content: text, now: this.clock() });
    const note = this.stmts.noteById.get(Number(lastInsertRowid), guildId);
    if (!note) throw new Error('Note introuvable juste après son insertion');
    return note;
  }

  getNote(guildId: string, id: number): ModerationNote | null {
    return this.stmts.noteById.get(id, guildId) ?? null;
  }

  /** Notes d'un membre, de la plus récente à la plus ancienne. */
  listNotes(guildId: string, targetId: string, limit = 10): ModerationNote[] {
    return this.stmts.notesFor.all(guildId, targetId, limit);
  }

  countNotes(guildId: string, targetId: string): number {
    return this.stmts.countNotes.get(guildId, targetId) ?? 0;
  }

  /** Supprime une note de ce serveur ; renvoie false si elle n'existe pas. */
  deleteNote(guildId: string, id: number): boolean {
    return this.stmts.deleteNote.run(id, guildId).changes > 0;
  }
}
