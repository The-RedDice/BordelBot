import type { BotContext } from '../../core/context.js';
import type { Db } from '../../core/database/connection.js';
import type { ModerationAction } from '../../core/events.js';

export type { ModerationAction };

export const MAX_REASON_LENGTH = 500;

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
}

const CASE_COLUMNS = `id, guild_id AS guildId, case_number AS caseNumber, action, target_id AS targetId,
  moderator_id AS moderatorId, reason, duration_ms AS durationMs, expires_at AS expiresAt, metadata,
  revoked, created_at AS createdAt`;

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
      .prepare<[string, string], number>(
        "SELECT COUNT(*) FROM moderation_cases WHERE guild_id = ? AND target_id = ? AND action = 'warn' AND revoked = 0",
      )
      .pluck(),
    revoke: db.prepare('UPDATE moderation_cases SET revoked = 1, metadata = @metadata WHERE id = @id'),
    getLogChannel: db
      .prepare<[string], string | null>('SELECT mod_log_channel_id FROM guild_settings WHERE guild_id = ?')
      .pluck(),
    setLogChannel: db.prepare(
      `INSERT INTO guild_settings (guild_id, mod_log_channel_id, created_at, updated_at)
       VALUES (@guildId, @channelId, @now, @now)
       ON CONFLICT (guild_id) DO UPDATE SET mod_log_channel_id = excluded.mod_log_channel_id, updated_at = excluded.updated_at`,
    ),
  };
}

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

  countActiveWarns(guildId: string, targetId: string): number {
    return this.stmts.activeWarns.get(guildId, targetId) ?? 0;
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
}
