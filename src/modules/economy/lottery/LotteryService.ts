import type { Db } from '../../../core/database/connection.js';
import { cryptoRng, type Rng } from '../../../core/rng.js';
import { nextWeekly, PARIS } from '../../../core/time.js';
import { fail, formatAmount, type EconomyService, type EcoResult } from '../EconomyService.js';
import type { EventSettingsStore } from '../eventsSettings.js';

/** Tirage le dimanche à 20 h, heure de Paris. */
export const DRAW_WEEKDAY = 0;
export const DRAW_HOUR = 20;
/** Part du prix des tickets versée dans la cagnotte ; le reste sort de l'économie. */
export const POT_SHARE = 0.9;
export const MAX_TICKETS_PER_PLAYER = 100;

export interface LotteryDraw {
  readonly id: number;
  readonly guildId: string;
  readonly drawsAt: number;
  readonly pot: number;
  readonly status: 'open' | 'drawn';
  readonly winnerId: string | null;
}

export interface TicketPurchase {
  readonly draw: LotteryDraw;
  readonly bought: number;
  readonly cost: number;
  readonly owned: number;
  readonly balance: number;
  /** Le tirage vient d'être ouvert par cet achat (il faut planifier son tirage). */
  readonly opened: boolean;
}

export interface DrawResult {
  readonly draw: LotteryDraw;
  readonly winnerId: string | null;
  readonly prize: number;
  readonly tickets: number;
  readonly players: number;
}

/** Tirage pondéré : chaque ticket a la même chance. `roll` dans [0, 1). */
export function pickWinner(entries: readonly { userId: string; count: number }[], roll: number): string | null {
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  if (total <= 0) return null;
  let target = Math.floor(roll * total);
  for (const e of entries) {
    if (target < e.count) return e.userId;
    target -= e.count;
  }
  return entries[entries.length - 1]?.userId ?? null;
}

const DRAW_COLUMNS = 'id, guild_id AS guildId, draws_at AS drawsAt, pot, status, winner_id AS winnerId';

/**
 * Loterie hebdomadaire : le premier ticket ouvre un tirage, prévu le dimanche
 * suivant à 20 h. La cagnotte reçoit 90 % du prix des tickets ; tout revient à un
 * seul gagnant, tiré au sort parmi les tickets.
 */
export class LotteryService {
  private readonly stmts;

  constructor(
    db: Db,
    private readonly eco: EconomyService,
    private readonly settings: EventSettingsStore,
    private readonly rng: Rng = cryptoRng,
    private readonly clock: () => number = Date.now,
  ) {
    this.stmts = {
      open: db.prepare<[string], LotteryDraw>(`SELECT ${DRAW_COLUMNS} FROM lottery_draws WHERE guild_id = ? AND status = 'open'`),
      byId: db.prepare<[number], LotteryDraw>(`SELECT ${DRAW_COLUMNS} FROM lottery_draws WHERE id = ?`),
      create: db.prepare('INSERT INTO lottery_draws (guild_id, draws_at) VALUES (?, ?)'),
      addPot: db.prepare('UPDATE lottery_draws SET pot = pot + ? WHERE id = ?'),
      addTickets: db.prepare(
        `INSERT INTO lottery_tickets (draw_id, user_id, count) VALUES (?, ?, ?)
         ON CONFLICT (draw_id, user_id) DO UPDATE SET count = count + excluded.count`,
      ),
      owned: db.prepare<[number, string], number>('SELECT count FROM lottery_tickets WHERE draw_id = ? AND user_id = ?').pluck(),
      entries: db.prepare<[number], { userId: string; count: number }>(
        'SELECT user_id AS userId, count FROM lottery_tickets WHERE draw_id = ? ORDER BY user_id',
      ),
      close: db.prepare(`UPDATE lottery_draws SET status = 'drawn', winner_id = ?, drawn_at = ? WHERE id = ? AND status = 'open'`),
    };
  }

  current(guildId: string): LotteryDraw | null {
    return this.stmts.open.get(guildId) ?? null;
  }

  draw(id: number): LotteryDraw | null {
    return this.stmts.byId.get(id) ?? null;
  }

  ticketsOf(drawId: number, userId: string): number {
    return this.stmts.owned.get(drawId, userId) ?? 0;
  }

  entries(drawId: number): { userId: string; count: number }[] {
    return this.stmts.entries.all(drawId);
  }

  buy(guildId: string, userId: string, count: number): EcoResult<TicketPurchase> {
    return this.eco.transact((ledger) => {
      const { ticketPrice } = this.settings.get(guildId);
      const { currencyName } = ledger.settings(guildId);
      if (ticketPrice <= 0) fail('GAMBLING_DISABLED', 'La loterie est désactivée sur ce serveur.');
      if (!Number.isSafeInteger(count) || count < 1) fail('INVALID_QUANTITY', 'Nombre de tickets invalide.');

      let draw = this.current(guildId);
      const opened = draw === null;
      if (!draw) {
        const { lastInsertRowid } = this.stmts.create.run(guildId, nextWeekly(this.clock(), DRAW_WEEKDAY, DRAW_HOUR, PARIS));
        draw = this.stmts.byId.get(Number(lastInsertRowid))!;
      }
      const already = this.ticketsOf(draw.id, userId);
      if (already + count > MAX_TICKETS_PER_PLAYER) {
        fail('INVALID_QUANTITY', `${MAX_TICKETS_PER_PLAYER} tickets au plus par tirage (tu en as déjà ${already}).`);
      }
      const cost = ticketPrice * count;
      if (ledger.balance(guildId, userId) < cost) {
        fail('INSUFFICIENT_FUNDS', `Il te faut ${formatAmount(cost, currencyName)} pour ${count} ticket(s).`);
      }
      const balance = ledger.apply({
        guildId,
        userId,
        delta: -cost,
        kind: 'lottery',
        reference: String(draw.id),
        note: `${count} ticket(s)`,
      });
      this.stmts.addTickets.run(draw.id, userId, count);
      this.stmts.addPot.run(Math.floor(cost * POT_SHARE), draw.id);
      return { draw: this.stmts.byId.get(draw.id)!, bought: count, cost, owned: already + count, balance, opened };
    });
  }

  /**
   * Effectue le tirage : désigne le gagnant et lui verse la cagnotte, en une seule
   * transaction. Sans effet (null) si le tirage n'existe pas ou a déjà eu lieu.
   */
  runDraw(drawId: number): EcoResult<DrawResult | null> {
    const roll = this.rng();
    return this.eco.transact((ledger) => {
      const draw = this.draw(drawId);
      if (!draw || draw.status !== 'open') return null;
      const entries = this.entries(drawId);
      const winnerId = pickWinner(entries, roll);
      if (winnerId && draw.pot > 0) {
        ledger.apply({
          guildId: draw.guildId,
          userId: winnerId,
          delta: draw.pot,
          kind: 'lottery',
          reference: String(draw.id),
          note: 'gain à la loterie',
        });
      }
      this.stmts.close.run(winnerId, this.clock(), drawId);
      return {
        draw: { ...draw, status: 'drawn' as const, winnerId },
        winnerId,
        prize: winnerId ? draw.pot : 0,
        tickets: entries.reduce((sum, e) => sum + e.count, 0),
        players: entries.length,
      };
    });
  }
}

/** Clé de la tâche de tirage d'un serveur (un tirage ouvert à la fois). */
export const lotteryJobKey = (guildId: string): string => `lottery:${guildId}`;
