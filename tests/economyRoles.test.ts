import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import type { BotJobs } from '../src/core/jobs.js';
import { nullLogger } from '../src/core/logger.js';
import { JobScheduler } from '../src/core/scheduler/JobScheduler.js';
import { roleExpiryHandler } from '../src/modules/economy/discord/roles.js';
import { EconomyService } from '../src/modules/economy/EconomyService.js';
import { DEFAULT_EXTRAS, EconomyExtrasStore } from '../src/modules/economy/extras.js';
import {
  HEIST_COOLDOWN_MS,
  HEIST_TARGET_PROTECTION_MS,
  heistChance,
  heistFine,
  heistLoot,
  HeistService,
} from '../src/modules/economy/heist/HeistService.js';
import type { EconomyServices } from '../src/modules/economy/services.js';
import { RoleShop } from '../src/modules/economy/shop/RoleShop.js';

const G = 'g';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 26, 12);

describe('rôles en boutique', () => {
  let db: Db;
  let now: number;
  let eco: EconomyService;
  let shop: RoleShop;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = T0;
    eco = new EconomyService({ db, bus: new EventBus<BotEvents>(), logger: nullLogger }, { clock: () => now });
    shop = new RoleShop(db, eco, () => now);
    eco.adjustBalance(G, 'u', 1_000, 'admin', null);
    eco.upsertItem(G, { key: 'vip', name: 'VIP', price: 100, roleId: 'role-vip', roleDurationMs: 7 * DAY });
    eco.upsertItem(G, { key: 'or', name: 'Or', price: 300, roleId: 'role-or' });
  });

  afterEach(() => db.close());

  it('enregistre le rôle de l’article, jamais cumulable', () => {
    expect(eco.getItem(G, 'vip')).toMatchObject({ roleId: 'role-vip', roleDurationMs: 7 * DAY, stackable: false });
    expect(eco.getItem(G, 'or')).toMatchObject({ roleId: 'role-or', roleDurationMs: null });
    // Un article ordinaire n'a pas de rôle, et la durée sans rôle est ignorée.
    eco.upsertItem(G, { key: 'pomme', name: 'Pomme', price: 1, roleDurationMs: DAY });
    expect(eco.getItem(G, 'pomme')).toMatchObject({ roleId: null, roleDurationMs: null, stackable: true });
  });

  it('un rôle ne s’achète pas comme un article ordinaire', () => {
    const r = eco.buy(G, 'u', 'vip');
    expect(r.ok).toBe(false);
    expect(eco.getBalance(G, 'u')).toBe(1_000);
  });

  it('achète un rôle temporaire, puis le prolonge à partir de l’échéance', () => {
    const first = shop.buy(G, 'u', 'vip');
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value).toMatchObject({ expiresAt: T0 + 7 * DAY, previous: null, balance: 900 });
    now += 2 * DAY;
    const second = shop.buy(G, 'u', 'VIP ');
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.expiresAt).toBe(T0 + 14 * DAY);
    expect(second.value.previous?.expiresAt).toBe(T0 + 7 * DAY);
    expect(shop.grants(G, 'u')).toHaveLength(1);
    expect(eco.history(G, 'u', 1)[0]).toMatchObject({ kind: 'purchase', amount: -100, note: 'rôle VIP' });
  });

  it('un rôle permanent ne s’achète qu’une fois', () => {
    expect(shop.buy(G, 'u', 'or').ok).toBe(true);
    const again = shop.buy(G, 'u', 'or');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('ALREADY_OWNED');
    expect(eco.getBalance(G, 'u')).toBe(700);
  });

  it('annule un achat refusé par Discord : remboursement et droit d’avant', () => {
    const first = shop.buy(G, 'u', 'vip');
    const second = shop.buy(G, 'u', 'vip');
    if (!first.ok || !second.ok) throw new Error('achat');
    expect(shop.undo(G, 'u', second.value).ok).toBe(true);
    expect(eco.getBalance(G, 'u')).toBe(900);
    expect(shop.grant(G, 'u', 'role-vip')?.expiresAt).toBe(T0 + 7 * DAY);
    shop.undo(G, 'u', first.value);
    expect(shop.grant(G, 'u', 'role-vip')).toBeNull();
    expect(eco.getBalance(G, 'u')).toBe(1_000);
  });

  it('refuse sans les fonds, sans rien enregistrer', () => {
    eco.upsertItem(G, { key: 'cher', name: 'Cher', price: 5_000, roleId: 'role-cher' });
    expect(shop.buy(G, 'u', 'cher').ok).toBe(false);
    expect(shop.grants(G, 'u')).toEqual([]);
  });

  it('à l’échéance : replanifie si prolongé, sinon oublie le droit', async () => {
    const services = { roleShop: shop } as unknown as EconomyServices;
    const handler = roleExpiryHandler(() => services);
    const client = { guilds: { cache: new Map() } } as unknown as Client<true>;
    const job = (payload: BotJobs['shop:roleExpiry']) => ({
      id: 1,
      kind: 'shop:roleExpiry' as const,
      key: null,
      guildId: G,
      runAt: 0,
      payload,
      attempts: 0,
      createdAt: 0,
    });
    shop.buy(G, 'u', 'vip');
    // Échéance future (prolongée) : la tâche est replanifiée.
    expect(await handler(job({ guildId: G, userId: 'u', roleId: 'role-vip' }), client)).toEqual({ rescheduleAt: T0 + 7 * DAY });
    // Échéance passée, serveur quitté : le droit est oublié.
    const realNow = Date.now;
    Date.now = () => T0 + 8 * DAY;
    try {
      await handler(job({ guildId: G, userId: 'u', roleId: 'role-vip' }), client);
    } finally {
      Date.now = realNow;
    }
    expect(shop.grant(G, 'u', 'role-vip')).toBeNull();
  });
});

