import { randomUUID } from 'node:crypto';
import type { Db } from '../../../core/database/connection.js';
import { fail, type EconomyService, type EcoResult, type Ledger, type TransactionKind } from '../EconomyService.js';
import type { ProgressService, UnlockedAchievement } from '../progress/ProgressService.js';
import { assertStake } from './GamblingService.js';

export type WagerGame = 'blackjack' | 'roulette' | 'morpion' | 'puissance4';

/** Jeux contre la banque (« jeu d'argent ») ou entre membres (« duel »). */
const KINDS: Record<WagerGame, TransactionKind> = {
  blackjack: 'gamble',
  roulette: 'gamble',
  morpion: 'duel',
  puissance4: 'duel',
};

export const WAGER_LABELS: Record<WagerGame, string> = {
  blackjack: 'blackjack',
  roulette: 'roulette',
  morpion: 'morpion',
  puissance4: 'puissance 4',
};

export interface NewEntry {
  readonly userId: string;
  readonly stake: number;
  /** Détail du pari (roulette), stocké en JSON. */
  readonly bet?: unknown;
  /** Désigne le joueur dans les messages d'erreur (« Ton adversaire »). */
  readonly who?: string;
}

export interface WagerEntry {
  readonly userId: string;
  readonly stake: number;
  readonly bet: unknown;
}

export interface PlayerResult {
  readonly stake: number;
  readonly payout: number;
  readonly net: number;
  readonly balance: number;
  readonly unlocked: readonly UnlockedAchievement[];
}

/**
 * Mises en dépôt des jeux qui durent plus d'une interaction (blackjack, roulette,
 * morpion, puissance 4). La mise est prélevée à l'ouverture et versée au
 * règlement : une partie en cours n'existe qu'en mémoire, mais l'argent, lui,
 * est en base. Au démarrage, `refundOpen` rembourse les parties interrompues.
 */
export class WagerService {
  private readonly stmts;

  constructor(
    db: Db,
    private readonly eco: EconomyService,
    private readonly progress: ProgressService,
    private readonly clock: () => number = Date.now,
  ) {
    this.stmts = {
      insertWager: db.prepare('INSERT INTO wagers (id, guild_id, game, created_at) VALUES (?, ?, ?, ?)'),
      wager: db.prepare<[string], { guildId: string; game: WagerGame; settledAt: number | null }>(
        'SELECT guild_id AS guildId, game, settled_at AS settledAt FROM wagers WHERE id = ?',
      ),
      insertEntry: db.prepare('INSERT INTO wager_entries (wager_id, user_id, stake, bet) VALUES (?, ?, ?, ?)'),
      entries: db.prepare<[string], { userId: string; stake: number; bet: string | null }>(
        'SELECT user_id AS userId, stake, bet FROM wager_entries WHERE wager_id = ? ORDER BY id',
      ),
      settle: db.prepare('UPDATE wagers SET settled_at = ? WHERE id = ? AND settled_at IS NULL'),
      open: db.prepare<[], string>('SELECT id FROM wagers WHERE settled_at IS NULL ORDER BY created_at').pluck(),
    };
  }

  /** Ouvre une partie et prélève la mise de chaque joueur (tout ou rien). Renvoie l'id du dépôt. */
  open(guildId: string, game: WagerGame, entries: readonly NewEntry[]): EcoResult<string> {
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    return this.eco.transact((ledger) => {
      this.stmts.insertWager.run(id, guildId, game, this.clock());
      for (const e of entries) this.debit(ledger, id, guildId, game, e);
      return id;
    });
  }

  /** Ajoute une mise à une partie ouverte (double au blackjack, nouveau pari à la roulette). Renvoie le solde. */
  add(wagerId: string, entry: NewEntry): EcoResult<number> {
    return this.eco.transact((ledger) => {
      const wager = this.stmts.wager.get(wagerId);
      if (!wager || wager.settledAt !== null) fail('WAGER_CLOSED', 'Cette partie est terminée.');
      return this.debit(ledger, wagerId, wager.guildId, wager.game, entry);
    });
  }

