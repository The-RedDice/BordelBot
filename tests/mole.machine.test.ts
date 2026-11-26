import { describe, expect, it } from 'vitest';
import {
  createMoleMachine,
  currentTurnPlayer,
  roleOf,
  TIMER_LOBBY,
  TIMER_VOTE,
  turnTimerKey,
} from '../src/modules/games/mole/machine.js';
import type { MoleEffect, MoleState } from '../src/modules/games/mole/types.js';
import { env, errorCode, everyoneVotes, lobby, PLAYERS, started, step, toVoting } from './helpers/mole.js';

const machine = createMoleMachine();
const ofType = <K extends MoleEffect['type']>(effects: readonly MoleEffect[], type: K) =>
  effects.filter((e): e is Extract<MoleEffect, { type: K }> => e.type === type);

describe('La Taupe — lobby', () => {
  it('gère arrivées, doublons et limite de joueurs', () => {
    const small = createMoleMachine({ maxPlayers: 3 });
    const s = lobby(small, ['a', 'b', 'c']);
    expect(s.players).toEqual(['a', 'b', 'c']);
    expect(errorCode(small, s, { type: 'join', userId: 'b' })).toBe('ALREADY_JOINED');
    expect(errorCode(small, s, { type: 'join', userId: 'd' })).toBe('LOBBY_FULL');
  });

  it("transfère l'hôte quand il part, annule quand le lobby est vide", () => {
    let s = lobby(machine, ['a', 'b']);
    const r = step(machine, s, { type: 'leave', userId: 'a' });
    expect(r.state.hostId).toBe('b');
    s = step(machine, r.state, { type: 'leave', userId: 'b' }).state;
    expect(s.phase).toBe('cancelled');
    expect(machine.status(s)).toBe('cancelled');
  });

  it("refuse le lancement par un non-hôte ou avec trop peu de joueurs", () => {
    expect(errorCode(machine, lobby(machine), { type: 'start', userId: 'bob' })).toBe('NOT_HOST');
    expect(errorCode(machine, lobby(machine, ['a', 'b']), { type: 'start', userId: 'a' })).toBe('NOT_ENOUGH_PLAYERS');
  });

  it('arme un timer de lobby à la création et annule le lobby à expiration', () => {
    const s = lobby(machine);
    expect(machine.initialTimer(s)).toEqual({ key: TIMER_LOBBY, delayMs: 600_000 });
    expect(errorCode(machine, s, { type: 'timeout', key: 'autre' })).toBe('STALE_TIMER');
    const r = step(machine, s, { type: 'timeout', key: TIMER_LOBBY });
    expect(r.state).toMatchObject({ phase: 'cancelled', reason: 'expired', cancelledBy: null });
    expect(r.effects).toEqual([{ type: 'gameCancelled', reason: 'expired', by: null }]);
    expect(machine.initialTimer(started(machine))).toBeNull();
  });

  it('refuse les actions hors phase', () => {
    expect(errorCode(machine, lobby(machine), { type: 'vote', userId: 'alice', targetId: 'bob' })).toBe(
      'INVALID_ACTION',
    );
  });
});

describe('La Taupe — démarrage', () => {
  it('désigne exactement une taupe, qui ne reçoit pas le mot', () => {
    const r = step(machine, lobby(machine), { type: 'start', userId: 'alice' });
    const roles = ofType(r.effects, 'roleAssigned');
    expect(roles).toHaveLength(PLAYERS.length);
    const moles = roles.filter((x) => x.role === 'mole');
    expect(moles).toHaveLength(1);
    expect(moles[0]?.word).toBeNull();
    const s = r.state as Extract<MoleState, { phase: 'clues' }>;
    for (const agent of roles.filter((x) => x.role === 'agent')) expect(agent.word).toBe(s.word);
    expect(r.timer).toEqual({ key: turnTimerKey(0), delayMs: 60_000 });
    expect(roleOf(s, s.moleId)).toEqual({ role: 'mole', category: s.category, word: null });
    expect(roleOf(s, 'inconnu')).toBeNull();
  });

  it('ne fait jamais parler la taupe en premier', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const s = started(machine, PLAYERS, seed);
      expect(s.turnOrder[0]).not.toBe(s.moleId);
      expect([...s.turnOrder].sort()).toEqual([...PLAYERS].sort());
    }
  });

  it('est déterministe pour une même graine', () => {
    expect(started(machine, PLAYERS, 42)).toEqual(started(machine, PLAYERS, 42));
  });
});

