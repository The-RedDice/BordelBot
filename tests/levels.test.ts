import { SlashCommandSubcommandBuilder, SlashCommandSubcommandGroupBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/core/commands/registry.js';
import type { BotContext } from '../src/core/context.js';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import { nullLogger } from '../src/core/logger.js';
import { EconomyService } from '../src/modules/economy/EconomyService.js';
import { ProgressService } from '../src/modules/economy/progress/ProgressService.js';
import { levelInfo, levelOf, MAX_XP, progressBar, totalXpForLevel, xpToNextLevel } from '../src/modules/levels/curve.js';
import { formatVoiceTime } from '../src/modules/levels/discord/commands.js';
import { parseXpRange } from '../src/modules/levels/discord/settings.js';
import { DEFAULT_LEVEL_SETTINGS, LevelService } from '../src/modules/levels/LevelService.js';
import { formatRoleRewards, parseRoleRewards, rewardRoles } from '../src/modules/levels/rewards.js';
import { activeVoiceUsers } from '../src/modules/levels/voice.js';

const G = 'guild';

describe('courbe d’XP', () => {
  it('coûte 100 XP pour le niveau 1 puis 5L² + 50L + 100', () => {
    expect(xpToNextLevel(0)).toBe(100);
    expect(xpToNextLevel(1)).toBe(155);
    expect(totalXpForLevel(2)).toBe(255);
  });

  it('déduit le niveau et la progression de l’XP total', () => {
    expect(levelInfo(0)).toEqual({ level: 0, into: 0, needed: 100 });
    expect(levelInfo(99).level).toBe(0);
    expect(levelInfo(100)).toEqual({ level: 1, into: 0, needed: 155 });
    expect(levelInfo(300)).toEqual({ level: 2, into: 45, needed: 220 });
    for (const l of [5, 10, 42]) expect(levelOf(totalXpForLevel(l))).toBe(l);
    expect(levelOf(MAX_XP)).toBeGreaterThan(500);
  });

  it('trace une barre de progression bornée', () => {
    expect(progressBar(0, 4)).toBe('▱▱▱▱');
    expect(progressBar(0.5, 4)).toBe('▰▰▱▱');
    expect(progressBar(2, 4)).toBe('▰▰▰▰');
  });
});

describe('rôles de niveau', () => {
  const roles = [
    { id: '111111111111111111', name: 'Habitué' },
    { id: '222222222222222222', name: 'Pilier' },
    { id: '333333333333333333', name: 'pilier' },
  ];

  it('lit mentions, IDs et noms, triés par niveau', () => {
    const r = parseRoleRewards('10 = <@&222222222222222222>\n\n5 = @habitué\n20: 333333333333333333', roles);
    expect(r).toEqual({
      ok: true,
      value: [
        { level: 5, roleId: '111111111111111111' },
        { level: 10, roleId: '222222222222222222' },
        { level: 20, roleId: '333333333333333333' },
      ],
    });
    if (r.ok) expect(formatRoleRewards(r.value, roles)).toBe('5 = @Habitué\n10 = @Pilier\n20 = @pilier');
  });

  it('refuse les lignes invalides, doublons, rôles inconnus ou ambigus', () => {
    expect(parseRoleRewards('cinq = @Habitué', roles).ok).toBe(false);
    expect(parseRoleRewards('0 = @Habitué', roles).ok).toBe(false);
    expect(parseRoleRewards('5 = @Habitué\n5 = 222222222222222222', roles).ok).toBe(false);
    expect(parseRoleRewards('5 = @Habitué\n6 = @Habitué', roles).ok).toBe(false);
    expect(parseRoleRewards('5 = @Inconnu', roles).ok).toBe(false);
    const ambiguous = parseRoleRewards('5 = @Pilier', roles);
    expect(ambiguous.ok ? null : ambiguous.message).toMatch(/ID/);
    expect(parseRoleRewards('', roles)).toEqual({ ok: true, value: [] });
  });

  it('cumule les paliers ou ne garde que le plus haut', () => {
    const rewards = [
      { level: 5, roleId: 'a' },
      { level: 10, roleId: 'b' },
      { level: 20, roleId: 'c' },
    ];
    expect(rewardRoles(rewards, 12, true)).toEqual({ keep: ['a', 'b'], drop: ['c'] });
    expect(rewardRoles(rewards, 12, false)).toEqual({ keep: ['b'], drop: ['a', 'c'] });
    expect(rewardRoles(rewards, 2, true)).toEqual({ keep: [], drop: ['a', 'b', 'c'] });
  });
});

describe('XP vocal : membres actifs', () => {
  const state = (userId: string, channelId: string | null, extra: { bot?: boolean; deaf?: boolean } = {}) => ({
    userId,
    channelId,
    bot: extra.bot ?? false,
    deaf: extra.deaf ?? false,
  });

  it('exige deux membres actifs, hors AFK, sans sourdine casque ni bots', () => {
    expect(
      activeVoiceUsers(
        [
          state('a', 'v1'),
          state('b', 'v1'),
          state('c', 'v2'),
          state('bot', 'v2', { bot: true }),
          state('d', 'v3'),
          state('e', 'v3', { deaf: true }),
          state('f', 'afk'),
          state('g', 'afk'),
          state('h', null),
        ],
        'afk',
      ),
    ).toEqual(['a', 'b']);
  });
});

describe('réglages : saisie', () => {
  it('lit une plage d’XP', () => {
    expect(parseXpRange('15-25')).toEqual([15, 25]);
    expect(parseXpRange(' 20 ')).toEqual([20, 20]);
    expect(parseXpRange('10 à 30')).toEqual([10, 30]);
    expect(parseXpRange('abc')).toBeNull();
  });

  it('formate le temps en vocal', () => {
    expect(formatVoiceTime(59)).toBe('0 min');
    expect(formatVoiceTime(25 * 60)).toBe('25 min');
    expect(formatVoiceTime(3 * 3600 + 5 * 60)).toBe('3 h 5 min');
  });
});

describe('LevelService', () => {
  let db: Db;
  let now: number;
  let roll: number;
  let levels: LevelService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = 1_700_000_000_000;
    roll = 0;
    levels = new LevelService(db, { clock: () => now, rng: () => roll });
  });

  it('donne de l’XP au plus une fois par délai, mais compte chaque message', () => {
    const first = levels.onMessage(G, 'u');
    expect(first).toMatchObject({ xpBefore: 0, xpAfter: 15, levelBefore: 0, levelAfter: 0 });
    now += 30_000;
    expect(levels.onMessage(G, 'u')).toBeNull();
    now += 30_000;
    roll = 0.999;
    expect(levels.onMessage(G, 'u')).toMatchObject({ xpBefore: 15, xpAfter: 40 });
    expect(levels.member(G, 'u')).toMatchObject({ xp: 40, messages: 3, rank: 1 });
  });

  it('signale la montée de niveau', () => {
    levels.setXp(G, 'u', 95);
    now += 60_000;
    expect(levels.onMessage(G, 'u')).toMatchObject({ levelBefore: 0, levelAfter: 1 });
  });

  it('respecte les réglages du serveur (XP désactivé, délai nul)', () => {
    expect(levels.updateSettings(G, { ...DEFAULT_LEVEL_SETTINGS, messageXpMin: 0, messageXpMax: 0 }).ok).toBe(true);
    expect(levels.onMessage(G, 'u')).toBeNull();
    expect(levels.member(G, 'u').messages).toBe(1);

    levels.updateSettings(G, { ...DEFAULT_LEVEL_SETTINGS, messageXpMin: 10, messageXpMax: 10, cooldownSeconds: 0 });
    expect(levels.onMessage(G, 'u')?.xpAfter).toBe(10);
    expect(levels.onMessage(G, 'u')?.xpAfter).toBe(20);
  });

  it('valide les réglages', () => {
    const bad = (patch: Partial<typeof DEFAULT_LEVEL_SETTINGS>) => levels.updateSettings(G, { ...DEFAULT_LEVEL_SETTINGS, ...patch }).ok;
    expect(bad({ messageXpMin: 30, messageXpMax: 20 })).toBe(false);
    expect(bad({ messageXpMax: 5000 })).toBe(false);
    expect(bad({ cooldownSeconds: 99_999 })).toBe(false);
    expect(bad({ announce: 'channel', announceChannelId: null })).toBe(false);
    expect(bad({ announce: 'channel', announceChannelId: '123' })).toBe(true);
    expect(levels.getSettings(G).announceChannelId).toBe('123');
    // Le salon n'est conservé que pour le mode « salon dédié ».
    levels.updateSettings(G, { ...DEFAULT_LEVEL_SETTINGS, announce: 'here', announceChannelId: '123' });
    expect(levels.getSettings(G).announceChannelId).toBeNull();
  });

  it('crédite l’XP vocal au prorata et cumule le temps', () => {
    const changes = levels.onVoice(G, ['a', 'b'], 60);
    expect(changes.map((c) => c.xpAfter)).toEqual([5, 5]);
    levels.onVoice(G, ['a'], 120);
    expect(levels.member(G, 'a')).toMatchObject({ xp: 15, voiceSeconds: 180 });
    levels.updateSettings(G, { ...DEFAULT_LEVEL_SETTINGS, voiceXpPerMinute: 0 });
    expect(levels.onVoice(G, ['a'], 60)).toEqual([]);
  });

  it('ajuste l’XP en restant dans les bornes, et classe les membres', () => {
    expect(levels.adjustXp(G, 'a', 500)).toMatchObject({ xpAfter: 500, levelAfter: 3 });
    expect(levels.adjustXp(G, 'a', -10_000).xpAfter).toBe(0);
    expect(levels.setXp(G, 'a', MAX_XP * 2).xpAfter).toBe(MAX_XP);
    levels.setXp(G, 'b', 300);
    levels.setXp(G, 'c', 300);
    levels.setXp('autre', 'd', 1_000_000);
    expect(levels.leaderboard(G).map((r) => r.userId)).toEqual(['a', 'b', 'c']);
    expect(levels.member(G, 'c').rank).toBe(2);
    expect(levels.member(G, 'zzz')).toEqual({ xp: 0, messages: 0, voiceSeconds: 0, rank: null });
  });

  it('enregistre et remplace les rôles de niveau', () => {
    levels.setRoleRewards(G, [
      { level: 5, roleId: 'a' },
      { level: 1, roleId: 'b' },
    ]);
    expect(levels.getRoleRewards(G)).toEqual([
      { level: 1, roleId: 'b' },
      { level: 5, roleId: 'a' },
    ]);
    levels.setRoleRewards(G, []);
    expect(levels.getRoleRewards(G)).toEqual([]);
  });
});

