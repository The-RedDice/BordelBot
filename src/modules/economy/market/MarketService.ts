import type { Db } from '../../../core/database/connection.js';
import type { Logger } from '../../../core/logger.js';
import { cryptoRng, type Rng } from '../../../core/rng.js';
import { fail, formatAmount, MAX_AMOUNT, type EconomyService, type EcoResult } from '../EconomyService.js';
import type { ProgressService, UnlockedAchievement } from '../progress/ProgressService.js';
import { ASSETS_BY_SYMBOL, MARKET_ASSETS, type MarketAsset } from './assets.js';
import { nextPrice } from './model.js';

export const MARKET_TICK_MS = 5 * 60_000;
/** Historique conservé (et rattrapé après une coupure) : 30 jours. */
export const MARKET_HISTORY_MS = 30 * 24 * 3_600_000;
/** Frais de courtage, prélevés à l'achat comme à la vente (minimum 1). */
export const MARKET_FEE_RATE = 0.01;
export const MAX_TRADE_QUANTITY = 1_000_000;

export interface Quote {
  readonly asset: MarketAsset;
  readonly price: number;
  readonly at: number;
  /** Variations relatives (0.05 = +5 %), null sans historique suffisant. */
  readonly change1h: number | null;
  readonly change24h: number | null;
}

export interface PricePoint {
  readonly at: number;
  readonly price: number;
}

export interface NewsItem {
  readonly asset: MarketAsset;
  readonly at: number;
  readonly change: number;
  readonly headline: string;
}

export interface Trade {
  readonly asset: MarketAsset;
  readonly quantity: number;
  readonly price: number;
  /** Montant des titres, hors frais. */
  readonly gross: number;
  readonly fee: number;
  /** Achat : total débité. Vente : total crédité. */
  readonly total: number;
  /** Vente uniquement : plus-value réalisée (négative en cas de perte). */
  readonly profit: number | null;
  readonly balance: number;
  readonly remaining: number;
  readonly unlocked: readonly UnlockedAchievement[];
}

export interface Position {
  readonly asset: MarketAsset;
  readonly quantity: number;
  readonly price: number;
  readonly value: number;
  readonly costBasis: number;
  readonly profit: number;
}

export interface Portfolio {
  readonly positions: readonly Position[];
  readonly value: number;
  readonly costBasis: number;
}

export const tradeFee = (amount: number): number => Math.max(1, Math.ceil(amount * MARKET_FEE_RATE));

function prepareStatements(db: Db) {
  return {
    last: db.prepare<[string], PricePoint>('SELECT at, price FROM market_prices WHERE symbol = ? ORDER BY at DESC LIMIT 1'),
    atOrBefore: db.prepare<[string, number], PricePoint>(
      'SELECT at, price FROM market_prices WHERE symbol = ? AND at <= ? ORDER BY at DESC LIMIT 1',
    ),
    since: db.prepare<[string, number], PricePoint>(
      'SELECT at, price FROM market_prices WHERE symbol = ? AND at >= ? ORDER BY at',
    ),
    insertPrice: db.prepare('INSERT OR IGNORE INTO market_prices (symbol, at, price) VALUES (?, ?, ?)'),
    insertNews: db.prepare('INSERT INTO market_news (symbol, at, change, headline) VALUES (?, ?, ?, ?)'),
    news: db.prepare<[number], { symbol: string; at: number; change: number; headline: string }>(
      'SELECT symbol, at, change, headline FROM market_news ORDER BY at DESC, id DESC LIMIT ?',
    ),
    prunePrices: db.prepare('DELETE FROM market_prices WHERE at < ?'),
    pruneNews: db.prepare('DELETE FROM market_news WHERE at < ?'),
    holding: db.prepare<[string, string, string], { quantity: number; costBasis: number }>(
      `SELECT quantity, cost_basis AS costBasis FROM market_holdings WHERE guild_id = ? AND user_id = ? AND symbol = ?`,
    ),
    holdings: db.prepare<[string, string], { symbol: string; quantity: number; costBasis: number }>(
      `SELECT symbol, quantity, cost_basis AS costBasis FROM market_holdings
       WHERE guild_id = ? AND user_id = ? ORDER BY symbol`,
    ),
    upsertHolding: db.prepare(
      `INSERT INTO market_holdings (guild_id, user_id, symbol, quantity, cost_basis, updated_at)
       VALUES (@guildId, @userId, @symbol, @quantity, @costBasis, @now)
       ON CONFLICT (guild_id, user_id, symbol) DO UPDATE SET
         quantity = excluded.quantity, cost_basis = excluded.cost_basis, updated_at = excluded.updated_at`,
    ),
    deleteHolding: db.prepare('DELETE FROM market_holdings WHERE guild_id = ? AND user_id = ? AND symbol = ?'),
  };
}

