import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import { nullLogger } from '../src/core/logger.js';
import { seededRng, type Rng } from '../src/core/rng.js';
import { csvCell, transactionsCsv } from '../src/modules/economy/csv.js';
import { EconomyService, type EcoResult } from '../src/modules/economy/EconomyService.js';
import { GamblingService } from '../src/modules/economy/gambling/GamblingService.js';
import { SLOT_SYMBOLS, slotMultiplier, slotsReturnToPlayer, spinSlots } from '../src/modules/economy/gambling/games.js';
import { MARKET_ASSETS } from '../src/modules/economy/market/assets.js';
import { priceChartSvg, renderPriceChart } from '../src/modules/economy/market/chart.js';
import { MARKET_TICK_MS, MarketService, tradeFee } from '../src/modules/economy/market/MarketService.js';
import { MAX_PRICE_RATIO, MIN_PRICE_RATIO, nextPrice } from '../src/modules/economy/market/model.js';
import { ProgressService } from '../src/modules/economy/progress/ProgressService.js';

const G = 'guild';

function value<T>(r: EcoResult<T>): T {
  if (!r.ok) throw new Error(`Échec inattendu : ${r.error.code} ${r.error.message}`);
  return r.value;
}
const code = (r: EcoResult<unknown>) => (r.ok ? null : r.error.code);

/** Rejoue une suite de tirages, puis 0.5. */
function sequence(...values: number[]): Rng {
  let i = 0;
  return () => values[i++] ?? 0.5;
}

let db: Db;
let now: number;
let eco: EconomyService;
let progress: ProgressService;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, migrations);
  now = Date.UTC(2026, 10, 26, 12);
  eco = new EconomyService({ db, bus: new EventBus<BotEvents>(), logger: nullLogger }, { clock: () => now });
  progress = new ProgressService(db, eco);
});
afterEach(() => db.close());

const give = (userId: string, amount: number) => value(eco.adjustBalance(G, userId, amount, 'admin', null));

describe('ProgressService', () => {
  it('cumule, garde les records et débloque chaque succès une seule fois, avec sa récompense', () => {
    expect(progress.record(G, 'u', [{ stat: 'games_won', add: 1 }]).map((u) => u.achievement.key)).toEqual([
      'premiere-victoire',
    ]);
    expect(eco.getBalance(G, 'u')).toBe(50);
    expect(progress.record(G, 'u', [{ stat: 'games_won', add: 1 }])).toEqual([]);
    expect(eco.getBalance(G, 'u')).toBe(50);

    progress.record(G, 'u', [{ stat: 'daily_best_streak', max: 5 }]);
    progress.record(G, 'u', [{ stat: 'daily_best_streak', max: 3 }]);
    expect(progress.stats(G, 'u')).toMatchObject({ games_won: 2, daily_best_streak: 5 });
    const unlocked = progress.record(G, 'u', [{ stat: 'daily_best_streak', max: 7 }]);
    expect(unlocked.map((u) => [u.achievement.key, u.reward])).toEqual([['regulier', 200]]);

    const list = progress.progress(G, 'u');
    expect(list.find((p) => p.achievement.key === 'regulier')?.unlockedAt).toBe(now);
    expect(list.find((p) => p.achievement.key === 'champion')).toMatchObject({ unlockedAt: null, current: 2 });
    // Les succès sont propres à chaque serveur.
    expect(progress.stats('autre', 'u')).toEqual({});
  });

  it('journalise la récompense comme une opération « achievement »', () => {
    progress.record(G, 'u', [{ stat: 'market_trades', add: 1 }]);
    expect(eco.history(G, 'u', 1)[0]).toMatchObject({ kind: 'achievement', amount: 50, reference: 'investisseur' });
  });
});

