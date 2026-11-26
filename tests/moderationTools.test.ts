import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import {
  CooldownLimiter,
  DUPLICATE_WINDOW_MS,
  normalizeContent,
  SpamDetector,
  type SpamRules,
  type TrackedMessage,
} from '../src/modules/moderation/automod/detector.js';
import {
  AutomodSettingsStore,
  DEFAULT_AUTOMOD,
  formatFlood,
  parseAutomodTimeout,
  parseDuplicates,
  parseFlood,
} from '../src/modules/moderation/automod/settings.js';
import {
  bulkTranscript,
  clip,
  deleteEmbed,
  editEmbed,
} from '../src/modules/moderation/discord/messageLogRender.js';
import { caseEmbed } from '../src/modules/moderation/discord/render.js';
import { ModerationService } from '../src/modules/moderation/ModerationService.js';

const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);
const G = 'g';

describe('automod : détection', () => {
  const FLOOD: SpamRules = { floodMessages: 5, floodSeconds: 5, duplicateCount: 0 };
  const DUP: SpamRules = { floodMessages: 0, floodSeconds: 5, duplicateCount: 3 };
  let seq = 0;
  const msg = (at: number, content = `message ${++seq}`, userId = 'u', channelId = 'c'): TrackedMessage => ({
    guildId: G,
    userId,
    channelId,
    messageId: `m${++seq}`,
    content,
    at,
  });

  it('détecte le flood dans la fenêtre, pas quand les messages sont espacés', () => {
    const d = new SpamDetector();
    // 1,3 s d'écart : jamais 5 messages dans une même fenêtre de 5 s.
    for (let i = 0; i < 10; i++) expect(d.record(msg(T0 + i * 1_300), FLOOD)).toBeNull();

    const burst = new SpamDetector();
    const results = [0, 500, 1_000, 1_500, 2_000].map((dt, i) => burst.record(msg(T0 + dt, `x${i}`, 'u', i % 2 ? 'a' : 'b'), FLOOD));
    expect(results.slice(0, 4)).toEqual([null, null, null, null]);
    const infraction = results[4];
    expect(infraction?.kind).toBe('flood');
    expect(infraction?.messages).toHaveLength(5);
    expect(new Set(infraction?.messages.map((m) => m.channelId))).toEqual(new Set(['a', 'b']));
    expect(infraction?.detail).toBe('5 messages en 5 s');
  });

  it("repart de zéro après une infraction et sépare les membres", () => {
    const d = new SpamDetector();
    for (let i = 0; i < 4; i++) d.record(msg(T0 + i * 100), FLOOD);
    for (let i = 0; i < 4; i++) expect(d.record(msg(T0 + i * 100, 'y', 'autre'), FLOOD)).toBeNull();
    expect(d.record(msg(T0 + 500), FLOOD)).not.toBeNull();
    expect(d.record(msg(T0 + 600), FLOOD)).toBeNull();
  });

  it('détecte les messages identiques (casse et espaces ignorés)', () => {
    const d = new SpamDetector();
    expect(d.record(msg(T0, 'Achetez  mes NFT'), DUP)).toBeNull();
    expect(d.record(msg(T0 + 10_000, 'autre chose'), DUP)).toBeNull();
    expect(d.record(msg(T0 + 20_000, 'achetez mes nft'), DUP)).toBeNull();
    const r = d.record(msg(T0 + 30_000, ' ACHETEZ MES NFT '), DUP);
    expect(r?.kind).toBe('duplicate');
    expect(r?.messages).toHaveLength(3);
  });

  it('ignore les doublons trop anciens et les messages sans texte', () => {
    const d = new SpamDetector();
    d.record(msg(T0, 'salut'), DUP);
    d.record(msg(T0 + 1_000, 'salut'), DUP);
    expect(d.record(msg(T0 + DUPLICATE_WINDOW_MS + 1, 'salut'), DUP)).toBeNull();
    for (let i = 0; i < 5; i++) expect(d.record(msg(T0 + i, ''), DUP)).toBeNull();
    expect(normalizeContent('  A\n  b ')).toBe('a b');
  });

  it('ne garde rien quand tout est désactivé et oublie les membres silencieux', () => {
    const d = new SpamDetector();
    d.record(msg(T0), { floodMessages: 0, floodSeconds: 5, duplicateCount: 0 });
    expect(d.size).toBe(0);
    d.record(msg(T0, 'a', 'u1'), FLOOD);
    d.record(msg(T0, 'a', 'u2'), FLOOD);
    expect(d.size).toBe(2);
    d.record(msg(T0 + 120_000, 'a', 'u3'), FLOOD);
    expect(d.size).toBe(1);
  });

  it('limite les avertissements automatiques à un par période', () => {
    const limiter = new CooldownLimiter(60_000);
    expect(limiter.take('g:u', T0)).toBe(true);
    expect(limiter.take('g:u', T0 + 59_999)).toBe(false);
    expect(limiter.take('g:v', T0 + 1)).toBe(true);
    expect(limiter.take('g:u', T0 + 60_000)).toBe(true);
  });
});