describe('La Taupe — indices', () => {
  it("impose l'ordre de parole et valide le texte", () => {
    const s = started(machine);
    const current = currentTurnPlayer(s) as string;
    const other = s.players.find((p) => p !== current) as string;
    expect(errorCode(machine, s, { type: 'clue', userId: other, text: 'x' })).toBe('NOT_YOUR_TURN');
    expect(errorCode(machine, s, { type: 'clue', userId: 'intrus', text: 'x' })).toBe('NOT_A_PLAYER');
    expect(errorCode(machine, s, { type: 'clue', userId: current, text: '   ' })).toBe('EMPTY_CLUE');
    expect(errorCode(machine, s, { type: 'clue', userId: current, text: 'a'.repeat(41) })).toBe('CLUE_TOO_LONG');
  });

  it("refuse qu'un agent donne le mot (casse et accents ignorés), mais pas la taupe", () => {
    const s = started(machine);
    const first = currentTurnPlayer(s) as string; // jamais la taupe
    const shouted = `${s.word.toUpperCase().normalize('NFD').replace(/\p{M}/gu, '')} !`;
    expect(errorCode(machine, s, { type: 'clue', userId: first, text: shouted })).toBe('CLUE_REVEALS_WORD');

    let state: MoleState = s;
    while (currentTurnPlayer(state) !== s.moleId) {
      state = step(machine, state, { type: 'clue', userId: currentTurnPlayer(state) as string, text: 'ok' }).state;
    }
    // Refuser cet indice apprendrait le mot secret à la taupe.
    expect(errorCode(machine, state, { type: 'clue', userId: s.moleId, text: s.word })).toBeNull();
  });

  it('passe le tour à expiration du timer et ignore un timer obsolète', () => {
    const s = started(machine);
    const first = currentTurnPlayer(s);
    expect(errorCode(machine, s, { type: 'timeout', key: turnTimerKey(3) })).toBe('STALE_TIMER');
    const r = step(machine, s, { type: 'timeout', key: turnTimerKey(0) });
    expect(ofType(r.effects, 'clueGiven')[0]).toMatchObject({ userId: first, text: null });
    expect(r.timer?.key).toBe(turnTimerKey(1));
  });

  it('enchaîne plusieurs tours puis ouvre le vote', () => {
    const twoRounds = createMoleMachine({ clueRounds: 2 });
    const s = started(twoRounds);
    let state: MoleState = s;
    let turns = 0;
    let last;
    while (state.phase === 'clues') {
      last = step(twoRounds, state, { type: 'clue', userId: currentTurnPlayer(state) as string, text: 'pomme' });
      state = last.state;
      turns++;
    }
    expect(turns).toBe(PLAYERS.length * 2);
    expect(state.phase).toBe('voting');
    expect(last?.timer).toEqual({ key: TIMER_VOTE, delayMs: 90_000 });
    if (state.phase === 'voting') expect(state.clues.map((c) => c.round)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
});

describe('La Taupe — vote et dénouement', () => {
  it('valide les votes et accepte un changement de vote', () => {
    const v = toVoting(machine, started(machine));
    expect(errorCode(machine, v, { type: 'vote', userId: 'alice', targetId: 'alice' })).toBe('SELF_VOTE');
    expect(errorCode(machine, v, { type: 'vote', userId: 'alice', targetId: 'zoe' })).toBe('INVALID_TARGET');
    expect(errorCode(machine, v, { type: 'vote', userId: 'zoe', targetId: 'alice' })).toBe('NOT_A_PLAYER');
    let s = step(machine, v, { type: 'vote', userId: 'alice', targetId: 'bob' }).state;
    s = step(machine, s, { type: 'vote', userId: 'alice', targetId: 'carol' }).state;
    expect(s.phase === 'voting' && s.votes).toEqual({ alice: 'carol' });
  });

  it('taupe démasquée qui se trompe : les agents gagnent', () => {
    const v = toVoting(machine, started(machine));
    const g = everyoneVotes(machine, v, v.moleId);
    expect(g.state.phase).toBe('guess');
    expect(ofType(g.effects, 'voteResolved')[0]?.accusedId).toBe(v.moleId);

    const end = step(machine, g.state, { type: 'guess', userId: v.moleId, word: 'mauvaise réponse' });
    expect(end.state).toMatchObject({ phase: 'finished', winner: 'agents', reason: 'moleCaught' });
    expect(end.outcome?.loserIds).toEqual([v.moleId]);
    expect([...(end.outcome?.winnerIds ?? [])].sort()).toEqual(v.players.filter((p) => p !== v.moleId).sort());
    expect(end.timer).toBeNull();
  });

  it('taupe démasquée qui trouve le mot (sans tenir compte de la casse ni des accents) : elle gagne', () => {
    const v = toVoting(machine, started(machine));
    const g = everyoneVotes(machine, v, v.moleId);
    expect(errorCode(machine, g.state, { type: 'guess', userId: 'intrus', word: v.word })).toBe('NOT_THE_MOLE');
    const guess = v.word.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const end = step(machine, g.state, { type: 'guess', userId: v.moleId, word: `  ${guess} ` });
    expect(end.state).toMatchObject({ winner: 'mole', reason: 'moleGuessed' });
    expect(end.outcome?.winnerIds).toEqual([v.moleId]);
  });

  it('agent accusé à tort : la taupe gagne', () => {
    const v = toVoting(machine, started(machine));
    const innocent = v.players.find((p) => p !== v.moleId) as string;
    const end = everyoneVotes(machine, v, innocent);
    expect(end.state).toMatchObject({ phase: 'finished', winner: 'mole', reason: 'wrongAccusation', accusedId: innocent });
  });

  it('égalité ou absence de votes à expiration : la taupe gagne', () => {
    const v = toVoting(machine, started(machine));
    const [a, b, c, d] = v.players as [string, string, string, string];
    let s: MoleState = step(machine, v, { type: 'vote', userId: a, targetId: b }).state;
    s = step(machine, s, { type: 'vote', userId: c, targetId: d }).state;
    const end = step(machine, s, { type: 'timeout', key: TIMER_VOTE });
    expect(end.state).toMatchObject({ winner: 'mole', reason: 'tie', accusedId: null });

    const empty = step(machine, v, { type: 'timeout', key: TIMER_VOTE });
    expect(empty.state).toMatchObject({ winner: 'mole', reason: 'tie' });
  });

  it('taupe muette au moment de deviner : les agents gagnent', () => {
    const v = toVoting(machine, started(machine));
    const g = everyoneVotes(machine, v, v.moleId);
    const end = step(machine, g.state, { type: 'timeout', key: 'guess' });
    expect(end.state).toMatchObject({ winner: 'agents', reason: 'moleCaught', guess: null });
  });
});

describe('La Taupe — annulation et fin', () => {
  it("seul l'hôte annule, dans n'importe quelle phase active", () => {
    const s = started(machine);
    expect(errorCode(machine, s, { type: 'cancel', userId: 'bob' })).toBe('NOT_HOST');
    const r = step(machine, s, { type: 'cancel', userId: 'alice' });
    expect(r.state.phase).toBe('cancelled');
    expect(r.timer).toBeNull();
    expect(r.outcome).toBeUndefined();
  });

  it('refuse toute action une fois la partie terminée', () => {
    const v = toVoting(machine, started(machine));
    const end = everyoneVotes(machine, v, v.players.find((p) => p !== v.moleId) as string);
    expect(errorCode(machine, end.state, { type: 'cancel', userId: 'alice' })).toBe('GAME_OVER');
  });

  it("produit un état sérialisable en JSON sans perte", () => {
    const v = toVoting(machine, started(machine, PLAYERS, 7));
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(machine.participants(v).filter((p) => p.role === 'mole')).toEqual([{ userId: v.moleId, role: 'mole' }]);
  });

  it('valide la configuration', () => {
    expect(() => createMoleMachine({ minPlayers: 2 })).toThrow(/minPlayers/);
    expect(() => createMoleMachine({ wordBank: [] })).toThrow(/wordBank/);
    expect(() => createMoleMachine({ maxPlayers: 2 })).toThrow(/maxPlayers/);
    expect(env().rng()).toBeGreaterThanOrEqual(0);
  });
});
