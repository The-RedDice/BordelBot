import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/core/commands/registry.js';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import type { SettingsSection } from '../src/core/settings/types.js';
import { parseSlowmode } from '../src/modules/moderation/discord/channels.js';
import { caseEmbed, caseLine } from '../src/modules/moderation/discord/render.js';
import { ModerationService } from '../src/modules/moderation/ModerationService.js';
import { describeThreshold, formatThresholds, parseThresholds } from '../src/modules/moderation/thresholds.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const G = 'g';

describe('paliers de sanctions', () => {
  it('lit les règles, les trie et refuse les incohérences', () => {
    const r = parseThresholds('5 = kick\n\n3 = timeout 1h\n7 avertissements : ban 7j\n9 => bannissement');
    expect(r).toEqual({
      ok: true,
      value: [
        { warnCount: 3, action: 'timeout', durationMs: HOUR },
        { warnCount: 5, action: 'kick', durationMs: null },
        { warnCount: 7, action: 'ban', durationMs: 7 * DAY },
        { warnCount: 9, action: 'ban', durationMs: null },
      ],
    });
    for (const bad of ['3 = timeout', '3 = timeout 29j', '3 = kick 1h', '3 = gifle', 'trois = kick', '0 = kick', '3 = kick\n3 = ban']) {
      expect(parseThresholds(bad).ok, bad).toBe(false);
    }
    expect(parseThresholds('')).toEqual({ ok: true, value: [] });
  });

  it('le format affiché dans la modale se relit à l’identique', () => {
    const r = parseThresholds('3 = timeout 1h30\n7 = ban 2sem\n9 = ban');
    if (!r.ok) throw new Error(r.message);
    expect(parseThresholds(formatThresholds(r.value))).toEqual(r);
    expect(describeThreshold(r.value[0]!)).toBe('3 avert. → exclusion temporaire (1 h 30 min)');
    expect(describeThreshold(r.value[2]!)).toBe('9 avert. → bannissement (définitif)');
  });
});

describe('mode lent', () => {
  it.each([
    ['0', 0],
    ['off', 0],
    ['désactivé', 0],
    ['10', 10],
    ['30s', 30],
    ['2m', 120],
    ['6h', 21_600],
  ])('« %s » → %i s', (input, expected) => expect(parseSlowmode(input)).toBe(expected));

  it.each(['7h', 'abc', '-1', ''])('refuse « %s »', (input) => expect(parseSlowmode(input)).toBeNull());
});