describe('automod : réglages', () => {
  it('lit le flood au format messages/secondes', () => {
    expect(parseFlood('6/5')).toEqual({ ok: true, value: { floodMessages: 6, floodSeconds: 5 } });
    expect(parseFlood(' 10 / 8s ')).toEqual({ ok: true, value: { floodMessages: 10, floodSeconds: 8 } });
    for (const off of ['0', '', 'off', 'désactivé']) expect(parseFlood(off)).toEqual({ ok: true, value: null });
    for (const bad of ['2/5', '6/0', '6/61', '51/5', '6', 'beaucoup']) expect(parseFlood(bad).ok, bad).toBe(false);
  });

  it('lit les répétitions et la durée d’exclusion', () => {
    expect(parseDuplicates('3')).toEqual({ ok: true, value: 3 });
    expect(parseDuplicates('0')).toEqual({ ok: true, value: 0 });
    for (const bad of ['1', '21', 'trois']) expect(parseDuplicates(bad).ok, bad).toBe(false);
    expect(parseAutomodTimeout('5m')).toEqual({ ok: true, value: 300_000 });
    expect(parseAutomodTimeout('1h30min')).toEqual({ ok: true, value: 5_400_000 });
    expect(parseAutomodTimeout('0')).toEqual({ ok: true, value: 0 });
    expect(parseAutomodTimeout('29j').ok).toBe(false);
    expect(formatFlood({ floodMessages: 6, floodSeconds: 5, duplicateCount: 0 })).toBe('6/5');
    expect(formatFlood(DEFAULT_AUTOMOD)).toBe('0');
  });

  it('enregistre les réglages par serveur, désactivés par défaut', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, migrations);
    const store = new AutomodSettingsStore(db);
    expect(store.get(G)).toEqual(DEFAULT_AUTOMOD);
    const custom = { floodMessages: 6, floodSeconds: 5, duplicateCount: 3, timeoutMs: 600_000, discordWarns: true };
    store.set(G, custom);
    expect(new AutomodSettingsStore(db).get(G)).toEqual(custom);
    expect(store.get('autre')).toEqual(DEFAULT_AUTOMOD);
    expect(() => store.set(G, { ...custom, floodMessages: 2 })).toThrow(/CHECK/);
    db.close();
  });
});