  entries(wagerId: string): WagerEntry[] {
    return this.stmts.entries.all(wagerId).map((e) => ({ ...e, bet: e.bet === null ? null : (JSON.parse(e.bet) as unknown) }));
  }

  /**
   * Règle la partie : verse à chacun son gain total (mise comprise ; 0 = perdu,
   * mise = remboursé). Une seule fois : un second règlement échoue.
   */
  settle(wagerId: string, payouts: ReadonlyMap<string, number>): EcoResult<Map<string, PlayerResult>> {
    const r = this.eco.transact((ledger) => {
      const wager = this.stmts.wager.get(wagerId);
      if (!wager || wager.settledAt !== null) fail('WAGER_CLOSED', 'Cette partie est déjà réglée.');
      const stakes = this.stakesByUser(wagerId);
      const balances = new Map<string, number>();
      for (const [userId] of stakes) {
        const payout = payouts.get(userId) ?? 0;
        balances.set(
          userId,
          payout > 0
            ? ledger.apply({
                guildId: wager.guildId,
                userId,
                delta: payout,
                kind: KINDS[wager.game],
                reference: wagerId,
                note: `gain ${WAGER_LABELS[wager.game]}`,
              })
            : ledger.balance(wager.guildId, userId),
        );
      }
      this.stmts.settle.run(this.clock(), wagerId);
      return { wager, stakes, balances };
    });
    if (!r.ok) return r;

    const { wager, stakes, balances } = r.value;
    const results = new Map<string, PlayerResult>();
    for (const [userId, stake] of stakes) {
      const payout = payouts.get(userId) ?? 0;
      const net = payout - stake;
      const unlocked = this.progress.record(wager.guildId, userId, [
        { stat: 'wagered_total', add: stake },
        ...(net > 0
          ? ([
              { stat: KINDS[wager.game] === 'duel' ? 'duels_won' : 'gambles_won', add: 1 },
              { stat: 'biggest_win', max: net },
              { stat: 'best_multiplier', max: Math.floor(payout / stake) },
            ] as const)
          : []),
      ]);
      const balance = (balances.get(userId) ?? 0) + unlocked.reduce((sum, u) => sum + u.reward, 0);
      results.set(userId, { stake, payout, net, balance, unlocked });
    }
    return { ok: true, value: results };
  }

  /** Rembourse les mises des parties jamais réglées (bot arrêté en pleine partie). Renvoie le nombre de parties. */
  refundOpen(): number {
    let refunded = 0;
    for (const id of this.stmts.open.all()) {
      const r = this.eco.transact((ledger) => {
        const wager = this.stmts.wager.get(id);
        if (!wager || wager.settledAt !== null) return;
        for (const [userId, stake] of this.stakesByUser(id)) {
          ledger.apply({
            guildId: wager.guildId,
            userId,
            delta: stake,
            kind: KINDS[wager.game],
            reference: id,
            note: `remboursement ${WAGER_LABELS[wager.game]} (partie interrompue)`,
          });
        }
        this.stmts.settle.run(this.clock(), id);
        refunded++;
      });
      if (!r.ok) throw new Error(`Remboursement impossible pour la partie ${id} : ${r.error.message}`);
    }
    return refunded;
  }

  private debit(ledger: Ledger, wagerId: string, guildId: string, game: WagerGame, e: NewEntry): number {
    assertStake(ledger, guildId, e.userId, e.stake, e.who);
    const balance = ledger.apply({
      guildId,
      userId: e.userId,
      delta: -e.stake,
      kind: KINDS[game],
      reference: wagerId,
      note: `mise ${WAGER_LABELS[game]}`,
    });
    this.stmts.insertEntry.run(wagerId, e.userId, e.stake, e.bet === undefined ? null : JSON.stringify(e.bet));
    return balance;
  }

  private stakesByUser(wagerId: string): Map<string, number> {
    const stakes = new Map<string, number>();
    for (const e of this.stmts.entries.all(wagerId)) stakes.set(e.userId, (stakes.get(e.userId) ?? 0) + e.stake);
    return stakes;
  }
}
