import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import type { BotJobs } from '../src/core/jobs.js';
import { nullLogger } from '../src/core/logger.js';
import { JobScheduler } from '../src/core/scheduler/JobScheduler.js';
import { monthId, monthLabel, monthRange, nextWeekly, PARIS, previousMonthId, zonedParts, zonedTime } from '../src/core/time.js';
import { parseRewards } from '../src/modules/economy/discord/eventsSettingsSection.js';
import { nextSeasonClose } from '../src/modules/economy/discord/seasons.js';
import { EconomyService } from '../src/modules/economy/EconomyService.js';
import { DEFAULT_EVENT_SETTINGS, EventSettingsStore } from '../src/modules/economy/eventsSettings.js';
import { LotteryService, MAX_TICKETS_PER_PLAYER, pickWinner } from '../src/modules/economy/lottery/LotteryService.js';
import { SeasonService } from '../src/modules/economy/seasons/SeasonService.js';

const G = 'g';

describe('dates dans un fuseau', () => {
  it('convertit une heure de Paris, été comme hiver', () => {
    expect(zonedTime(2026, 11, 29, 20, PARIS)).toBe(Date.UTC(2026, 10, 29, 19));
    expect(zonedTime(2026, 7, 5, 20, PARIS)).toBe(Date.UTC(2026, 6, 5, 18));
    expect(zonedParts(Date.UTC(2026, 10, 29, 19), PARIS)).toMatchObject({ day: 29, hour: 20, weekday: 0 });
  });

  it('trouve le prochain dimanche 20 h', () => {
    // Jeudi 26 novembre 2026 → dimanche 29 à 20 h.
    expect(nextWeekly(Date.UTC(2026, 10, 26, 12), 0, 20, PARIS)).toBe(Date.UTC(2026, 10, 29, 19));
    // Dimanche 19 h 59 → le jour même ; dimanche 20 h pile → la semaine suivante.
    expect(nextWeekly(Date.UTC(2026, 10, 29, 18, 59), 0, 20, PARIS)).toBe(Date.UTC(2026, 10, 29, 19));
    expect(nextWeekly(Date.UTC(2026, 10, 29, 19), 0, 20, PARIS)).toBe(Date.UTC(2026, 11, 6, 19));
    // Passage à l'heure d'été (29 mars 2026) : 20 h reste 20 h.
    expect(nextWeekly(Date.UTC(2026, 2, 27, 12), 0, 20, PARIS)).toBe(Date.UTC(2026, 2, 29, 18));
  });

  it('découpe les mois en heure de Paris', () => {
    // 30 novembre 23 h 30 UTC = 1er décembre 0 h 30 à Paris.
    expect(monthId(Date.UTC(2026, 10, 30, 23, 30), PARIS)).toBe('2026-12');
    expect(monthRange('2026-12', PARIS)).toEqual({ start: Date.UTC(2026, 10, 30, 23), end: Date.UTC(2026, 11, 31, 23) });
    expect(previousMonthId('2027-01')).toBe('2026-12');
    expect(previousMonthId('2026-11')).toBe('2026-10');
    expect(monthLabel('2026-08')).toBe('août 2026');
    expect(nextSeasonClose(Date.UTC(2026, 10, 26))).toBe(Date.UTC(2026, 10, 30, 23, 1));
  });
});

describe('loterie', () => {
  let db: Db;
  let now: number;
  let eco: EconomyService;
  let events: EventSettingsStore;
  let roll: number;
  let lottery: LotteryService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = Date.UTC(2026, 10, 26, 12);
    eco = new EconomyService({ db, bus: new EventBus<BotEvents>(), logger: nullLogger }, { clock: () => now });
    events = new EventSettingsStore(db);
    roll = 0;
    lottery = new LotteryService(db, eco, events, () => roll, () => now);
    for (const u of ['a', 'b']) eco.adjustBalance(G, u, 10_000, 'admin', null);
  });

  afterEach(() => db.close());

  it('le premier ticket ouvre le tirage du dimanche, la cagnotte reçoit 90 %', () => {
    const first = lottery.buy(G, 'a', 3);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value).toMatchObject({ opened: true, bought: 3, cost: 300, owned: 3, balance: 9_700 });
    expect(first.value.draw).toMatchObject({ drawsAt: Date.UTC(2026, 10, 29, 19), pot: 270, status: 'open' });
    const second = lottery.buy(G, 'b', 1);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.opened).toBe(false);
    expect(second.value.draw.id).toBe(first.value.draw.id);
    expect(second.value.draw.pot).toBe(360);
    expect(eco.history(G, 'a', 1)[0]).toMatchObject({ kind: 'lottery', amount: -300 });
  });

  it('limite les tickets, refuse sans les fonds ou si désactivée', () => {
    expect(lottery.buy(G, 'a', MAX_TICKETS_PER_PLAYER).ok).toBe(true);
    expect(lottery.buy(G, 'a', 1).ok).toBe(false);
    expect(lottery.buy(G, 'pauvre', 1).ok).toBe(false);
    events.set(G, { ...DEFAULT_EVENT_SETTINGS, ticketPrice: 0 });
    const r = lottery.buy(G, 'b', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/désactivée/);
  });

  it('tire au sort selon le nombre de tickets', () => {
    const entries = [
      { userId: 'a', count: 3 },
      { userId: 'b', count: 1 },
    ];
    expect(pickWinner(entries, 0)).toBe('a');
    expect(pickWinner(entries, 0.74)).toBe('a');
    expect(pickWinner(entries, 0.75)).toBe('b');
    expect(pickWinner([], 0.5)).toBeNull();
  });

  it('verse la cagnotte au gagnant, une seule fois, puis rouvre un nouveau tirage', () => {
    lottery.buy(G, 'a', 1);
    const bought = lottery.buy(G, 'b', 3);
    if (!bought.ok) throw new Error(bought.error.message);
    roll = 0.9;
    const r = lottery.runDraw(bought.value.draw.id);
    expect(r).toMatchObject({ ok: true, value: { winnerId: 'b', prize: 360, tickets: 4, players: 2 } });
    expect(eco.getBalance(G, 'b')).toBe(10_000 - 300 + 360);
    expect(lottery.runDraw(bought.value.draw.id)).toEqual({ ok: true, value: null });
    expect(lottery.current(G)).toBeNull();
    const next = lottery.buy(G, 'a', 1);
    expect(next.ok && next.value.opened).toBe(true);
  });
});

