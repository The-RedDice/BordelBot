import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import { nullLogger } from '../src/core/logger.js';
import { JobScheduler } from '../src/core/scheduler/JobScheduler.js';
import { economyModule, getEconomyService, getEconomyServices } from '../src/modules/economy/index.js';
import { seededRng } from '../src/modules/games/engine/rng.js';
import { GameService } from '../src/modules/games/GameService.js';
import { createMoleLobby, createMoleMachine, currentTurnPlayer } from '../src/modules/games/mole/machine.js';
import { ManualScheduler } from './helpers/ManualScheduler.js';

describe('Jeux → EventBus → Économie', () => {
  it('une partie de Taupe gagnée par la taupe la crédite (×3), une seule fois', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, migrations);
    const ctx = { db, bus: new EventBus<BotEvents>(nullLogger), logger: nullLogger, scheduler: new JobScheduler(db) };
    await economyModule.init?.(ctx);

    const scheduler = new ManualScheduler();
    const games = new GameService(ctx, { scheduler, clock: scheduler.clock, rng: seededRng(11) });
    const machine = createMoleMachine();
    const r = games.start({
      machine,
      initialState: createMoleLobby('alice'),
      guildId: 'g',
      channelId: 'c',
      hostId: 'alice',
    });
    if (!r.ok) throw new Error('start');
    const { session } = r;
    for (const p of ['bob', 'carol', 'dave']) session.dispatch({ type: 'join', userId: p });
    session.dispatch({ type: 'start', userId: 'alice' });
    while (session.state.phase === 'clues') {
      session.dispatch({ type: 'clue', userId: currentTurnPlayer(session.state) as string, text: 'euh' });
    }
    // Personne ne vote : égalité à l'expiration -> la taupe gagne seule contre 3.
    scheduler.advance(machine.config.voteTimeoutMs);
    await Promise.resolve();

    expect(session.state.phase).toBe('finished');
    const moleId = (session.state as Extract<typeof session.state, { phase: 'finished' }>).moleId;
    const eco = getEconomyService();
    // 150 (×3, seule contre 3) + 50 pour le succès « Première victoire ».
    expect(eco.getBalance('g', moleId)).toBe(200);
    const services = getEconomyServices();
    expect(services.progress.stats('g', moleId)).toMatchObject({ games_played: 1, games_won: 1 });
    expect(services.progress.stats('g', 'alice' === moleId ? 'bob' : 'alice')).toMatchObject({ games_played: 1 });
    for (const p of ['alice', 'bob', 'carol', 'dave'].filter((x) => x !== moleId)) expect(eco.getBalance('g', p)).toBe(0);

    // Rejouer l'événement (ex. double émission) ne crédite pas deux fois.
    await ctx.bus.emit('game:finished', {
      sessionId: session.id,
      guildId: 'g',
      channelId: 'c',
      game: 'mole',
      winnerIds: [moleId],
      loserIds: [],
      finishedAt: 0,
    });
    expect(eco.getBalance('g', moleId)).toBe(200);
    // …ni ne recompte la partie dans les statistiques.
    expect(services.progress.stats('g', moleId)).toMatchObject({ games_played: 1, games_won: 1 });

    await economyModule.dispose?.();
    db.close();
  });
});
