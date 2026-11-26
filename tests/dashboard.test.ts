import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import type { BotJobs } from '../src/core/jobs.js';
import { nullLogger } from '../src/core/logger.js';
import { JobScheduler } from '../src/core/scheduler/JobScheduler.js';
import {
  authorizeUrl,
  cookie,
  exchangeCode,
  parseCookies,
  SESSION_TTL_MS,
  SessionStore,
  type FetchLike,
} from '../src/dashboard/auth.js';
import { DashboardData, moneyStats, type Directory, type GuildRef } from '../src/dashboard/data.js';
import { avatarUrl, defaultAvatar } from '../src/dashboard/directory.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { economyModule, getEconomyServices } from '../src/modules/economy/index.js';

const OAUTH = { clientId: 'app', clientSecret: 'secret', publicUrl: 'http://localhost:3000' };
const ALICE = '111111111111111111';
const BOB = '222222222222222222';
const GUILD = '333333333333333333';
const OTHER = '444444444444444444';

describe('statistiques monétaires', () => {
  it('total, moyenne, médiane et part des 10 % les plus riches', () => {
    expect(moneyStats([])).toEqual({ total: 0, holders: 0, average: 0, median: 0, top10Share: 0 });
    const s = moneyStats([100, 0, 300, 200, 400]);
    expect(s).toMatchObject({ total: 1_000, holders: 4, average: 250, median: 250 });
    expect(s.top10Share).toBeCloseTo(0.4);
    expect(moneyStats([10, 20, 30]).median).toBe(20);
    const unequal = moneyStats([9_000, ...Array<number>(19).fill(50)]);
    expect(unequal.top10Share).toBeCloseTo((9_000 + 50) / 9_950);
  });
});

describe('sessions et cookies', () => {
  let db: Db;
  let now: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = 1_000_000;
  });

  afterEach(() => db.close());

  it('ne garde que l’empreinte du jeton, expire et se ferme', () => {
    const store = new SessionStore(db, () => now);
    const token = store.create({ userId: ALICE, username: 'Alice', avatar: null });
    expect(store.get(token)).toEqual({ userId: ALICE, username: 'Alice', avatar: null });
    expect(db.prepare('SELECT token_hash FROM dashboard_sessions').pluck().get()).not.toBe(token);
    expect(store.get('faux')).toBeNull();
    expect(store.get(undefined)).toBeNull();
    now += SESSION_TTL_MS;
    expect(store.get(token)).toBeNull();
    expect(store.purge()).toBe(1);
    const other = store.create({ userId: BOB, username: 'Bob', avatar: 'abc' });
    store.destroy(other);
    expect(store.get(other)).toBeNull();
  });

  it('lit et écrit les cookies', () => {
    expect([...parseCookies('a=1; b=deux%20mots; mauvais; c=%E0')]).toEqual([
      ['a', '1'],
      ['b', 'deux mots'],
    ]);
    expect(cookie('s', 'x y', 60, true)).toBe('s=x%20y; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure');
    expect(cookie('s', '', 0, false)).not.toContain('Secure');
  });

  it('avatars Discord', () => {
    expect(avatarUrl(ALICE, 'abc')).toBe(`https://cdn.discordapp.com/avatars/${ALICE}/abc.png?size=64`);
    expect(defaultAvatar(ALICE)).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  });
});

/** Faux Discord OAuth : un code valide, un jeton, une identité. */
const fakeDiscord: FetchLike = async (url, init) => {
  if (url.endsWith('/oauth2/token')) {
    const body = new URLSearchParams(init?.body ?? '');
    const ok = body.get('code') === 'bon-code' && body.get('client_secret') === 'secret';
    return { ok, status: ok ? 200 : 400, json: async () => (ok ? { access_token: 'tok', token_type: 'Bearer' } : {}) };
  }
  const ok = init?.headers?.['Authorization'] === 'Bearer tok';
  return { ok, status: ok ? 200 : 401, json: async () => ({ id: ALICE, username: 'alice', global_name: 'Alice', avatar: null }) };
};

