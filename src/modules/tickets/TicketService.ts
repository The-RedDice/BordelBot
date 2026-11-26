import type { Db } from '../../core/database/connection.js';

export interface TicketSettings {
  readonly categoryId: string | null;
  readonly staffRoleId: string | null;
  readonly transcriptChannelId: string | null;
  readonly welcomeMessage: string | null;
}

export const DEFAULT_TICKET_SETTINGS: TicketSettings = {
  categoryId: null,
  staffRoleId: null,
  transcriptChannelId: null,
  welcomeMessage: null,
};

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_WELCOME_LENGTH = 1000;
export const MAX_REASON_LENGTH = 300;

export interface Ticket {
  readonly id: number;
  readonly guildId: string;
  readonly number: number;
  readonly channelId: string;
  readonly openerId: string;
  readonly subject: string;
  readonly status: 'open' | 'closed';
  readonly claimedBy: string | null;
  readonly createdAt: number;
  readonly closedAt: number | null;
  readonly closedBy: string | null;
  readonly closeReason: string | null;
}

const COLUMNS = `id, guild_id AS guildId, number, channel_id AS channelId, opener_id AS openerId, subject, status,
  claimed_by AS claimedBy, created_at AS createdAt, closed_at AS closedAt, closed_by AS closedBy, close_reason AS closeReason`;

/** Tickets et réglages. Ne parle pas à Discord : la couche Discord crée le salon, puis enregistre le ticket. */
export class TicketService {
  private readonly stmts;

  constructor(
    db: Db,
    private readonly clock: () => number = Date.now,
  ) {
    this.stmts = {
      settings: db.prepare<[string], TicketSettings>(
        `SELECT category_id AS categoryId, staff_role_id AS staffRoleId, transcript_channel_id AS transcriptChannelId,
                welcome_message AS welcomeMessage
         FROM ticket_settings WHERE guild_id = ?`,
      ),
      saveSettings: db.prepare(
        `INSERT INTO ticket_settings (guild_id, category_id, staff_role_id, transcript_channel_id, welcome_message)
         VALUES (@guildId, @categoryId, @staffRoleId, @transcriptChannelId, @welcomeMessage)
         ON CONFLICT (guild_id) DO UPDATE SET category_id = excluded.category_id, staff_role_id = excluded.staff_role_id,
           transcript_channel_id = excluded.transcript_channel_id, welcome_message = excluded.welcome_message`,
      ),
      nextNumber: db
        .prepare<[string], number>('SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE guild_id = ?')
        .pluck(),
      insert: db.prepare(
        `INSERT INTO tickets (guild_id, number, channel_id, opener_id, subject, created_at)
         VALUES (@guildId, @number, @channelId, @openerId, @subject, @now)`,
      ),
      byId: db.prepare<[number], Ticket>(`SELECT ${COLUMNS} FROM tickets WHERE id = ?`),
      byChannel: db.prepare<[string], Ticket>(`SELECT ${COLUMNS} FROM tickets WHERE channel_id = ?`),
      openOf: db.prepare<[string, string], Ticket>(
        `SELECT ${COLUMNS} FROM tickets WHERE guild_id = ? AND opener_id = ? AND status = 'open'`,
      ),
      claim: db.prepare(`UPDATE tickets SET claimed_by = ? WHERE id = ? AND status = 'open'`),
      close: db.prepare(
        `UPDATE tickets SET status = 'closed', closed_at = @now, closed_by = @by, close_reason = @reason
         WHERE id = @id AND status = 'open'`,
      ),
      countOpen: db.prepare<[string], number>(`SELECT COUNT(*) FROM tickets WHERE guild_id = ? AND status = 'open'`).pluck(),
    };
  }

  getSettings(guildId: string): TicketSettings {
    return this.stmts.settings.get(guildId) ?? DEFAULT_TICKET_SETTINGS;
  }

  setSettings(guildId: string, s: TicketSettings): void {
    const welcomeMessage = s.welcomeMessage?.trim().slice(0, MAX_WELCOME_LENGTH) || null;
    this.stmts.saveSettings.run({ guildId, ...s, welcomeMessage });
  }

  /** Ticket encore ouvert de ce membre, s'il en a un. */
  openTicketOf(guildId: string, openerId: string): Ticket | null {
    return this.stmts.openOf.get(guildId, openerId) ?? null;
  }

  nextNumber(guildId: string): number {
    return this.stmts.nextNumber.get(guildId) ?? 1;
  }

  countOpen(guildId: string): number {
    return this.stmts.countOpen.get(guildId) ?? 0;
  }

  /** Enregistre un ticket dont le salon vient d'être créé. Lève si le membre a déjà un ticket ouvert. */
  create(input: { guildId: string; number: number; channelId: string; openerId: string; subject: string }): Ticket {
    const subject = input.subject.trim().slice(0, MAX_SUBJECT_LENGTH) || 'Sans sujet';
    const { lastInsertRowid } = this.stmts.insert.run({ ...input, subject, now: this.clock() });
    return this.stmts.byId.get(Number(lastInsertRowid))!;
  }

  byChannel(channelId: string): Ticket | null {
    return this.stmts.byChannel.get(channelId) ?? null;
  }

  byId(id: number): Ticket | null {
    return this.stmts.byId.get(id) ?? null;
  }

  claim(id: number, staffId: string): boolean {
    return this.stmts.claim.run(staffId, id).changes > 0;
  }

  /** Ferme le ticket ; false s'il l'était déjà (deux fermetures simultanées). */
  close(id: number, by: string | null, reason: string | null): boolean {
    const clean = reason?.trim().slice(0, MAX_REASON_LENGTH) || null;
    return this.stmts.close.run({ id, by, reason: clean, now: this.clock() }).changes > 0;
  }
}

/** Nom du salon : « ticket-42-pseudo » (minuscules, sans accents ni caractères spéciaux, 100 caractères max). */
export function ticketChannelName(number: number, username: string): string {
  const slug = username
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  return `ticket-${number}${slug ? `-${slug}` : ''}`;
}

export interface TranscriptMessage {
  readonly authorTag: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly content: string;
  readonly attachments: readonly string[];
  readonly bot: boolean;
}

/** Transcription texte d'un ticket, du plus ancien au plus récent. */
export function ticketTranscript(ticket: Ticket, guildName: string, messages: readonly TranscriptMessage[]): string {
  const iso = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const header = [
    `Ticket #${ticket.number} — ${guildName}`,
    `Sujet : ${ticket.subject}`,
    `Ouvert par ${ticket.openerId} le ${iso(ticket.createdAt)} UTC`,
    ticket.claimedBy ? `Pris en charge par ${ticket.claimedBy}` : null,
    ticket.closedAt ? `Fermé par ${ticket.closedBy ?? '?'} le ${iso(ticket.closedAt)} UTC${ticket.closeReason ? ` : ${ticket.closeReason}` : ''}` : null,
    `${messages.length} message(s)`,
    '',
  ].filter((l): l is string => l !== null);
  const lines = [...messages]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => {
      const files = m.attachments.length ? ` [pièces jointes : ${m.attachments.join(', ')}]` : '';
      return `[${iso(m.createdAt)} UTC] ${m.authorTag}${m.bot ? ' (bot)' : ''} (${m.authorId}) : ${m.content}${files}`;
    });
  return [...header, ...lines].join('\n');
}