describe('jeux d’argent', () => {
  it('la machine à sous redistribue ≈ 95 % et paie les combinaisons annoncées', () => {
    expect(slotsReturnToPlayer()).toBeGreaterThan(0.94);
    expect(slotsReturnToPlayer()).toBeLessThan(0.96);
    const [cherry, lemon, bell, , , diamond] = SLOT_SYMBOLS as unknown as [
      (typeof SLOT_SYMBOLS)[number],
      (typeof SLOT_SYMBOLS)[number],
      (typeof SLOT_SYMBOLS)[number],
      unknown,
      unknown,
      (typeof SLOT_SYMBOLS)[number],
    ];
    expect(slotMultiplier([diamond, diamond, diamond])).toBe(200);
    expect(slotMultiplier([diamond, cherry, diamond])).toBe(5);
    expect(slotMultiplier([cherry, cherry, lemon])).toBe(0);
    expect(slotMultiplier([cherry, bell, bell])).toBe(2);
    expect(slotMultiplier([cherry, lemon, bell])).toBe(0);

    // Simulation : la moyenne empirique reste proche de la théorie.
    const rng = seededRng(3);
    let total = 0;
    const spins = 200_000;
    for (let i = 0; i < spins; i++) total += spinSlots(rng).multiplier;
    expect(total / spins).toBeGreaterThan(0.85);
    expect(total / spins).toBeLessThan(1.05);
  });

  it('pile ou face : double la mise ou la perd, en une seule ligne de journal', () => {
    give('u', 1_000);
    const win = value(new GamblingService(eco, progress, sequence(0.1)).coinFlip(G, 'u', 100, 'pile'));
    expect(win).toMatchObject({ side: 'pile', won: true, net: 100, balance: 1_100 });
    const loss = value(new GamblingService(eco, progress, sequence(0.9)).coinFlip(G, 'u', 100, 'pile'));
    expect(loss).toMatchObject({ side: 'face', won: false, net: -100, balance: 1_000 });
    expect(eco.history(G, 'u', 2).map((t) => [t.kind, t.amount])).toEqual([
      ['gamble', -100],
      ['gamble', 100],
    ]);
    expect(progress.stats(G, 'u')).toMatchObject({ wagered_total: 200, gambles_won: 1, biggest_win: 100 });
  });

  it('refuse une mise trop élevée, sans fonds ou quand les jeux sont désactivés', () => {
    const g = new GamblingService(eco, progress, seededRng(1));
    give('u', 50_000);
    expect(code(g.slots(G, 'u', 10_001))).toBe('BET_TOO_HIGH');
    expect(code(g.slots(G, 'pauvre', 10))).toBe('INSUFFICIENT_FUNDS');
    expect(code(g.coinFlip(G, 'u', 0, 'pile'))).toBe('INVALID_AMOUNT');
    value(eco.updateSettings(G, { maxBet: 0 }));
    expect(code(g.coinFlip(G, 'u', 10, 'pile'))).toBe('GAMBLING_DISABLED');
    expect(eco.getBalance(G, 'u')).toBe(50_000);
  });

  it('un jackpot débloque le succès et crédite gain + récompense', () => {
    give('u', 100);
    // Trois 💎 : le dernier intervalle de poids sur chaque rouleau.
    const r = value(new GamblingService(eco, progress, sequence(0.99, 0.99, 0.99)).slots(G, 'u', 10));
    expect(r.spin.multiplier).toBe(200);
    expect(r.net).toBe(1_990);
    expect(r.unlocked.map((u) => u.achievement.key)).toEqual(['jackpot']);
    expect(r.balance).toBe(100 + 1_990 + 500);
    expect(eco.getBalance(G, 'u')).toBe(r.balance);
  });

  it('duel : le gagnant prend la mise du perdant, les deux doivent pouvoir payer', () => {
    give('a', 500);
    give('b', 300);
    const g = new GamblingService(eco, progress, sequence(0.2));
    const r = value(g.duel(G, 'a', 'b', 200));
    expect(r).toMatchObject({ winnerId: 'a', loserId: 'b', winnerBalance: 700, loserBalance: 100 });
    expect(code(g.duel(G, 'a', 'b', 200))).toBe('INSUFFICIENT_FUNDS');
    expect(code(g.duel(G, 'a', 'a', 10))).toBe('SELF_TRANSFER');
    expect(progress.stats(G, 'a')).toMatchObject({ duels_won: 1, wagered_total: 200 });
    expect(eco.history(G, 'b', 1)[0]).toMatchObject({ kind: 'duel', amount: -200, counterpartyId: 'a' });
  });
});