describe('ModerationService : expiration, paliers, bans temporaires, verrous', () => {
  let db: Db;
  let now: number;
  let mod: ModerationService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = 1_700_000_000_000;
    mod = new ModerationService({ db, bus: new EventBus<BotEvents>() }, { clock: () => now });
  });
  afterEach(() => db.close());

  const warn = () => mod.createCase({ guildId: G, action: 'warn', targetId: 'u', moderatorId: 'm', reason: 'x' });

  it('les avertissements expirés ne comptent plus', () => {
    const old = warn();
    now += 10 * DAY;
    warn();
    expect(mod.countActiveWarns(G, 'u')).toBe(2);
    mod.setWarnExpiryDays(G, 7);
    expect(mod.countActiveWarns(G, 'u')).toBe(1);
    expect(mod.isWarnExpired(old)).toBe(true);
    expect(caseLine(old, { expired: true })).toContain('*(expiré)*');
    expect(() => mod.setWarnExpiryDays(G, -1)).toThrow(RangeError);
    // Le réglage n'écrase pas celui du salon de logs (même ligne guild_settings).
    mod.setLogChannel(G, 'logs');
    mod.setWarnExpiryDays(G, 30);
    expect(mod.getLogChannel(G)).toBe('logs');
  });

  it('remplace les paliers et trouve celui qui correspond exactement', () => {
    mod.setThresholds(G, [
      { warnCount: 3, action: 'timeout', durationMs: HOUR },
      { warnCount: 5, action: 'ban', durationMs: null },
    ]);
    expect(mod.thresholdFor(G, 3)).toMatchObject({ action: 'timeout' });
    expect(mod.thresholdFor(G, 4)).toBeNull();
    mod.setThresholds(G, [{ warnCount: 2, action: 'kick', durationMs: null }]);
    expect(mod.getThresholds(G)).toEqual([{ warnCount: 2, action: 'kick', durationMs: null }]);
    expect(mod.getThresholds('autre')).toEqual([]);
  });

  it('liste les bans temporaires échus jusqu’à leur résolution', () => {
    const temp = mod.createCase({ guildId: G, action: 'ban', targetId: 'u', moderatorId: 'm', durationMs: DAY });
    mod.createCase({ guildId: G, action: 'ban', targetId: 'v', moderatorId: 'm' }); // définitif
    expect(mod.dueTempbans()).toEqual([]);
    now += DAY;
    expect(mod.dueTempbans().map((c) => c.caseNumber)).toEqual([temp.caseNumber]);
    mod.resolveCase(temp.id);
    expect(mod.dueTempbans()).toEqual([]);

    // Un débannissement manuel clôt aussi les bans temporaires en attente.
    mod.createCase({ guildId: G, action: 'ban', targetId: 'w', moderatorId: 'm', durationMs: HOUR });
    mod.resolveBans(G, 'w');
    now += HOUR;
    expect(mod.dueTempbans()).toEqual([]);
  });

  it('retrouve le verrou actif d’un salon et son état d’origine', () => {
    expect(mod.openLock(G, 'chan')).toBeNull();
    const lock = mod.createCase({
      guildId: G,
      action: 'lock',
      targetId: 'chan',
      moderatorId: 'm',
      metadata: { previous: { SendMessages: true } },
    });
    expect(mod.openLock(G, 'chan')?.metadata).toEqual({ previous: { SendMessages: true } });
    expect(caseEmbed(lock).toJSON().fields?.[0]).toMatchObject({ name: 'Salon', value: '<#chan>' });
    mod.resolveCase(lock.id);
    expect(mod.openLock(G, 'chan')).toBeNull();
  });

  it('marque les sanctions automatiques dans le salon de logs', () => {
    const c = mod.createCase({
      guildId: G,
      action: 'timeout',
      targetId: 'u',
      moderatorId: 'bot',
      durationMs: HOUR,
      metadata: { auto: true, warnCount: 3 },
    });
    expect(caseEmbed(c).toJSON().footer?.text).toBe('Sanction automatique : 3 avertissements actifs');
  });
});

describe('/config', () => {
  const section = (id: string): SettingsSection => ({
    id,
    label: id,
    emoji: '⚙️',
    hint: '',
    describe: () => '',
    editor: () => {
      throw new Error('non utilisé');
    },
    submit: async () => ({ ok: true, message: '' }),
  });

  it('refuse deux sections de réglages avec le même identifiant', () => {
    expect(
      () =>
        new CommandRegistry([
          { name: 'a', settings: [section('x')] },
          { name: 'b', settings: [section('x')] },
        ]),
    ).toThrow(/déclarée deux fois/);
    expect(() => new CommandRegistry([{ name: 'a', settings: [section('a:b')] }])).toThrow(/interdit/);
  });

  it('les modules réels déclarent des commandes et des sections uniques', async () => {
    const { modules } = await import('../src/modules/index.js');
    const registry = new CommandRegistry(modules);
    const names = registry.allCommands().map((c) => c.data.name);
    expect(names).toEqual(expect.arrayContaining(['config', 'bourse', 'profil', 'succes', 'duel', 'lock', 'slowmode']));
    expect(names).not.toContain('modlogs');
    expect(names.length).toBeLessThanOrEqual(100);
    // Chaque définition est acceptée par l'API (validation des builders).
    for (const c of registry.allCommands()) expect(() => c.data.toJSON()).not.toThrow();
  });
});
