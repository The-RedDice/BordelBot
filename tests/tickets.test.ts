import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/core/commands/registry.js';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import {
  DEFAULT_TICKET_SETTINGS,
  ticketChannelName,
  TicketService,
  ticketTranscript,
} from '../src/modules/tickets/TicketService.js';

const G = 'g';
const T0 = Date.UTC(2026, 10, 26, 12);

describe('TicketService', () => {
  let db: Db;
  let now: number;
  let svc: TicketService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = T0;
    svc = new TicketService(db, () => now);
  });

  afterEach(() => db.close());

  it('enregistre les réglages (message d’accueil vide = défaut)', () => {
    expect(svc.getSettings(G)).toEqual(DEFAULT_TICKET_SETTINGS);
    svc.setSettings(G, { categoryId: 'cat', staffRoleId: 'staff', transcriptChannelId: 'logs', welcomeMessage: '   ' });
    expect(svc.getSettings(G)).toEqual({ categoryId: 'cat', staffRoleId: 'staff', transcriptChannelId: 'logs', welcomeMessage: null });
    svc.setSettings(G, { ...DEFAULT_TICKET_SETTINGS, welcomeMessage: ' Bonjour ! ' });
    expect(svc.getSettings(G).welcomeMessage).toBe('Bonjour !');
  });

  it('numérote par serveur et n’accepte qu’un ticket ouvert par membre', () => {
    expect(svc.nextNumber(G)).toBe(1);
    const t1 = svc.create({ guildId: G, number: svc.nextNumber(G), channelId: 'c1', openerId: 'u', subject: '  Problème de rôle  ' });
    expect(t1).toMatchObject({ number: 1, subject: 'Problème de rôle', status: 'open', claimedBy: null, createdAt: T0 });
    expect(svc.openTicketOf(G, 'u')?.id).toBe(t1.id);
    expect(() => svc.create({ guildId: G, number: 2, channelId: 'c2', openerId: 'u', subject: 'Encore' })).toThrow(/UNIQUE/);
    expect(svc.create({ guildId: G, number: 2, channelId: 'c3', openerId: 'v', subject: 'x' }).number).toBe(2);
    expect(svc.nextNumber('autre')).toBe(1);
    expect(svc.countOpen(G)).toBe(2);
  });

  it('prise en charge, puis fermeture une seule fois', () => {
    const t = svc.create({ guildId: G, number: 1, channelId: 'c1', openerId: 'u', subject: 'Aide' });
    expect(svc.claim(t.id, 'staff')).toBe(true);
    now += 60_000;
    expect(svc.close(t.id, 'staff', '  Résolu  ')).toBe(true);
    expect(svc.close(t.id, 'u', null)).toBe(false);
    expect(svc.byChannel('c1')).toMatchObject({ status: 'closed', claimedBy: 'staff', closedBy: 'staff', closeReason: 'Résolu', closedAt: T0 + 60_000 });
    expect(svc.claim(t.id, 'autre')).toBe(false);
    // Le membre peut rouvrir un ticket une fois le précédent fermé.
    expect(svc.openTicketOf(G, 'u')).toBeNull();
    expect(svc.create({ guildId: G, number: 2, channelId: 'c2', openerId: 'u', subject: 'Nouveau' }).number).toBe(2);
  });

  it('un salon supprimé ferme le ticket sans auteur', () => {
    const t = svc.create({ guildId: G, number: 1, channelId: 'c1', openerId: 'u', subject: 'Aide' });
    expect(svc.close(t.id, null, 'salon supprimé')).toBe(true);
    expect(svc.byId(t.id)).toMatchObject({ closedBy: null, closeReason: 'salon supprimé' });
  });
});

describe('noms et transcriptions', () => {
  it('nomme le salon d’après le numéro et le pseudo', () => {
    expect(ticketChannelName(42, 'Élodie_du 92')).toBe('ticket-42-elodie-du-92');
    expect(ticketChannelName(7, '★★★')).toBe('ticket-7');
    expect(ticketChannelName(1, 'a'.repeat(80)).length).toBeLessThanOrEqual(100);
  });

  it('transcrit le ticket dans l’ordre chronologique', () => {
    const ticket = {
      id: 1,
      guildId: G,
      number: 3,
      channelId: 'c',
      openerId: 'u',
      subject: 'Rôle manquant',
      status: 'closed' as const,
      claimedBy: 's',
      createdAt: T0,
      closedAt: T0 + 120_000,
      closedBy: 's',
      closeReason: 'Résolu',
    };
    const text = ticketTranscript(ticket, 'Bordel', [
      { authorTag: 'staff', authorId: 's', createdAt: T0 + 60_000, content: 'Corrigé !', attachments: [], bot: false },
      { authorTag: 'alice', authorId: 'u', createdAt: T0 + 1_000, content: 'Il me manque un rôle', attachments: ['capture.png'], bot: false },
    ]).split('\n');
    expect(text[0]).toBe('Ticket #3 — Bordel');
    expect(text).toContain('Fermé par s le 2026-11-26 12:02:00 UTC : Résolu');
    expect(text.slice(-2)).toEqual([
      '[2026-11-26 12:00:01 UTC] alice (u) : Il me manque un rôle [pièces jointes : capture.png]',
      '[2026-11-26 12:01:00 UTC] staff (s) : Corrigé !',
    ]);
  });

  it('le module déclare /ticket et une section de réglages', async () => {
    const { modules } = await import('../src/modules/index.js');
    const registry = new CommandRegistry(modules);
    expect(registry.allCommands().map((c) => c.data.name)).toContain('ticket');
    expect(registry.getComponentHandler('ticket:open')).toBeDefined();
  });
});