describe('classements par statistique', () => {
  it('classe les membres et ignore les valeurs nulles', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, migrations);
    const ctx = { db, bus: new EventBus<BotEvents>(nullLogger), logger: nullLogger };
    const progress = new ProgressService(db, new EconomyService(ctx));
    progress.record(G, 'a', [{ stat: 'games_won', add: 3 }]);
    progress.record(G, 'b', [{ stat: 'games_won', add: 7 }]);
    progress.record(G, 'c', [{ stat: 'market_profit_total', add: -50 }]);
    expect(progress.top(G, 'games_won')).toEqual([
      { userId: 'b', value: 7 },
      { userId: 'a', value: 3 },
    ]);
    expect(progress.rank(G, 'a', 'games_won')).toBe(2);
    expect(progress.rank(G, 'c', 'market_profit_total')).toBeNull();
    expect(progress.top(G, 'market_profit_total')).toEqual([]);
  });
});

describe('commandes parentes', () => {
  const ctx = {} as BotContext;
  const calls: string[] = [];
  const sub = (name: string) => new SlashCommandSubcommandBuilder().setName(name).setDescription(name);
  const fakeInteraction = (group: string | null, subcommand: string) =>
    ({ options: { getSubcommandGroup: () => group, getSubcommand: () => subcommand } }) as unknown as ChatInputCommandInteraction;

  it('assemble les contributions de plusieurs modules et route chaque appel', async () => {
    const registry = new CommandRegistry([
      { name: 'a', subcommands: [{ parent: 'jeu', data: sub('taupe'), execute: async () => void calls.push('taupe') }] },
      {
        name: 'b',
        subcommands: [
          { parent: 'jeu', data: sub('duel'), execute: async () => void calls.push('duel') },
          {
            parent: 'admin',
            data: new SlashCommandSubcommandGroupBuilder().setName('xp').setDescription('xp').addSubcommand(sub('ajouter')),
            execute: async () => void calls.push('xp'),
          },
        ],
      },
    ]);
    const jeu = registry.getCommand('jeu');
    expect(jeu?.data.toJSON().options?.map((o) => o.name)).toEqual(['taupe', 'duel']);
    expect(registry.getCommand('admin')?.data.toJSON().default_member_permissions).toBe('32');
    expect(registry.getCommand('top')).toBeUndefined();

    await jeu?.execute(fakeInteraction(null, 'duel'), ctx);
    await registry.getCommand('admin')?.execute(fakeInteraction('xp', 'ajouter'), ctx);
    expect(calls).toEqual(['duel', 'xp']);
  });

  it('refuse une sous-commande en double ou une commande qui masque une parente', () => {
    const dup = { parent: 'jeu' as const, data: sub('taupe'), execute: async () => undefined };
    expect(() => new CommandRegistry([{ name: 'a', subcommands: [dup] }, { name: 'b', subcommands: [dup] }])).toThrow(/deux fois/);
    expect(
      () => new CommandRegistry([{ name: 'a', commands: [{ data: { name: 'jeu', toJSON: () => ({ name: 'jeu', description: 'x' }) }, execute: async () => undefined }] }]),
    ).toThrow(/deux fois/);
  });

  it('les vrais modules regroupent les jeux sous /jeu', async () => {
    const { modules } = await import('../src/modules/index.js');
    const registry = new CommandRegistry(modules);
    const names = (cmd: string) => registry.getCommand(cmd)?.data.toJSON().options?.map((o) => o.name);
    expect(names('jeu')).toEqual(expect.arrayContaining(['taupe', 'pile-ou-face', 'machine-a-sous', 'duel']));
    expect(names('top')).toEqual(expect.arrayContaining(['fortune', 'niveaux', 'victoires', 'daily', 'bourse']));
    expect(names('profil')).toEqual(['general', 'succes', 'niveau']);
    expect(names('admin')).toEqual(['solde', 'boutique', 'export', 'xp']);
  });
});
