import { describe, expect, it, vi } from 'vitest';
import { nullLogger } from '../src/core/logger.js';
import { GameSession } from '../src/modules/games/engine/GameSession.js';
import { seededRng } from '../src/modules/games/engine/rng.js';
import { createMoleLobby, createMoleMachine, currentTurnPlayer } from '../src/modules/games/mole/machine.js';
import type { MoleAction, MoleEffect, MoleState } from '../src/modules/games/mole/types.js';
import { ManualScheduler } from './helpers/ManualScheduler.js';

const machine = createMoleMachine({ turnTimeoutMs: 1_000, voteTimeoutMs: 5_000, guessTimeoutMs: 2_000 });

function newSession(logger = nullLogger) {
  const scheduler = new ManualScheduler();
  const session = new GameSession<MoleState, MoleAction, MoleEffect>('s1', machine, createMoleLobby('alice'), {
    scheduler,
    clock: scheduler.clock,
    rng: seededRng(3),
    logger,
  });
  for (const p of ['bob', 'carol']) session.dispatch({ type: 'join', userId: p });
  return { session, scheduler };
}

describe('GameSession', () => {
  it('arme le timer initial de la machine et annule un lobby abandonné', () => {
    const { session, scheduler } = newSession();
    const onEnd = vi.fn();
    session.subscribe({ onEnd });
    expect(session.timerDeadline).toBe(machine.config.lobbyTimeoutMs);
    scheduler.advance(machine.config.lobbyTimeoutMs);
    expect(session.state).toMatchObject({ phase: 'cancelled', reason: 'expired' });
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: null }));
  });

  it('arme, remplace et déclenche le timer de tour', () => {
    const { session, scheduler } = newSession();
    session.dispatch({ type: 'start', userId: 'alice' });
    expect(scheduler.pending).toBe(1);
    expect(session.timerDeadline).toBe(1_000);

    const first = currentTurnPlayer(session.state);
    scheduler.advance(500);
    session.dispatch({ type: 'clue', userId: first as string, text: 'abc' });
    expect(scheduler.pending).toBe(1); // l'ancien timer est remplacé, pas cumulé
    expect(session.timerDeadline).toBe(1_500);

    scheduler.advance(999);
    expect(session.state.phase === 'clues' && session.state.turnIndex).toBe(1);
    scheduler.advance(1);
    expect(session.state.phase === 'clues' && session.state.clues[1]?.text).toBeNull();
  });

  it('termine une partie entièrement par timeouts et notifie onEnd une seule fois', () => {
    const { session, scheduler } = newSession();
    const onEnd = vi.fn();
    const effects: MoleEffect[] = [];
    session.subscribe({ onEnd, onTransition: (u) => effects.push(...u.effects) });

    session.dispatch({ type: 'start', userId: 'alice' });
    scheduler.advance(3 * 1_000); // 3 tours passés
    expect(session.state.phase).toBe('voting');
    scheduler.advance(5_000); // aucun vote -> égalité -> la taupe gagne

    expect(session.isOver).toBe(true);
    expect(session.status).toBe('finished');
    expect(scheduler.pending).toBe(0);
    expect(onEnd).toHaveBeenCalledOnce();
    const moleId = (session.state as Extract<MoleState, { phase: 'finished' }>).moleId;
    expect(onEnd.mock.calls[0]?.[0].outcome.winnerIds).toEqual([moleId]);
    expect(effects.filter((e) => e.type === 'clueGiven')).toHaveLength(3);
    expect(session.dispatch({ type: 'cancel', userId: 'alice' })).toMatchObject({ ok: false, error: { code: 'GAME_OVER' } });
  });

  it('renvoie les erreurs de la FSM sans modifier l’état', () => {
    const { session } = newSession();
    const before = session.state;
    expect(session.dispatch({ type: 'start', userId: 'bob' })).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    expect(session.state).toBe(before);
  });

  it('isole un hook en échec et interdit le dispatch réentrant', () => {
    const logger = { ...nullLogger, error: vi.fn() };
    const { session } = newSession(logger);
    const healthy = vi.fn();
    session.subscribe({ onTransition: () => { throw new Error('boom'); } });
    session.subscribe({ onTransition: () => { session.dispatch({ type: 'cancel', userId: 'alice' }); } });
    session.subscribe({ onTransition: healthy });

    expect(session.dispatch({ type: 'join', userId: 'dave' })).toEqual({ ok: true });
    expect(healthy).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(session.state.phase).toBe('lobby'); // l'annulation réentrante n'a pas eu lieu
  });

  it('une annulation produit onEnd avec outcome null', () => {
    const { session, scheduler } = newSession();
    const onEnd = vi.fn();
    session.subscribe({ onEnd });
    session.dispatch({ type: 'start', userId: 'alice' });
    session.dispatch({ type: 'cancel', userId: 'alice' });
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: null }));
    expect(scheduler.pending).toBe(0);
  });

  it('dispose stoppe les timers sans appeler les hooks', () => {
    const { session, scheduler } = newSession();
    const onTransition = vi.fn();
    session.dispatch({ type: 'start', userId: 'alice' });
    session.subscribe({ onTransition });
    session.dispose();
    scheduler.advance(10_000);
    expect(onTransition).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(0);
  });
});
