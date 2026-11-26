import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import { nullLogger } from '../src/core/logger.js';
import { seededRng } from '../src/modules/games/engine/rng.js';
import { GameService } from '../src/modules/games/GameService.js';
import { createMoleLobby, createMoleMachine, currentTurnPlayer } from '../src/modules/games/mole/machine.js';
import { ManualScheduler } from './helpers/ManualScheduler.js';

const machine = createMoleMachine();

describe('GameService', () => {
  let db: Db;
  let bus: EventBus<BotEvents>;
  let scheduler: ManualScheduler;
  let service: GameService;
  let finished: BotEvents['game:finished'][];
  let n: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    bus = new EventBus<BotEvents>();
    finished = [];
    bus.on('game:finished', (e) => void finished.push(e));
    scheduler = new ManualScheduler();
    n = 0;
    service = new GameService(
      { db, bus, logger: nullLogger },
      { scheduler, clock: scheduler.clock, rng: seededRng(5), idFactory: () => `game-${++n}` },
    );
  });
  afterEach(() => db.close());

  const startIn = (channelId: string) =>
    service.start({ machine, initialState: createMoleLobby('alice'), guildId: 'g1', channelId, hostId: 'alice' });

  const row = (id: string) =>
    db.prepare('SELECT status, ended_at AS endedAt, state_json AS stateJson FROM game_sessions WHERE id = ?').get(id) as {
      status: string;
      endedAt: number | null;
      stateJson: string;
    };

  it('persiste la session et refuse une deuxième partie dans le même salon', () => {
    const r = startIn('c1');
    expect(r.ok).toBe(true);
    expect(row('game-1').status).toBe('lobby');
    expect(startIn('c1')).toMatchObject({ ok: false, error: { code: 'CHANNEL_BUSY' } });
    expect(startIn('c2').ok).toBe(true);
    expect(service.get('c1', machine)?.id).toBe('game-1');
    expect(service.get('c1', createMoleMachine())).toBeUndefined(); // autre machine : pas de cast abusif
  });

  it('snapshot à chaque transition, puis résultats et game:finished en fin de partie', async () => {
    const r = startIn('c1');
    if (!r.ok) throw new Error('start');
    const { session } = r;
    for (const p of ['bob', 'carol']) session.dispatch({ type: 'join', userId: p });
    session.dispatch({ type: 'start', userId: 'alice' });
    expect(row('game-1').status).toBe('running');
    expect(JSON.parse(row('game-1').stateJson).phase).toBe('clues');

    while (session.state.phase === 'clues') {
      session.dispatch({ type: 'clue', userId: currentTurnPlayer(session.state) as string, text: 'hmm' });
    }
    if (session.state.phase !== 'voting') throw new Error('voting attendu');
    const { moleId, players } = session.state;
    const innocent = players.find((p) => p !== moleId) as string;
    for (const voter of players) {
      const target = voter === innocent ? moleId : innocent;
      session.dispatch({ type: 'vote', userId: voter, targetId: target });
    }
    await Promise.resolve();

    expect(row('game-1')).toMatchObject({ status: 'finished' });
    expect(row('game-1').endedAt).not.toBeNull();
    const parts = db
      .prepare('SELECT user_id AS userId, role, result FROM game_participants WHERE session_id = ? ORDER BY user_id')
      .all('game-1');
    expect(parts).toEqual(
      players
        .slice()
        .sort()
        .map((userId) => ({
          userId,
          role: userId === moleId ? 'mole' : 'agent',
          result: userId === moleId ? 'win' : 'loss',
        })),
    );
    expect(finished).toEqual([
      expect.objectContaining({ sessionId: 'game-1', guildId: 'g1', game: 'mole', winnerIds: [moleId] }),
    ]);
    expect(service.isChannelBusy('c1')).toBe(false);
    expect(startIn('c1').ok).toBe(true); // salon libéré
  });

  it("une annulation libère le salon sans émettre game:finished", async () => {
    const r = startIn('c1');
    if (!r.ok) throw new Error('start');
    r.session.dispatch({ type: 'cancel', userId: 'alice' });
    await Promise.resolve();
    expect(row('game-1').status).toBe('cancelled');
    expect(finished).toEqual([]);
    expect(service.activeCount).toBe(0);
  });

  it('disposeAll et recoverInterrupted annulent les parties actives', () => {
    startIn('c1');
    startIn('c2');
    service.disposeAll();
    expect(row('game-1').status).toBe('cancelled');
    expect(service.activeCount).toBe(0);

    db.prepare(
      "INSERT INTO game_sessions (id, guild_id, channel_id, game, host_id, status, created_at) VALUES ('orphan', 'g1', 'c9', 'mole', 'x', 'running', 0)",
    ).run();
    expect(service.recoverInterrupted()).toBe(1);
    expect(row('orphan').status).toBe('cancelled');
  });
});
