import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import type { BotJobs } from '../src/core/jobs.js';
import { nullLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/rng.js';
import { JobScheduler } from '../src/core/scheduler/JobScheduler.js';
import { dayId, nextDaily, PARIS } from '../src/core/time.js';
import { rateText } from '../src/modules/economy/discord/market.js';
import { EconomyService } from '../src/modules/economy/EconomyService.js';
import { ASSETS_BY_SYMBOL } from '../src/modules/economy/market/assets.js';
import { dividendFor, MarketService } from '../src/modules/economy/market/MarketService.js';
import { ProgressService } from '../src/modules/economy/progress/ProgressService.js';

describe('dates des dividendes', () => {
  it('midi à Paris, aujourd’hui ou demain', () => {
    expect(nextDaily(Date.UTC(2026, 10, 26, 9), 12, PARIS)).toBe(Date.UTC(2026, 10, 26, 11));
    expect(nextDaily(Date.UTC(2026, 10, 26, 11), 12, PARIS)).toBe(Date.UTC(2026, 10, 27, 11));
    expect(nextDaily(Date.UTC(2026, 6, 14, 12), 12, PARIS)).toBe(Date.UTC(2026, 6, 15, 10));
    expect(dayId(Date.UTC(2026, 10, 26, 23, 30), PARIS)).toBe('2026-11-27');
  });
});

describe('dividendes', () => {
  let db: Db;
  let now: number;
  let eco: EconomyService;
  let market: MarketService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = Date.UTC(2026, 10, 26, 11);
    eco = new EconomyService({ db, bus: new EventBus<BotEvents>(), logger: nullLogger }, { clock: () => now });
    market = new MarketService(db, eco, new ProgressService(db, eco), { clock: () => now, rng: seededRng(1) });
    market.advance();
    for (const [g, u] of [['g1', 'a'], ['g1', 'b'], ['g2', 'a']] as const) eco.adjustBalance(g, u, 100_000, 'admin', null);
  });

  afterEach(() => db.close());

  const price = () => market.quote(ASSETS_BY_SYMBOL.get('CRS')!).price;

  it('seul CRS verse un dividende, de 0,2 % par jour', () => {
    expect(ASSETS_BY_SYMBOL.get('CRS')?.dividendRate).toBe(0.002);
    expect([...ASSETS_BY_SYMBOL.values()].filter((a) => a.dividendRate).map((a) => a.symbol)).toEqual(['CRS']);
    expect(dividendFor(100, 120, 0.002)).toBe(24);
    expect(dividendFor(1, 120, 0.002)).toBe(0);
    expect(rateText(0.002)).toBe('0,2 %');
  });

  it('verse à chaque détenteur, sur chaque serveur, une seule fois par jour', () => {
    market.buy('g1', 'a', 'CRS', 100);
    market.buy('g1', 'b', 'CRS', 2);
    market.buy('g2', 'a', 'CRS', 50);
    market.buy('g1', 'a', 'MEME', 100);
    const expected = (qty: number) => Math.floor(qty * price() * 0.002);

    const first = market.payDividends('2026-11-26');
    if (!first.ok) throw new Error(first.error.message);
    // b ne détient que 2 parts : moins d'une unité, rien n'est versé.
    expect(first.value.map((p) => [p.guildId, p.userId, p.amount])).toEqual([
      ['g1', 'a', expected(100)],
      ['g2', 'a', expected(50)],
    ]);
    expect(eco.history('g1', 'a', 1)[0]).toMatchObject({ kind: 'dividend', reference: 'CRS:2026-11-26', note: '100 CRS' });

    expect(market.payDividends('2026-11-26')).toEqual({ ok: true, value: [] });
    const next = market.payDividends('2026-11-27');
    expect(next.ok && next.value.length).toBe(2);
  });

  it('le module planifie le versement quotidien une seule fois', async () => {
    const scheduler = new JobScheduler<BotJobs>(db);
    const { economyModule, DIVIDENDS_KEY } = await import('../src/modules/economy/index.js');
    const ctx = { db, bus: new EventBus<BotEvents>(nullLogger), logger: nullLogger, scheduler };
    await economyModule.init?.(ctx);
    await economyModule.dispose?.();
    await economyModule.init?.(ctx);
    expect(scheduler.list('market:dividends')).toHaveLength(1);
    expect(scheduler.getByKey(DIVIDENDS_KEY)?.kind).toBe('market:dividends');
    await economyModule.dispose?.();
  });
});