describe('OAuth Discord', () => {
  it('demande seulement l’identité, avec un état', () => {
    const url = new URL(authorizeUrl(OAUTH, 'etat'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'app',
      scope: 'identify',
      state: 'etat',
      redirect_uri: 'http://localhost:3000/auth/callback',
    });
  });

  it('échange le code contre l’identité, refuse un mauvais code', async () => {
    expect(await exchangeCode(OAUTH, 'bon-code', fakeDiscord)).toEqual({ userId: ALICE, username: 'Alice', avatar: null });
    await expect(exchangeCode(OAUTH, 'mauvais', fakeDiscord)).rejects.toThrow(/HTTP 400/);
  });
});

describe('configuration', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const setEnv = (vars: Record<string, string>) => {
    process.env = { ...saved, DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c', DASHBOARD_PORT: '', DASHBOARD_URL: '', DISCORD_CLIENT_SECRET: '', ...vars };
  };

  it('le tableau de bord est facultatif, mais complet ou absent', () => {
    setEnv({});
    expect(loadConfig().dashboard).toBeNull();
    setEnv({ DASHBOARD_PORT: '3000', DASHBOARD_URL: 'https://bot.exemple.fr/', DISCORD_CLIENT_SECRET: 's' });
    expect(loadConfig().dashboard).toEqual({ host: '127.0.0.1', port: 3000, publicUrl: 'https://bot.exemple.fr', clientSecret: 's' });
    setEnv({ DASHBOARD_PORT: '3000' });
    expect(() => loadConfig()).toThrow(/vont ensemble/);
    setEnv({ DASHBOARD_PORT: '3000', DASHBOARD_URL: 'http://bot.exemple.fr', DISCORD_CLIENT_SECRET: 's' });
    expect(() => loadConfig()).toThrow(/https/);
    setEnv({ DASHBOARD_PORT: 'abc', DASHBOARD_URL: 'http://localhost:3000', DISCORD_CLIENT_SECRET: 's' });
    expect(() => loadConfig()).toThrow(/DASHBOARD_PORT/);
  });
});

