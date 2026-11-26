import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import { nullLogger } from '../src/core/logger.js';
import { EconomyService } from '../src/modules/economy/EconomyService.js';
import { auditReason, caseEmbed, caseLine, sanctionDm } from '../src/modules/moderation/discord/render.js';
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from '../src/modules/moderation/duration.js';
import { ModerationService } from '../src/modules/moderation/ModerationService.js';
import { checkHierarchy, type HierarchyInput } from '../src/modules/moderation/policy.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('parseDuration / formatDuration', () => {
  it.each([
    ['30s', 30_000],
    ['10m', 10 * MIN],
    ['10 min', 10 * MIN],
    ['45', 45 * MIN],
    ['2h', 2 * HOUR],
    ['1h30', 90 * MIN],
    ['1h 30min', 90 * MIN],
    ['3j', 3 * DAY],
    ['1d12h', 36 * HOUR],
    ['2sem', 14 * DAY],
    ['1 semaine', 7 * DAY],
    ['28j', MAX_TIMEOUT_MS],
  ])('« %s »', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '  ', 'abc', '10x', '0', '0m', '1h30x', '30 1h', '1.5h', '-5m', '99999999999999999999j'])(
    'refuse « %s »',
    (input) => {
      expect(parseDuration(input)).toBeNull();
    },
  );

  it('formate lisiblement', () => {
    expect(formatDuration(90 * MIN)).toBe('1 h 30 min');
    expect(formatDuration(3 * DAY + 5_000)).toBe('3 j 5 s');
    expect(formatDuration(0)).toBe('0 s');
  });
});

describe('checkHierarchy', () => {
  const base: HierarchyInput = {
    actorId: 'mod',
    targetId: 'user',
    botId: 'bot',
    ownerId: 'owner',
    actorPosition: 5,
    targetPosition: 2,
    botPosition: 10,
    botMustOutrank: true,
  };

  it('autorise un modérateur au-dessus de sa cible', () => {
    expect(checkHierarchy(base)).toBeNull();
  });

  it.each([
    [{ targetId: 'mod' }, 'SELF'],
    [{ targetId: 'bot' }, 'BOT_ITSELF'],
    [{ targetId: 'owner' }, 'TARGET_IS_OWNER'],
    [{ targetPosition: 5 }, 'ACTOR_TOO_LOW'],
    [{ targetPosition: 6 }, 'ACTOR_TOO_LOW'],
    [{ botPosition: 2 }, 'BOT_TOO_LOW'],
  ] as const)('%o -> %s', (patch, expected) => {
    expect(checkHierarchy({ ...base, ...patch })).toBe(expected);
  });

  it('le propriétaire passe outre la hiérarchie des rôles, pas celle du bot', () => {
    expect(checkHierarchy({ ...base, actorId: 'owner', actorPosition: 0, targetPosition: 8 })).toBeNull();
    expect(checkHierarchy({ ...base, actorId: 'owner', targetPosition: 12 })).toBe('BOT_TOO_LOW');
  });

  it('un avertissement ignore la position du bot', () => {
    expect(checkHierarchy({ ...base, botPosition: 0, botMustOutrank: false })).toBeNull();
  });
});