describe('notes de modération', () => {
  let db: Db;
  let now: number;
  let mod: ModerationService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = T0;
    mod = new ModerationService({ db, bus: new EventBus<BotEvents>() }, { clock: () => now });
  });

  afterEach(() => db.close());

  it('ajoute, liste (récentes d’abord), compte et supprime, serveur par serveur', () => {
    const a = mod.addNote(G, 'u', 'mod1', '  Insulte en vocal, à surveiller  ');
    now += 1_000;
    const b = mod.addNote(G, 'u', 'mod2', 'Excuses présentées');
    mod.addNote('autre', 'u', 'mod1', 'Autre serveur');

    expect(a.content).toBe('Insulte en vocal, à surveiller');
    expect(mod.listNotes(G, 'u').map((n) => n.id)).toEqual([b.id, a.id]);
    expect(mod.countNotes(G, 'u')).toBe(2);
    expect(mod.listNotes(G, 'u', 1)).toHaveLength(1);

    expect(mod.getNote('autre', a.id)).toBeNull();
    expect(mod.deleteNote('autre', a.id)).toBe(false);
    expect(mod.deleteNote(G, a.id)).toBe(true);
    expect(mod.countNotes(G, 'u')).toBe(1);
  });

  it('ne compte pas comme avertissement', () => {
    mod.addNote(G, 'u', 'mod', 'note');
    expect(mod.countActiveWarns(G, 'u')).toBe(0);
    expect(mod.listCases(G, 'u')).toEqual([]);
    expect(() => mod.addNote(G, 'u', 'mod', '   ')).toThrow();
  });

  it('garde le salon des logs de messages à part de celui des sanctions', () => {
    mod.setLogChannel(G, 'sanctions');
    mod.setMessageLogChannel(G, 'messages');
    expect(mod.getLogChannel(G)).toBe('sanctions');
    expect(mod.getMessageLogChannel(G)).toBe('messages');
    mod.setMessageLogChannel(G, null);
    expect(mod.getMessageLogChannel(G)).toBeNull();
    expect(mod.getLogChannel(G)).toBe('sanctions');
  });

  it('signale l’automod en pied de cas', () => {
    const c = mod.createCase({
      guildId: G,
      action: 'warn',
      targetId: 'u',
      moderatorId: 'bot',
      reason: 'Automod : flood',
      metadata: { auto: true, automod: 'flood' },
    });
    expect(caseEmbed(c).data.footer?.text).toBe('Automatique : automod du bot');
    const d = mod.createCase({ ...c, reason: 'x', metadata: { auto: true, automod: 'discord' } });
    expect(caseEmbed(d).data.footer?.text).toBe('Automatique : AutoMod de Discord');
  });
});

describe('logs de messages', () => {
  const author = { id: '42', tag: 'alice', avatarUrl: 'https://cdn/a.png' };

  it("n'émet rien si le texte n'a pas changé", () => {
    const base = { author, channelId: 'c', url: 'https://discord.com/x', at: T0 };
    expect(editEmbed({ ...base, before: 'salut', after: 'salut' })).toBeNull();
    const e = editEmbed({ ...base, before: 'salut', after: 'salut **toi**' });
    expect(e?.data.fields?.map((f) => f.value)).toEqual(['salut', 'salut \\*\\*toi\\*\\*']);
    const unknown = editEmbed({ ...base, before: null, after: 'x' });
    expect(unknown?.data.fields?.[0]?.value).toMatch(/Inconnu/);
  });

  it('coupe les contenus trop longs pour un embed', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    const e = editEmbed({ author, channelId: 'c', url: 'u', at: T0, before: 'a'.repeat(2000), after: 'b' });
    expect(e?.data.fields?.[0]?.value).toHaveLength(1024);
  });

  it('décrit une suppression, auteur connu ou non', () => {
    const known = deleteEmbed({
      author,
      channelId: 'c',
      messageId: 'm',
      content: 'oups',
      attachments: ['photo.png'],
      createdAt: T0 - 60_000,
      at: T0,
    });
    expect(known.data.description).toContain('oups');
    expect(known.data.fields?.[0]?.value).toBe('• photo.png');
    const partial = deleteEmbed({ author: null, channelId: 'c', messageId: 'm', content: null, attachments: [], createdAt: T0, at: T0 });
    expect(partial.data.author?.name).toBe('Message supprimé');
    expect(partial.data.description).toMatch(/Inconnu/);
  });

  it('transcrit une suppression en masse dans l’ordre chronologique', () => {
    const text = bulkTranscript([
      { authorTag: 'bob', authorId: '2', createdAt: T0 + 1_000, content: 'deux', attachments: [] },
      { authorTag: 'alice', authorId: '1', createdAt: T0, content: 'un', attachments: ['a.png'] },
      { authorTag: null, authorId: null, createdAt: T0 + 2_000, content: null, attachments: [] },
    ]);
    expect(text.split('\n')).toEqual([
      '[2026-11-26 12:00:00 UTC] alice (1) : un [pièces jointes : a.png]',
      '[2026-11-26 12:00:01 UTC] bob (2) : deux',
      '[2026-11-26 12:00:02 UTC] Auteur inconnu : [contenu inconnu : message envoyé avant le démarrage du bot]',
    ]);
  });
});
