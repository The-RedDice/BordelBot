import { cryptoRng, type Rng } from '../../../core/rng.js';
import { fail, formatAmount, MAX_AMOUNT, type EconomyService, type EcoResult, type Ledger } from '../EconomyService.js';
import type { ProgressService, UnlockedAchievement } from '../progress/ProgressService.js';
import { COIN_MULTIPLIER, flipCoin, spinSlots, type CoinSide, type SlotSpin } from './games.js';

export interface BetOutcome {
  readonly stake: number;
  /** Gain total versé (mise comprise) ; 0 si perdu. */
  readonly payout: number;
  /** Variation du solde : payout − mise. */
  readonly net: number;
  readonly balance: number;
  readonly unlocked: readonly UnlockedAchievement[];
}

export interface CoinFlipOutcome extends BetOutcome {
  readonly side: CoinSide;
  readonly won: boolean;
}

export interface SlotsOutcome extends BetOutcome {
  readonly spin: SlotSpin;
}

export interface DuelOutcome {
  readonly stake: number;
  readonly winnerId: string;
  readonly loserId: string;
  readonly winnerBalance: number;
  readonly loserBalance: number;
  readonly unlocked: ReadonlyMap<string, readonly UnlockedAchievement[]>;
}

/**
 * Jeux d'argent. Chaque partie est une transaction unique : la mise est vérifiée
 * puis le résultat net est appliqué au solde, avec une ligne dans le journal.
 */
export class GamblingService {
  constructor(
    private readonly eco: EconomyService,
    private readonly progress: ProgressService,
    private readonly rng: Rng = cryptoRng,
  ) {}

  coinFlip(guildId: string, userId: string, stake: number, call: CoinSide): EcoResult<CoinFlipOutcome> {
    const side = flipCoin(this.rng);
    const won = side === call;
    const payout = won ? stake * COIN_MULTIPLIER : 0;
    const r = this.eco.transact((ledger) =>
      this.settle(ledger, guildId, userId, stake, payout, `pile ou face : ${side}`),
    );
    if (!r.ok) return r;
    return { ok: true, value: { ...this.finish(guildId, userId, stake, payout, r.value), side, won } };
  }

  slots(guildId: string, userId: string, stake: number): EcoResult<SlotsOutcome> {
    const spin = spinSlots(this.rng);
    const payout = stake * spin.multiplier;
    const note = `machine à sous : ${spin.reels.map((s) => s.emoji).join('')}`;
    const r = this.eco.transact((ledger) => this.settle(ledger, guildId, userId, stake, payout, note));
    if (!r.ok) return r;
    return { ok: true, value: { ...this.finish(guildId, userId, stake, payout, r.value), spin } };
  }

  /** Vérifie, sans rien débiter, qu'un membre peut engager cette mise (avant de proposer un duel). */
  checkStake(guildId: string, userId: string, stake: number): EcoResult<void> {
    return this.eco.transact((ledger) => this.assertStake(ledger, guildId, userId, stake));
  }

  /** Pile ou face entre deux membres : le gagnant prend la mise de l'autre. */
  duel(guildId: string, challengerId: string, opponentId: string, stake: number): EcoResult<DuelOutcome> {
    const challengerWins = this.rng() < 0.5;
    const winnerId = challengerWins ? challengerId : opponentId;
    const loserId = challengerWins ? opponentId : challengerId;
    const r = this.eco.transact((ledger) => {
      if (challengerId === opponentId) fail('SELF_TRANSFER', 'Tu ne peux pas te défier toi-même.');
      this.assertStake(ledger, guildId, challengerId, stake, 'Le lanceur du défi');
      this.assertStake(ledger, guildId, opponentId, stake, 'Ton adversaire');
      const loserBalance = ledger.apply({
        guildId,
        userId: loserId,
        delta: -stake,
        kind: 'duel',
        counterpartyId: winnerId,
        note: 'duel perdu',
      });
      const winnerBalance = ledger.apply({
        guildId,
        userId: winnerId,
        delta: stake,
        kind: 'duel',
        counterpartyId: loserId,
        note: 'duel gagné',
      });
      return { winnerBalance, loserBalance };
    });
    if (!r.ok) return r;

    const unlocked = new Map<string, readonly UnlockedAchievement[]>([
      [
        winnerId,
        this.progress.record(guildId, winnerId, [
          { stat: 'wagered_total', add: stake },
          { stat: 'duels_won', add: 1 },
          { stat: 'biggest_win', max: stake },
          { stat: 'best_multiplier', max: 2 },
        ]),
      ],
      [loserId, this.progress.record(guildId, loserId, [{ stat: 'wagered_total', add: stake }])],
    ]);
    const rewards = (id: string) => (unlocked.get(id) ?? []).reduce((sum, u) => sum + u.reward, 0);
    return {
      ok: true,
      value: {
        stake,
        winnerId,
        loserId,
        winnerBalance: r.value.winnerBalance + rewards(winnerId),
        loserBalance: r.value.loserBalance + rewards(loserId),
        unlocked,
      },
    };
  }

  private assertStake(ledger: Ledger, guildId: string, userId: string, stake: number, who?: string): void {
    const { maxBet, currencyName } = ledger.settings(guildId);
    if (maxBet <= 0) fail('GAMBLING_DISABLED', 'Les jeux d’argent sont désactivés sur ce serveur.');
    if (!Number.isSafeInteger(stake) || stake < 1 || stake > MAX_AMOUNT) {
      fail('INVALID_AMOUNT', 'La mise doit être un entier positif.');
    }
    if (stake > maxBet) fail('BET_TOO_HIGH', `La mise maximale est de ${formatAmount(maxBet, currencyName)}.`);
    const balance = ledger.balance(guildId, userId);
    if (balance < stake) {
      const subject = who ? `${who} n’a` : 'Tu n’as';
      fail('INSUFFICIENT_FUNDS', `${subject} que ${formatAmount(balance, currencyName)} : mise impossible.`);
    }
  }

  private settle(ledger: Ledger, guildId: string, userId: string, stake: number, payout: number, note: string): number {
    this.assertStake(ledger, guildId, userId, stake);
    const net = payout - stake;
    // Un gain nul (mise remboursée) ne crée pas de ligne vide dans le journal.
    if (net === 0) return ledger.balance(guildId, userId);
    return ledger.apply({ guildId, userId, delta: net, kind: 'gamble', note });
  }

  private finish(guildId: string, userId: string, stake: number, payout: number, balance: number): BetOutcome {
    const net = payout - stake;
    const unlocked = this.progress.record(guildId, userId, [
      { stat: 'wagered_total', add: stake },
      ...(net > 0
        ? ([
            { stat: 'gambles_won', add: 1 },
            { stat: 'biggest_win', max: net },
            { stat: 'best_multiplier', max: Math.floor(payout / stake) },
          ] as const)
        : []),
    ]);
    // Le succès peut avoir versé une récompense : le solde affiché doit l'inclure.
    const finalBalance = balance + unlocked.reduce((sum, u) => sum + u.reward, 0);
    return { stake, payout, net, balance: finalBalance, unlocked };
  }
}