describe('ModerationService', () => {
  let db: Db;
  let bus: EventBus<BotEvents>;
  let now: number;
  let mod: ModerationService;
  let created: BotEvents['moderation:caseCreated'][];

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    bus = new EventBus<BotEvents>();
    created = [];
    bus.on('moderation:caseCreated', (e) => void created.push(e));
    now = 1_700_000_000_000;
    mod = new ModerationService({ db, bus }, { clock: () => now });
  });
  afterEach(() => db.close());

  const warn = (guildId: string, targetId: string, reason = 'spam') =>
    mod.createCase({ guildId, action: 'warn', targetId, moderatorId: 'mod', reason });

  it('numérote les cas par serveur et émet moderation:caseCreated', () => {
    expect(warn('g1', 'u').caseNumber).toBe(1);
    expect(warn('g1', 'u').caseNumber).toBe(2);
    expect(warn('g2', 'u').caseNumber).toBe(1);
    expect(created.map((e) => [e.guildId, e.action, e.targetId])).toEqual([
      ['g1', 'warn', 'u'],
      ['g1', 'warn', 'u'],
      ['g2', 'warn', 'u'],
    ]);
  });

  it('enregistre durée, expiration, métadonnées et normalise la raison', () => {
    const c = mod.createCase({
      guildId: 'g',
      action: 'timeout',
      targetId: 'u',
      moderatorId: 'mod',
      reason: '   ',
      durationMs: HOUR,
    });
    expect(c).toMatchObject({ reason: null, durationMs: HOUR, expiresAt: now + HOUR, revoked: false, createdAt: now });
    const p = mod.createCase({ guildId: 'g', action: 'purge', targetId: 'chan', moderatorId: 'mod', metadata: { deleted: 12 } });
    expect(mod.getCase('g', p.caseNumber)?.metadata).toEqual({ deleted: 12 });
    expect(warn('g', 'u', 'x'.repeat(600)).reason).toHaveLength(500);
  });

  it('liste les cas du plus récent au plus ancien et compte les avertissements actifs', () => {
    warn('g', 'u');
    mod.createCase({ guildId: 'g', action: 'kick', targetId: 'u', moderatorId: 'mod' });
    warn('g', 'u');
    warn('g', 'autre');
    expect(mod.listCases('g', 'u').map((c) => c.caseNumber)).toEqual([3, 2, 1]);
    expect(mod.listCases('g', 'u', { limit: 1 })).toHaveLength(1);
    expect(mod.countActiveWarns('g', 'u')).toBe(2);
  });

  it('révoque un avertissement en le gardant au journal', () => {
    warn('g', 'u');
    mod.createCase({ guildId: 'g', action: 'ban', targetId: 'u', moderatorId: 'mod' });
    now += 1_000;
    const r = mod.revokeWarn('g', 1, 'admin', 'erreur');
    expect(r.ok && r.case.metadata).toEqual({ revokedBy: 'admin', revokedAt: now, revokeReason: 'erreur' });
    expect(mod.countActiveWarns('g', 'u')).toBe(0);
    expect(mod.listCases('g', 'u').map((c) => c.action)).toEqual(['ban']);
    expect(mod.listCases('g', 'u', { includeRevoked: true })).toHaveLength(2);

    expect(mod.revokeWarn('g', 1, 'admin', null)).toMatchObject({ ok: false, code: 'ALREADY_REVOKED' });
    expect(mod.revokeWarn('g', 2, 'admin', null)).toMatchObject({ ok: false, code: 'NOT_A_WARN' });
    expect(mod.revokeWarn('g', 99, 'admin', null)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(mod.revokeWarn('autre', 1, 'admin', null)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('le salon de logs cohabite avec les réglages d’économie', () => {
    const eco = new EconomyService({ db, bus, logger: nullLogger });
    expect(mod.getLogChannel('g')).toBeNull();
    mod.setLogChannel('g', 'logs');
    eco.updateSettings('g', { dailyAmount: 42 });
    expect(mod.getLogChannel('g')).toBe('logs');
    mod.setLogChannel('g', null);
    expect(mod.getLogChannel('g')).toBeNull();
    expect(eco.getSettings('g').dailyAmount).toBe(42);
  });
});

describe('rendu des sanctions', () => {
  const sample = {
    id: 1,
    guildId: 'g',
    caseNumber: 7,
    action: 'timeout' as const,
    targetId: '123',
    moderatorId: '456',
    reason: 'Spam **massif**',
    durationMs: 90 * MIN,
    expiresAt: 1_700_005_400_000,
    metadata: null,
    revoked: false,
    createdAt: 1_700_000_000_000,
  };

  it('embed de log complet et valide', () => {
    const json = caseEmbed(sample).toJSON();
    expect(json.title).toBe('🔇 Cas #7 — Exclusion temporaire');
    const fields = Object.fromEntries((json.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields['Membre']).toContain('<@123>');
    expect(fields['Durée']).toBe('1 h 30 min (fin <t:1700005400:R>)');
    expect(fields['Raison']).toBe('Spam \\*\\*massif\\*\\*');
  });

  it('purge : salon et nombre de messages', () => {
    const json = caseEmbed({
      ...sample,
      action: 'purge',
      targetId: 'chan',
      durationMs: null,
      expiresAt: null,
      reason: null,
      metadata: { deleted: 12, authorId: '999' },
    }).toJSON();
    const fields = Object.fromEntries((json.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields['Salon']).toBe('<#chan>');
    expect(fields['Messages supprimés']).toBe('12 de <@999>');
    expect(fields['Raison']).toBe('*Aucune raison fournie*');
  });

  it('ligne barrée pour un cas révoqué, MP et raison d’audit', () => {
    expect(caseLine({ ...sample, action: 'warn', revoked: true })).toMatch(/^~~\*\*#7\*\*.*~~ \*\(révoqué\)\*/);
    expect(sanctionDm('timeout', 'Mon *serveur*', null, HOUR)).toContain('Mon \\*serveur\\*');
    expect(sanctionDm('timeout', 'S', null, HOUR)).toContain('1 h');
    expect(auditReason('mod#0', 'x'.repeat(600))).toHaveLength(512);
    expect(auditReason('mod#0', null)).toBe('mod#0 : aucune raison fournie');
  });
});