describe('bourse', () => {
  const [bdl] = MARKET_ASSETS as [(typeof MARKET_ASSETS)[number]];

  it('le modèle reste dans ses bornes et produit des actualités', () => {
    const rng = seededRng(9);
    for (const asset of MARKET_ASSETS) {
      let price = asset.basePrice;
      let news = 0;
      for (let i = 0; i < 20_000; i++) {
        const step = nextPrice(asset, price, rng);
        price = step.price;
        if (step.news) news++;
        expect(price).toBeGreaterThanOrEqual(Math.floor(asset.basePrice * MIN_PRICE_RATIO * 100) / 100);
        expect(price).toBeLessThanOrEqual(asset.basePrice * MAX_PRICE_RATIO);
      }
      expect(news).toBeGreaterThan(0);
    }
  });

  it('démarre au prix de référence puis rattrape les ticks manqués', () => {
    const market = new MarketService(db, eco, progress, { clock: () => now, rng: seededRng(5) });
    expect(market.advance()).toBe(MARKET_ASSETS.length);
    expect(market.quote(bdl).price).toBe(bdl.basePrice);
    expect(market.advance()).toBe(0); // rien d'échu

    now += 12 * MARKET_TICK_MS + 1_000; // une heure d'arrêt
    expect(market.advance()).toBe(12 * MARKET_ASSETS.length);
    const quote = market.quote(bdl);
    expect(quote.change1h).toBeCloseTo(quote.price / bdl.basePrice - 1, 10);
    expect(quote.change24h).toBeNull();
    expect(market.history(bdl, 3_600_000)).toHaveLength(13);
    expect(market.history(bdl, 3_600_000, 5)).toHaveLength(5);
  });

  it('achat puis ventes : frais, prix de revient au prorata, plus-value et succès', () => {
    let price = 100;
    const market = new MarketService(db, eco, progress, { clock: () => now, rng: () => 0.5 });
    db.prepare('INSERT INTO market_prices (symbol, at, price) VALUES (?, ?, ?)').run(bdl.symbol, now, price);
    give('u', 10_000);

    const buy = value(market.buy(G, 'u', 'bdl', 10));
    expect(buy).toMatchObject({ price: 100, gross: 1_000, fee: 10, total: 1_010, remaining: 10 });
    // 10 000 − 1 010 + 50 (succès « Investisseur »)
    expect(buy.balance).toBe(9_040);
    expect(buy.unlocked.map((u) => u.achievement.key)).toEqual(['investisseur']);

    price = 150;
    db.prepare('INSERT INTO market_prices (symbol, at, price) VALUES (?, ?, ?)').run(bdl.symbol, now + 1, price);
    const sell = value(market.sell(G, 'u', 'BDL', 4));
    // 600 − 6 de frais ; prix de revient de 4/10 × 1 010 = 404
    expect(sell).toMatchObject({ gross: 600, fee: 6, total: 594, profit: 190, remaining: 6 });
    expect(market.portfolio(G, 'u')).toMatchObject({ value: 900, costBasis: 606 });

    expect(code(market.sell(G, 'u', 'BDL', 7))).toBe('INSUFFICIENT_SHARES');
    const rest = value(market.sell(G, 'u', 'BDL', null));
    expect(rest).toMatchObject({ quantity: 6, remaining: 0, profit: 900 - 9 - 606 });
    expect(market.portfolio(G, 'u').positions).toEqual([]);
    expect(progress.stats(G, 'u')).toMatchObject({ market_trades: 3, market_profit_total: 190 + 285 });
    expect(code(market.buy(G, 'u', 'XXX', 1))).toBe('UNKNOWN_ASSET');
    expect(code(market.buy(G, 'pauvre', 'BDL', 1))).toBe('INSUFFICIENT_FUNDS');
    // Un achat refusé n'a rien laissé dans le portefeuille.
    expect(market.portfolio(G, 'pauvre').positions).toEqual([]);
  });

  it('frais minimum de 1 et vente trop petite refusée', () => {
    expect(tradeFee(10)).toBe(1);
    expect(tradeFee(1_000)).toBe(10);
    const market = new MarketService(db, eco, progress, { clock: () => now });
    db.prepare('INSERT INTO market_prices (symbol, at, price) VALUES (?, ?, ?)').run(bdl.symbol, now, 0.5);
    give('u', 100);
    value(market.buy(G, 'u', 'BDL', 2));
    expect(code(market.sell(G, 'u', 'BDL', 2))).toBe('TRADE_TOO_SMALL');
  });

  it('trace un graphique SVG et le convertit en PNG', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ at: now + i * MARKET_TICK_MS, price: 100 + Math.sin(i / 5) * 10 }));
    const svg = priceChartSvg(points);
    expect(svg).toContain('<path');
    expect(svg).not.toContain('NaN');
    const png = renderPriceChart(points);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // Un cours plat ne divise pas par zéro.
    expect(priceChartSvg([{ at: now, price: 5 }, { at: now + 1, price: 5 }])).not.toContain('NaN');
  });
});

describe('export CSV', () => {
  it('échappe les cellules et neutralise les formules', () => {
    expect(csvCell('simple')).toBe('simple');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('dit "bonjour"')).toBe('"dit ""bonjour"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });

  it('exporte le journal du serveur ou d’un membre, du plus ancien au plus récent', () => {
    give('a', 10);
    give('b', 20);
    value(eco.transfer(G, 'b', 'a', 5));
    const all = eco.exportTransactions(G, null);
    expect(all.map((r) => r.userId)).toEqual(['a', 'b', 'b', 'a']);
    expect(eco.exportTransactions(G, 'a').map((r) => r.amount)).toEqual([10, 5]);
    expect(eco.exportTransactions(G, null, 2).map((r) => r.kind)).toEqual(['transfer_out', 'transfer_in']);
    const csv = transactionsCsv(all);
    expect(csv.startsWith('﻿id,date,membre,type,montant')).toBe(true);
    expect(csv.trimEnd().split('\r\n')).toHaveLength(5);
  });
});