export interface MarketServiceOptions {
  readonly clock?: () => number;
  readonly rng?: Rng;
  readonly logger?: Logger;
}

/**
 * Bourse fictive. Les cours sont communs à tous les serveurs et avancent d'un
 * tick toutes les 5 minutes ; les portefeuilles et l'argent restent propres à
 * chaque serveur. Achats et ventes passent par le grand livre de l'économie.
 */
export class MarketService {
  private readonly stmts: ReturnType<typeof prepareStatements>;
  private readonly clock: () => number;
  private readonly rng: Rng;
  private readonly logger: Logger | undefined;

  constructor(
    private readonly db: Db,
    private readonly eco: EconomyService,
    private readonly progress: ProgressService,
    options: MarketServiceOptions = {},
  ) {
    this.stmts = prepareStatements(db);
    this.clock = options.clock ?? Date.now;
    this.rng = options.rng ?? cryptoRng;
    this.logger = options.logger;
  }

  // ----- Évolution des cours -----

  /**
   * Amène chaque actif jusqu'au dernier tick échu : premier cours au prix de
   * référence, puis simulation des ticks manqués pendant un arrêt du bot (30 jours
   * au plus), pour que le graphique reste continu. Renvoie le nombre de ticks écrits.
   */
  advance(): number {
    const now = this.clock();
    const target = Math.floor(now / MARKET_TICK_MS) * MARKET_TICK_MS;
    let written = 0;
    this.db.transaction(() => {
      for (const asset of MARKET_ASSETS) {
        let last = this.stmts.last.get(asset.symbol);
        if (!last) {
          last = { at: target, price: asset.basePrice };
          this.stmts.insertPrice.run(asset.symbol, last.at, last.price);
          written++;
          continue;
        }
        let at = Math.max(last.at, target - MARKET_HISTORY_MS);
        let price = last.price;
        while (at + MARKET_TICK_MS <= target) {
          at += MARKET_TICK_MS;
          const step = nextPrice(asset, price, this.rng);
          price = step.price;
          this.stmts.insertPrice.run(asset.symbol, at, price);
          if (step.news) this.stmts.insertNews.run(asset.symbol, at, step.news.change, step.news.headline);
          written++;
        }
      }
      this.stmts.prunePrices.run(now - MARKET_HISTORY_MS);
      this.stmts.pruneNews.run(now - MARKET_HISTORY_MS);
    })();
    if (written > MARKET_ASSETS.length) this.logger?.debug(`Bourse : ${written} cours écrits`);
    return written;
  }

  // ----- Lecture -----

  getAsset(symbol: string): MarketAsset | undefined {
    return ASSETS_BY_SYMBOL.get(symbol.trim().toUpperCase());
  }

  quote(asset: MarketAsset): Quote {
    const last = this.stmts.last.get(asset.symbol) ?? { at: this.clock(), price: asset.basePrice };
    const changeSince = (ms: number): number | null => {
      const ref = this.stmts.atOrBefore.get(asset.symbol, last.at - ms);
      return ref ? last.price / ref.price - 1 : null;
    };
    return { asset, price: last.price, at: last.at, change1h: changeSince(3_600_000), change24h: changeSince(86_400_000) };
  }

  quotes(): Quote[] {
    return MARKET_ASSETS.map((a) => this.quote(a));
  }

  /** Cours depuis `sinceMs` avant le dernier tick, réduits à `maxPoints` au plus. */
  history(asset: MarketAsset, periodMs: number, maxPoints = 300): PricePoint[] {
    const last = this.stmts.last.get(asset.symbol);
    if (!last) return [];
    const points = this.stmts.since.all(asset.symbol, last.at - periodMs);
    if (points.length <= maxPoints) return points;
    const step = points.length / maxPoints;
    const sampled: PricePoint[] = [];
    for (let i = 0; i < maxPoints; i++) sampled.push(points[Math.floor(i * step)] as PricePoint);
    sampled[sampled.length - 1] = points[points.length - 1] as PricePoint; // toujours finir sur le dernier cours
    return sampled;
  }

  news(limit = 5): NewsItem[] {
    return this.stmts.news.all(limit).flatMap((n) => {
      const asset = ASSETS_BY_SYMBOL.get(n.symbol);
      return asset ? [{ asset, at: n.at, change: n.change, headline: n.headline }] : [];
    });
  }

  portfolio(guildId: string, userId: string): Portfolio {
    const positions = this.stmts.holdings.all(guildId, userId).flatMap((h) => {
      const asset = ASSETS_BY_SYMBOL.get(h.symbol);
      if (!asset) return [];
      const { price } = this.quote(asset);
      const value = Math.floor(h.quantity * price);
      return [{ asset, quantity: h.quantity, price, value, costBasis: h.costBasis, profit: value - h.costBasis }];
    });
    return {
      positions,
      value: positions.reduce((s, p) => s + p.value, 0),
      costBasis: positions.reduce((s, p) => s + p.costBasis, 0),
    };
  }