describe('braquages', () => {
  it('chances : 30 à 60 % selon la fortune relative de la cible', () => {
    expect(heistChance(1_000, 1_000)).toBeCloseTo(0.45);
    expect(heistChance(1_000_000, 100)).toBeCloseTo(0.6, 3);
    expect(heistChance(100, 1_000_000)).toBeCloseTo(0.3, 3);
  });

  it('butin de 5 à 15 % plafonné, amende de 10 %', () => {
    expect(heistLoot(0, 10_000, 5_000)).toBe(500);
    expect(heistLoot(1, 10_000, 5_000)).toBe(1_500);
    expect(heistLoot(1, 1_000_000, 5_000)).toBe(5_000);
    expect(heistLoot(0, 10, 5_000)).toBe(1);
    expect(heistFine(1_234)).toBe(123);
  });

  describe('HeistService', () => {
    let db: Db;
    let now: number;
    let eco: EconomyService;
    let extras: EconomyExtrasStore;
    let rolls: number[];
    let heists: HeistService;

    beforeEach(() => {
      db = openDatabase(':memory:');
      runMigrations(db, migrations);
      now = T0;
      eco = new EconomyService({ db, bus: new EventBus<BotEvents>(), logger: nullLogger }, { clock: () => now });
      extras = new EconomyExtrasStore(db);
      rolls = [];
      heists = new HeistService(db, eco, extras, () => rolls.shift() ?? 0.5, () => now);
      eco.adjustBalance(G, 'robber', 1_000, 'admin', null);
      eco.adjustBalance(G, 'target', 10_000, 'admin', null);
      eco.adjustBalance(G, 'other', 10_000, 'admin', null);
    });

    afterEach(() => db.close());

    it('réussite : le butin passe de la cible au braqueur', () => {
      rolls = [0.1, 1];
      const r = heists.attempt(G, 'robber', 'target');
      expect(r).toMatchObject({ ok: true, value: { success: true, amount: 1_500, robberBalance: 2_500, targetBalance: 8_500 } });
      expect(eco.history(G, 'target', 1)[0]).toMatchObject({ kind: 'heist', amount: -1_500, counterpartyId: 'robber' });
    });

    it('échec : l’amende va à la cible', () => {
      rolls = [0.99];
      const r = heists.attempt(G, 'robber', 'target');
      expect(r).toMatchObject({ ok: true, value: { success: false, amount: 100 } });
      expect(eco.getBalance(G, 'robber')).toBe(900);
      expect(eco.getBalance(G, 'target')).toBe(10_100);
    });

    it('recharge de 4 h pour le braqueur, 12 h de répit pour la cible', () => {
      expect(heists.attempt(G, 'robber', 'target').ok).toBe(true);
      expect(heists.attempt(G, 'robber', 'other').ok).toBe(false);
      expect(heists.attempt(G, 'other', 'target').ok).toBe(false);
      now += HEIST_COOLDOWN_MS;
      expect(heists.nextAttemptAt(G, 'robber')).toBeNull();
      expect(heists.attempt(G, 'robber', 'other').ok).toBe(true);
      now = T0 + HEIST_TARGET_PROTECTION_MS;
      expect(heists.attempt(G, 'other', 'target').ok).toBe(true);
    });

    it('refuse : désactivé, soi-même, cible ou braqueur trop pauvres', () => {
      expect(heists.attempt(G, 'robber', 'robber').ok).toBe(false);
      expect(heists.attempt(G, 'robber', 'pauvre').ok).toBe(false);
      expect(heists.attempt(G, 'pauvre', 'target').ok).toBe(false);
      extras.set(G, { ...DEFAULT_EXTRAS, heistEnabled: false });
      const r = heists.attempt(G, 'robber', 'target');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/désactivés/);
      // Aucune tentative refusée n'est comptée.
      extras.set(G, DEFAULT_EXTRAS);
      expect(heists.attempt(G, 'robber', 'target').ok).toBe(true);
    });

    it('respecte le butin maximal du serveur', () => {
      extras.set(G, { ...DEFAULT_EXTRAS, heistCap: 200 });
      rolls = [0, 1];
      expect(heists.attempt(G, 'robber', 'target')).toMatchObject({ ok: true, value: { amount: 200 } });
    });
  });
});

describe('réglages du plus riche', () => {
  it('liste les serveurs qui ont un rôle du plus riche', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, migrations);
    const store = new EconomyExtrasStore(db);
    expect(store.get(G)).toEqual(DEFAULT_EXTRAS);
    store.set(G, { ...DEFAULT_EXTRAS, richestRoleId: 'r', richestUserId: 'u' });
    store.set('autre', DEFAULT_EXTRAS);
    expect(store.richestRoleGuilds()).toEqual([{ guildId: G, ...DEFAULT_EXTRAS, richestRoleId: 'r', richestUserId: 'u' }]);
    db.close();
  });

  it('le module planifie la tâche horaire du plus riche une seule fois', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, migrations);
    const scheduler = new JobScheduler<BotJobs>(db);
    const { economyModule, RICHEST_TICK_KEY } = await import('../src/modules/economy/index.js');
    const ctx = { db, bus: new EventBus<BotEvents>(nullLogger), logger: nullLogger, scheduler };
    await economyModule.init?.(ctx);
    await economyModule.dispose?.();
    await economyModule.init?.(ctx);
    expect(scheduler.list('economy:richest')).toHaveLength(1);
    expect(scheduler.getByKey(RICHEST_TICK_KEY)?.kind).toBe('economy:richest');
    await economyModule.dispose?.();
    db.close();
  });
});