describe('saisons', () => {
  let db: Db;
  let now: number;
  let eco: EconomyService;
  let events: EventSettingsStore;
  let seasons: SeasonService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = Date.UTC(2026, 10, 10, 12);
    eco = new EconomyService({ db, bus: new EventBus<BotEvents>(), logger: nullLogger }, { clock: () => now });
    events = new EventSettingsStore(db);
    seasons = new SeasonService(db, eco, events, () => now);
  });

  afterEach(() => db.close());

  it('compte les gains du mois, hors virements, ajustements et achats', () => {
    eco.adjustBalance(G, 'riche', 100_000, 'admin', null);
    eco.claimDaily(G, 'a');
    eco.claimDaily(G, 'b');
    eco.transfer(G, 'riche', 'b', 5_000);
    eco.upsertItem(G, { key: 'x', name: 'X', price: 50 });
    eco.buy(G, 'a', 'x');
    const board = seasons.earningsBoard(G, '2026-11');
    expect(board).toEqual([
      { userId: 'a', value: 100 },
      { userId: 'b', value: 100 },
    ]);
    expect(seasons.earningsOf(G, '2026-11', 'b')).toEqual({ value: 100, rank: 2 });
    expect(seasons.earningsOf(G, '2026-11', 'riche')).toEqual({ value: 0, rank: null });
    expect(seasons.earningsBoard(G, '2026-10')).toEqual([]);
  });

  it('compte les victoires par mois', () => {
    seasons.addWin(G, 'a', now);
    seasons.addWin(G, 'a', now);
    seasons.addWin(G, 'b', Date.UTC(2026, 9, 31, 12));
    expect(seasons.winsBoard(G, '2026-11')).toEqual([{ userId: 'a', value: 2 }]);
    expect(seasons.winsOf(G, '2026-10', 'b')).toBe(1);
  });

  it('clôture : podium archivé, bonus versés une seule fois', () => {
    for (const [u, n] of [['a', 3], ['b', 2], ['c', 1], ['d', 1]] as const) {
      for (let k = 0; k < n; k++) {
        eco.claimDaily(G, u);
        now += 86_400_000;
      }
      now = Date.UTC(2026, 10, 10, 12);
    }
    const r = seasons.close(G, '2026-11');
    if (!r.ok || !r.value) throw new Error('clôture');
    expect(r.value.podium.map((p) => [p.rank, p.userId, p.reward])).toEqual([
      [1, 'a', 1_000],
      [2, 'b', 500],
      [3, 'c', 250],
    ]);
    expect(eco.history(G, 'a', 1)[0]).toMatchObject({ kind: 'season_reward', amount: 1_000, note: '1ᵉʳ de la saison novembre 2026' });
    expect(seasons.close(G, '2026-11')).toEqual({ ok: true, value: null });
    expect(seasons.results(G, '2026-11')).toHaveLength(3);
    expect(seasons.lastSeason(G)).toBe('2026-11');
    expect(seasons.guilds()).toEqual([G]);
  });

  it('lit les bonus du podium', () => {
    expect(parseRewards('1000/500/250')).toEqual([1_000, 500, 250]);
    expect(parseRewards(' 0 ; 0 ; 0 ')).toEqual([0, 0, 0]);
    for (const bad of ['1000/500', 'a/b/c', '1/2/3/4', '-1/0/0']) expect(parseRewards(bad), bad).toBeNull();
  });

  it('le module planifie la clôture de saison une seule fois', async () => {
    const scheduler = new JobScheduler<BotJobs>(db);
    const { economyModule, SEASONS_CLOSE_KEY } = await import('../src/modules/economy/index.js');
    const ctx = { db, bus: new EventBus<BotEvents>(nullLogger), logger: nullLogger, scheduler };
    await economyModule.init?.(ctx);
    await economyModule.dispose?.();
    await economyModule.init?.(ctx);
    expect(scheduler.list('seasons:close')).toHaveLength(1);
    expect(scheduler.getByKey(SEASONS_CLOSE_KEY)?.runAt).toBeGreaterThan(Date.now());
    await economyModule.dispose?.();
  });
});
