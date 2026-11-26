import { DiscordAPIError, RESTJSONErrorCodes, type Message, type SendableChannels } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { nullLogger } from '../src/core/logger.js';
import { GameSession } from '../src/modules/games/engine/GameSession.js';
import { seededRng } from '../src/modules/games/engine/rng.js';
import { MoleTable } from '../src/modules/games/mole/discord/MoleTable.js';
import type { BoardMessage } from '../src/modules/games/mole/discord/render.js';
import { createMoleLobby, createMoleMachine } from '../src/modules/games/mole/machine.js';
import { ManualScheduler } from './helpers/ManualScheduler.js';

const machine = createMoleMachine();
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Faux salon : enregistre les envois, éditions et suppressions. */
function fakeChannel() {
  const log: string[] = [];
  let n = 0;
  let editImpl = async (_: BoardMessage) => {};
  const makeMessage = (id: string): Message =>
    ({
      id,
      url: `https://discord.com/channels/g/c/${id}`,
      edit: vi.fn(async (payload: BoardMessage) => {
        log.push(`edit:${id}`);
        await editImpl(payload);
      }),
      delete: vi.fn(async () => void log.push(`delete:${id}`)),
    }) as unknown as Message;
  const channel = {
    send: vi.fn(async (payload: { content?: string }) => {
      const id = `m${++n}`;
      log.push(`send:${id}:${payload.content ?? 'board'}`);
      return makeMessage(id);
    }),
  } as unknown as SendableChannels;
  return { channel, log, setEdit: (fn: typeof editImpl) => (editImpl = fn) };
}

function setup() {
  const scheduler = new ManualScheduler();
  const session = new GameSession('s1', machine, createMoleLobby('alice'), {
    scheduler,
    clock: scheduler.clock,
    rng: seededRng(9),
  });
  const fake = fakeChannel();
  const onClosed = vi.fn();
  const table = new MoleTable(session, machine, fake.channel, nullLogger, onClosed);
  return { session, table, onClosed, ...fake };
}

describe('MoleTable', () => {
  it('regroupe les rendus de transitions rapprochées en une seule édition', async () => {
    const { session, table, log } = setup();
    await table.open();
    session.dispatch({ type: 'join', userId: 'bob' });
    session.dispatch({ type: 'join', userId: 'carol' });
    session.dispatch({ type: 'leave', userId: 'carol' });
    await flush();
    expect(log.filter((l) => l.startsWith('edit:'))).toHaveLength(1);
  });

  it('poste les notices dans l’ordre et remplace la notice précédente', async () => {
    const { session, table, log } = setup();
    await table.open();
    for (const p of ['bob', 'carol']) session.dispatch({ type: 'join', userId: p });
    session.dispatch({ type: 'start', userId: 'alice' });
    await flush();
    const sends = log.filter((l) => l.startsWith('send:'));
    expect(sends[1]).toContain('La partie commence');
    expect(sends[2]).toContain('à toi de donner un indice');
    // La notice de démarrage (m2) est supprimée après l'envoi de celle du tour (m3).
    expect(log.indexOf('delete:m2')).toBeGreaterThan(log.findIndex((l) => l.startsWith('send:m3')));
  });

  it('garde la notice finale et prévient le module à la fin', async () => {
    const { session, table, log, onClosed } = setup();
    await table.open();
    session.dispatch({ type: 'cancel', userId: 'alice' });
    expect(onClosed).toHaveBeenCalledOnce();
    await flush();
    expect(log.at(-1)).toContain('annulée');
    expect(log.some((l) => l.startsWith('delete:'))).toBe(false);
  });

  it('annule la partie si le plateau a été supprimé', async () => {
    const { session, table, setEdit } = setup();
    await table.open();
    setEdit(async () => {
      throw new DiscordAPIError(
        { code: RESTJSONErrorCodes.UnknownMessage, message: 'Unknown Message' },
        RESTJSONErrorCodes.UnknownMessage,
        404,
        'PATCH',
        '/channels/c/messages/m1',
        {},
      );
    });
    session.dispatch({ type: 'join', userId: 'bob' });
    await flush();
    expect(session.state).toMatchObject({ phase: 'cancelled', reason: 'host' });
  });

  it('une erreur réseau est loggée sans casser la file', async () => {
    const { session, table, setEdit, log } = setup();
    await table.open();
    setEdit(async () => {
      throw new Error('réseau');
    });
    session.dispatch({ type: 'join', userId: 'bob' });
    await flush();
    setEdit(async () => {});
    session.dispatch({ type: 'join', userId: 'carol' });
    await flush();
    expect(log.filter((l) => l.startsWith('edit:'))).toHaveLength(2);
    expect(session.state.phase).toBe('lobby');
  });
});