  // ----- Ordres -----

  buy(guildId: string, userId: string, symbol: string, quantity: number): EcoResult<Trade> {
    const r = this.eco.transact((ledger) => {
      const asset = this.requireAsset(symbol);
      this.assertQuantity(quantity);
      const { price } = this.quote(asset);
      const gross = Math.ceil(quantity * price);
      const fee = tradeFee(gross);
      const total = gross + fee;
      if (total > MAX_AMOUNT) fail('INVALID_AMOUNT', 'Ordre trop important.');
      const balance = ledger.apply({
        guildId,
        userId,
        delta: -total,
        kind: 'market_buy',
        reference: asset.symbol,
        note: `${quantity} ${asset.symbol} à ${price}`,
      });
      const held = this.stmts.holding.get(guildId, userId, asset.symbol);
      const remaining = (held?.quantity ?? 0) + quantity;
      if (remaining > MAX_TRADE_QUANTITY) {
        fail('INVALID_QUANTITY', `Tu ne peux pas détenir plus de ${MAX_TRADE_QUANTITY} titres ${asset.symbol}.`);
      }
      this.stmts.upsertHolding.run({
        guildId,
        userId,
        symbol: asset.symbol,
        quantity: remaining,
        costBasis: (held?.costBasis ?? 0) + total,
        now: ledger.now(),
      });
      return { asset, quantity, price, gross, fee, total, profit: null, balance, remaining };
    });
    if (!r.ok) return r;
    const unlocked = this.progress.record(guildId, userId, [{ stat: 'market_trades', add: 1 }]);
    return { ok: true, value: this.withRewards(r.value, unlocked) };
  }

  /** `quantity` null : vend toute la position. */
  sell(guildId: string, userId: string, symbol: string, quantity: number | null): EcoResult<Trade> {
    const r = this.eco.transact((ledger) => {
      const asset = this.requireAsset(symbol);
      const held = this.stmts.holding.get(guildId, userId, asset.symbol);
      if (!held) fail('INSUFFICIENT_SHARES', `Tu ne possèdes aucun titre ${asset.symbol}.`);
      const qty = quantity ?? held.quantity;
      this.assertQuantity(qty);
      if (qty > held.quantity) {
        fail('INSUFFICIENT_SHARES', `Tu ne possèdes que ${held.quantity} titre(s) ${asset.symbol}.`);
      }
      const { price } = this.quote(asset);
      const gross = Math.floor(qty * price);
      const fee = tradeFee(gross);
      const total = gross - fee;
      if (total < 1) {
        const { currencyName } = ledger.settings(guildId);
        fail('TRADE_TOO_SMALL', `Vente trop petite : les frais (${formatAmount(fee, currencyName)}) dépassent le montant.`);
      }
      // Prix de revient au prorata des titres vendus.
      const soldBasis = qty === held.quantity ? held.costBasis : Math.round((held.costBasis * qty) / held.quantity);
      const profit = total - soldBasis;
      const balance = ledger.apply({
        guildId,
        userId,
        delta: total,
        kind: 'market_sell',
        reference: asset.symbol,
        note: `${qty} ${asset.symbol} à ${price}`,
      });
      const remaining = held.quantity - qty;
      if (remaining === 0) this.stmts.deleteHolding.run(guildId, userId, asset.symbol);
      else {
        this.stmts.upsertHolding.run({
          guildId,
          userId,
          symbol: asset.symbol,
          quantity: remaining,
          costBasis: held.costBasis - soldBasis,
          now: ledger.now(),
        });
      }
      return { asset, quantity: qty, price, gross, fee, total, profit, balance, remaining };
    });
    if (!r.ok) return r;
    const unlocked = this.progress.record(guildId, userId, [
      { stat: 'market_trades', add: 1 },
      { stat: 'market_profit_total', add: r.value.profit ?? 0 },
    ]);
    return { ok: true, value: this.withRewards(r.value, unlocked) };
  }

  private withRewards(trade: Omit<Trade, 'unlocked'>, unlocked: readonly UnlockedAchievement[]): Trade {
    return { ...trade, balance: trade.balance + unlocked.reduce((s, u) => s + u.reward, 0), unlocked };
  }

  private requireAsset(symbol: string): MarketAsset {
    const asset = this.getAsset(symbol);
    if (!asset) fail('UNKNOWN_ASSET', `Actif inconnu : ${symbol}.`);
    return asset;
  }

  private assertQuantity(quantity: number): void {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_TRADE_QUANTITY) {
      fail('INVALID_QUANTITY', `La quantité doit être comprise entre 1 et ${MAX_TRADE_QUANTITY}.`);
    }
  }
}
