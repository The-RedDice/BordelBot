import type { Db } from '../../../core/database/connection.js';
import { cryptoRng, type Rng } from '../../../core/rng.js';
import { fail, formatAmount, type EconomyService, type EcoResult } from '../EconomyService.js';
import type { EconomyExtrasStore } from '../extras.js';

const HOUR = 3_600_000;
/** Délai entre deux braquages d'un même membre. */
export const HEIST_COOLDOWN_MS = 4 * HOUR;
/** Une cible ne peut être visée qu'une fois sur cette durée (réussite ou échec). */
export const HEIST_TARGET_PROTECTION_MS = 12 * HOUR;
/** En dessous, la cible n'a rien qui vaille le coup. */
export const MIN_TARGET_BALANCE = 100;
/** Il faut de quoi payer l'amende : on ne braque pas sans rien risquer. */
export const MIN_ROBBER_BALANCE = 100;
export const MIN_CHANCE = 0.3;
export const MAX_CHANCE = 0.6;
export const MIN_STEAL_SHARE = 0.05;
export const MAX_STEAL_SHARE = 0.15;
export const FINE_SHARE = 0.1;

/**
 * Chances de réussite : 30 % contre une cible bien plus pauvre que soi, 60 %
 * contre une cible bien plus riche, 45 % à fortune égale.
 */
export function heistChance(targetBalance: number, robberBalance: number): number {
  const total = targetBalance + robberBalance;
  const share = total > 0 ? targetBalance / total : 0.5;
  return MIN_CHANCE + (MAX_CHANCE - MIN_CHANCE) * share;
}

/** Butin : de 5 à 15 % du solde de la cible, plafonné. Au moins 1. */
export function heistLoot(roll: number, targetBalance: number, cap: number): number {
  const share = MIN_STEAL_SHARE + (MAX_STEAL_SHARE - MIN_STEAL_SHARE) * roll;
  return Math.max(1, Math.min(cap, Math.floor(targetBalance * share)));
}

/** Amende en cas d'échec : 10 % du solde du braqueur, au moins 1, versée à la cible. */
export function heistFine(robberBalance: number): number {
  return Math.max(1, Math.floor(robberBalance * FINE_SHARE));
}

export interface HeistResult {
  readonly success: boolean;
  /** Butin ou amende. */
  readonly amount: number;
  readonly chance: number;
  readonly robberBalance: number;
  readonly targetBalance: number;
}

/** Braquages entre membres : chaque tentative est une transaction (argent + historique des tentatives). */
export class HeistService {
  private readonly stmts;

  constructor(
    db: Db,
    private readonly eco: EconomyService,
    private readonly extras: EconomyExtrasStore,
    private readonly rng: Rng = cryptoRng,
    private readonly clock: () => number = Date.now,
  ) {
    this.stmts = {
      lastByRobber: db
        .prepare<[string, string], number>('SELECT MAX(at) FROM heists WHERE guild_id = ? AND robber_id = ?')
        .pluck(),
      lastOnTarget: db
        .prepare<[string, string], number>('SELECT MAX(at) FROM heists WHERE guild_id = ? AND target_id = ?')
        .pluck(),
      insert: db.prepare(
        'INSERT INTO heists (guild_id, robber_id, target_id, success, amount, at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
    };
  }

  /** Moment où ce membre pourra de nouveau braquer (null s'il le peut déjà). */
  nextAttemptAt(guildId: string, robberId: string): number | null {
    const last = this.stmts.lastByRobber.get(guildId, robberId) ?? null;
    return last !== null && this.clock() - last < HEIST_COOLDOWN_MS ? last + HEIST_COOLDOWN_MS : null;
  }

  attempt(guildId: string, robberId: string, targetId: string): EcoResult<HeistResult> {
    const roll = this.rng();
    const lootRoll = this.rng();
    return this.eco.transact((ledger) => {
      const { heistEnabled, heistCap } = this.extras.get(guildId);
      const { currencyName } = ledger.settings(guildId);
      if (!heistEnabled) fail('HEIST_UNAVAILABLE', 'Les braquages sont désactivés sur ce serveur.');
      if (robberId === targetId) fail('SELF_TRANSFER', 'Tu ne peux pas te braquer toi-même.');
      const now = this.clock();

      const next = this.nextAttemptAt(guildId, robberId);
      if (next !== null) fail('HEIST_UNAVAILABLE', `Tu dois te faire oublier : prochain braquage possible <t:${Math.ceil(next / 1000)}:R>.`);
      const lastOnTarget = this.stmts.lastOnTarget.get(guildId, targetId) ?? null;
      if (lastOnTarget !== null && now - lastOnTarget < HEIST_TARGET_PROTECTION_MS) {
        const until = Math.ceil((lastOnTarget + HEIST_TARGET_PROTECTION_MS) / 1000);
        fail('HEIST_UNAVAILABLE', `Cette cible a déjà été visée récemment : elle est sur ses gardes jusqu’à <t:${until}:R>.`);
      }

      const robberBalance = ledger.balance(guildId, robberId);
      const targetBalance = ledger.balance(guildId, targetId);
      if (robberBalance < MIN_ROBBER_BALANCE) {
        fail('HEIST_UNAVAILABLE', `Il te faut au moins ${formatAmount(MIN_ROBBER_BALANCE, currencyName)} pour payer l’amende si ça tourne mal.`);
      }
      if (targetBalance < MIN_TARGET_BALANCE) fail('HEIST_UNAVAILABLE', 'Cette cible n’a presque rien : ça ne vaut pas le risque.');

      const chance = heistChance(targetBalance, robberBalance);
      const success = roll < chance;
      const amount = success ? heistLoot(lootRoll, targetBalance, heistCap) : heistFine(robberBalance);
      const [from, to] = success ? [targetId, robberId] : [robberId, targetId];
      const note = success ? 'braquage réussi' : 'braquage raté (amende)';
      const fromBalance = ledger.apply({ guildId, userId: from, delta: -amount, kind: 'heist', counterpartyId: to, note });
      const toBalance = ledger.apply({ guildId, userId: to, delta: amount, kind: 'heist', counterpartyId: from, note });
      this.stmts.insert.run(guildId, robberId, targetId, success ? 1 : 0, amount, now);
      return {
        success,
        amount,
        chance,
        robberBalance: success ? toBalance : fromBalance,
        targetBalance: success ? fromBalance : toBalance,
      };
    });
  }
}