describe('serveur du tableau de bord', () => {
  let db: Db;
  let server: Server;
  let base: string;

  const guild: GuildRef = { id: GUILD, name: 'Le Bordel', iconUrl: null, memberCount: 42 };
  const directory: Directory = {
    guildsOf: async (userId) => (userId === ALICE ? [guild] : []),
    isMember: async (guildId, userId) => guildId === GUILD && userId === ALICE,
    guild: (id) => (id === GUILD ? guild : id === OTHER ? { ...guild, id: OTHER, name: 'Autre' } : null),
    users: async (_g, ids) => Object.fromEntries(ids.map((id) => [id, { name: id === ALICE ? 'Alice' : 'Bob', avatarUrl: defaultAvatar(id) }])),
  };

  beforeAll(async () => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    const scheduler = new JobScheduler<BotJobs>(db);
    await economyModule.init?.({ db, bus: new EventBus<BotEvents>(nullLogger), logger: nullLogger, scheduler });
    const { eco } = getEconomyServices();
    eco.adjustBalance(GUILD, ALICE, 1_000, 'admin', null);
    eco.adjustBalance(GUILD, BOB, 3_000, 'admin', null);
    eco.claimDaily(GUILD, ALICE);

    const data = new DashboardData({
      db,
      economy: getEconomyServices,
      levels: () => [{ userId: BOB, xp: 5_000 }],
      memberXp: () => 120,
    });
    server = createDashboardServer({
      oauth: OAUTH,
      sessions: new SessionStore(db),
      data,
      directory,
      logger: nullLogger,
      fetcher: fakeDiscord,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await economyModule.dispose?.();
    db.close();
  });

  const get = (path: string, cookieHeader?: string) =>
    fetch(base + path, { redirect: 'manual', headers: cookieHeader ? { cookie: cookieHeader } : {} });
  const setCookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!);

  async function login(): Promise<string> {
    const start = await get('/auth/login');
    const stateCookie = setCookies(start)[0]!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await get(`/auth/callback?code=bon-code&state=${state}`, stateCookie);
    expect(cb.status).toBe(302);
    const session = setCookies(cb).find((c) => c.startsWith('bb_session='));
    expect(session).toBeDefined();
    return session!;
  }

  it('sert l’interface (page, style, script valide) sans rien d’extérieur', async () => {
    const page = await (await get('/')).text();
    expect(page).toContain('<script src="/app.js" defer></script>');
    expect(page).toContain('<link rel="stylesheet" href="/app.css">');
    expect(page).not.toMatch(/<script>|style=|https?:\/\//);
    const css = await get('/app.css');
    expect(css.headers.get('content-type')).toContain('text/css');
    const js = await (await get('/app.js')).text();
    // Le script se compile, et ne construit jamais de HTML à partir de chaînes.
    expect(() => new Function(js)).not.toThrow();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('sert la page avec des en-têtes de sécurité', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect((await get('/healthz')).status).toBe(200);
  });

  it('la bourse est publique', async () => {
    const market = (await (await get('/api/market')).json()) as { quotes: { symbol: string; dividendRate: number | null }[] };
    expect(market.quotes.map((q) => q.symbol)).toContain('CRS');
    expect(market.quotes.find((q) => q.symbol === 'CRS')?.dividendRate).toBe(0.002);
    expect((await get('/api/market/CRS?periode=7j')).status).toBe(200);
    expect((await get('/api/market/CRS?periode=1an')).status).toBe(404);
    expect((await get('/api/market/XYZ')).status).toBe(404);
  });

  it('le reste demande une connexion', async () => {
    expect((await get('/api/me')).status).toBe(401);
    expect((await get(`/api/guilds/${GUILD}`)).status).toBe(401);
  });

  it('refuse un retour OAuth sans état valide', async () => {
    const res = await get('/auth/callback?code=bon-code&state=pirate', 'bb_oauth_state=autre');
    expect(res.headers.get('location')).toBe('/?erreur=etat');
    expect(setCookies(res).some((c) => c.startsWith('bb_session=') && c !== 'bb_session=')).toBe(false);
    const denied = await get('/auth/callback?error=access_denied');
    expect(denied.headers.get('location')).toBe('/');
  });

  it('connecté : mes serveurs, et seulement ceux dont je suis membre', async () => {
    const session = await login();
    const me = (await (await get('/api/me', session)).json()) as { user: { name: string }; guilds: GuildRef[] };
    expect(me.user.name).toBe('Alice');
    expect(me.guilds.map((g) => g.id)).toEqual([GUILD]);
    expect((await get(`/api/guilds/${OTHER}`, session)).status).toBe(404);
    expect((await get('/api/guilds/123', session)).status).toBe(404);
  });

  it('donne les statistiques et classements d’un serveur', async () => {
    const session = await login();
    const res = await get(`/api/guilds/${GUILD}`, session);
    expect(res.status).toBe(200);
    const o = (await res.json()) as {
      currency: string;
      me: { balance: number; rank: number; level: number };
      stats: { total: number; holders: number; supplyChange7d: number };
      leaderboards: { fortune: { userId: string }[]; levels: { userId: string; level: number }[] };
      users: Record<string, { name: string }>;
      lottery: { ticketPrice: number; current: unknown };
      season: { label: string };
    };
    expect(o.currency).toBe('pièces');
    expect(o.me).toMatchObject({ balance: 1_100, rank: 2 });
    expect(o.stats).toMatchObject({ total: 4_100, holders: 2 });
    // Les ajustements d'admin comptent dans la masse monétaire, pas les virements.
    expect(o.stats.supplyChange7d).toBe(4_100);
    expect(o.leaderboards.fortune.map((r) => r.userId)).toEqual([BOB, ALICE]);
    expect(o.leaderboards.levels[0]).toMatchObject({ userId: BOB });
    expect(o.users[BOB]?.name).toBe('Bob');
    expect(o.lottery).toMatchObject({ ticketPrice: 100, current: null });
  });

  it('la déconnexion ferme la session', async () => {
    const session = await login();
    const res = await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: session } });
    expect(res.status).toBe(303);
    expect((await get('/api/me', session)).status).toBe(401);
    expect((await fetch(`${base}/auth/logout`, { redirect: 'manual' })).status).toBe(404);
  });
});
