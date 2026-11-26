import {
  createMachine,
  fail,
  ok,
  type GameEnv,
  type GameMachine,
  type Participant,
  type Transition,
  type TransitionExtras,
} from '../engine/fsm.js';
import { pick, randomInt, shuffle } from '../engine/rng.js';
import { revealsWord, sameWord } from './text.js';
import type {
  CancelledState,
  Clue,
  CluesState,
  FinishedState,
  InGameFields,
  LobbyState,
  MoleAction,
  MoleEffect,
  MoleEndReason,
  MoleRole,
  MoleState,
  MoleWinner,
  VotingState,
} from './types.js';
import { DEFAULT_WORD_BANK, type WordBank } from './words.js';

export interface MoleConfig {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Nombre de tours d'indices complets avant le vote. */
  readonly clueRounds: number;
  readonly turnTimeoutMs: number;
  readonly voteTimeoutMs: number;
  readonly guessTimeoutMs: number;
  readonly maxClueLength: number;
  /** Délai avant annulation automatique d'un lobby jamais lancé (libère le salon). */
  readonly lobbyTimeoutMs: number;
  readonly wordBank: WordBank;
}

export const DEFAULT_MOLE_CONFIG: MoleConfig = {
  minPlayers: 3,
  maxPlayers: 12,
  clueRounds: 1,
  turnTimeoutMs: 60_000,
  voteTimeoutMs: 90_000,
  guessTimeoutMs: 45_000,
  maxClueLength: 40,
  lobbyTimeoutMs: 10 * 60_000,
  wordBank: DEFAULT_WORD_BANK,
};

export type MoleMachine = GameMachine<MoleState, MoleAction, MoleEffect> & { readonly config: MoleConfig };
type T = Transition<MoleState, MoleEffect>;

export const TIMER_LOBBY = 'lobby';
export const TIMER_VOTE = 'vote';
export const TIMER_GUESS = 'guess';
export const turnTimerKey = (turnIndex: number): string => `turn:${turnIndex}`;

export function createMoleLobby(hostId: string): LobbyState {
  return { phase: 'lobby', hostId, players: [hostId] };
}

/** Joueur dont c'est le tour, ou null hors de la phase d'indices. */
export function currentTurnPlayer(state: MoleState): string | null {
  if (state.phase !== 'clues') return null;
  return state.turnOrder[state.turnIndex % state.turnOrder.length] ?? null;
}

/** Informations privées d'un joueur (pour un bouton « Voir mon rôle »). */
export function roleOf(
  state: MoleState,
  userId: string,
): { role: MoleRole; category: string; word: string | null } | null {
  if (state.phase === 'lobby' || state.phase === 'cancelled' || !state.players.includes(userId)) return null;
  const isMole = state.moleId === userId;
  return { role: isMole ? 'mole' : 'agent', category: state.category, word: isMole ? null : state.word };
}

function validateConfig(c: MoleConfig): void {
  const problems: string[] = [];
  if (!Number.isInteger(c.minPlayers) || c.minPlayers < 3) problems.push('minPlayers doit être un entier >= 3');
  if (!Number.isInteger(c.maxPlayers) || c.maxPlayers < c.minPlayers) problems.push('maxPlayers doit être >= minPlayers');
  if (!Number.isInteger(c.clueRounds) || c.clueRounds < 1) problems.push('clueRounds doit être un entier >= 1');
  for (const k of ['turnTimeoutMs', 'voteTimeoutMs', 'guessTimeoutMs', 'maxClueLength', 'lobbyTimeoutMs'] as const) {
    if (!(c[k] > 0)) problems.push(`${k} doit être > 0`);
  }
  if (c.wordBank.length === 0 || c.wordBank.some((cat) => cat.words.length === 0)) {
    problems.push('wordBank doit contenir des catégories non vides');
  }
  if (problems.length) throw new Error(`Configuration de la Taupe invalide : ${problems.join(' ; ')}`);
}

export function createMoleMachine(overrides: Partial<MoleConfig> = {}): MoleMachine {
  const config: MoleConfig = { ...DEFAULT_MOLE_CONFIG, ...overrides };
  validateConfig(config);

  // Helper typé : garde les littéraux des effets (sinon `type` serait élargi en string).
  const done = (state: MoleState, effects: MoleEffect[] = [], extras: TransitionExtras = {}): T =>
    ok<MoleState, MoleEffect>(state, effects, extras);

  const totalTurns = (s: InGameFields): number => s.players.length * config.clueRounds;
  const playerAt = (s: InGameFields, turnIndex: number): string =>
    s.turnOrder[turnIndex % s.turnOrder.length] as string;
  const roundAt = (s: InGameFields, turnIndex: number): number => Math.floor(turnIndex / s.turnOrder.length);

  const base = (s: InGameFields): InGameFields => ({
    hostId: s.hostId,
    players: s.players,
    moleId: s.moleId,
    category: s.category,
    word: s.word,
    turnOrder: s.turnOrder,
    clues: s.clues,
  });

  function start(s: LobbyState, userId: string, env: GameEnv): T {
    if (userId !== s.hostId) return fail('NOT_HOST', "Seul l'hôte peut lancer la partie.");
    if (s.players.length < config.minPlayers) {
      return fail('NOT_ENOUGH_PLAYERS', `Il faut au moins ${config.minPlayers} joueurs pour commencer.`);
    }
    const category = pick(env.rng, config.wordBank);
    const word = pick(env.rng, category.words);
    const moleId = pick(env.rng, s.players);
    const turnOrder = shuffle(env.rng, s.players);
    // La taupe ne parle jamais en premier : elle n'aurait aucun indice sur lequel s'appuyer.
    if (turnOrder[0] === moleId) {
      const j = 1 + randomInt(env.rng, turnOrder.length - 1);
      [turnOrder[0], turnOrder[j]] = [turnOrder[j] as string, moleId];
    }

    const state: CluesState = {
      phase: 'clues',
      hostId: s.hostId,
      players: s.players,
      moleId,
      category: category.name,
      word,
      turnOrder,
      clues: [],
      turnIndex: 0,
    };
    const roles: MoleEffect[] = s.players.map((p) => ({
      type: 'roleAssigned',
      userId: p,
      role: p === moleId ? 'mole' : 'agent',
      category: category.name,
      word: p === moleId ? null : word,
    }));
    return done(
      state,
      [
        { type: 'gameStarted', category: category.name, turnOrder },
        ...roles,
        { type: 'turnStarted', userId: playerAt(state, 0), turnIndex: 0, round: 0 },
      ],
      { timer: { key: turnTimerKey(0), delayMs: config.turnTimeoutMs } },
    );
  }

  function advanceTurn(s: CluesState, clue: Clue): T {
    const clues = [...s.clues, clue];
    const given: MoleEffect = { type: 'clueGiven', userId: clue.playerId, round: clue.round, text: clue.text };
    const next = s.turnIndex + 1;

    if (next < totalTurns(s)) {
      return done(
        { ...s, clues, turnIndex: next },
        [given, { type: 'turnStarted', userId: playerAt(s, next), turnIndex: next, round: roundAt(s, next) }],
        { timer: { key: turnTimerKey(next), delayMs: config.turnTimeoutMs } },
      );
    }
    const voting: VotingState = { phase: 'voting', ...base(s), clues, votes: {} };
    return done(voting, [given, { type: 'votingStarted', candidates: s.players }], {
      timer: { key: TIMER_VOTE, delayMs: config.voteTimeoutMs },
    });
  }

  function finish(
    s: InGameFields,
    votes: Readonly<Record<string, string>>,
    winner: MoleWinner,
    reason: MoleEndReason,
    accusedId: string | null,
    guess: string | null,
    before: MoleEffect[] = [],
  ): T {
    const state: FinishedState = { phase: 'finished', ...base(s), votes, accusedId, guess, winner, reason };
    const agents = s.players.filter((p) => p !== s.moleId);
    const outcome =
      winner === 'mole' ? { winnerIds: [s.moleId], loserIds: agents } : { winnerIds: agents, loserIds: [s.moleId] };
    return done(
      state,
      [...before, { type: 'gameEnded', winner, reason, moleId: s.moleId, word: s.word, accusedId, guess }],
      { timer: null, outcome },
    );
  }

  function resolveVotes(s: VotingState, votes: Readonly<Record<string, string>>): T {
    const tally: Record<string, number> = {};
    for (const target of Object.values(votes)) tally[target] = (tally[target] ?? 0) + 1;
    const max = Math.max(0, ...Object.values(tally));
    const leaders = Object.keys(tally).filter((id) => tally[id] === max);
    const accusedId = max > 0 && leaders.length === 1 ? (leaders[0] as string) : null;
    const resolved: MoleEffect = { type: 'voteResolved', tally, accusedId };

    if (accusedId === null) return finish(s, votes, 'mole', 'tie', null, null, [resolved]);
    if (accusedId !== s.moleId) return finish(s, votes, 'mole', 'wrongAccusation', accusedId, null, [resolved]);
    return done(
      { phase: 'guess', ...base(s), votes, accusedId },
      [resolved, { type: 'guessStarted', moleId: s.moleId }],
      { timer: { key: TIMER_GUESS, delayMs: config.guessTimeoutMs } },
    );
  }

  const notPlayer = () => fail('NOT_A_PLAYER', 'Tu ne participes pas à cette partie.');
  const staleTimer = () => fail('STALE_TIMER', 'Timer obsolète.');

  const machine = createMachine<MoleState, MoleAction, MoleEffect>({
    kind: 'mole',

    initialTimer: (s) => (s.phase === 'lobby' ? { key: TIMER_LOBBY, delayMs: config.lobbyTimeoutMs } : null),

    transitions: {
      lobby: {
        join(s, a) {
          if (s.players.includes(a.userId)) return fail('ALREADY_JOINED', 'Tu es déjà dans la partie.');
          if (s.players.length >= config.maxPlayers) {
            return fail('LOBBY_FULL', `La partie est complète (${config.maxPlayers} joueurs max).`);
          }
          const players = [...s.players, a.userId];
          return done({ ...s, players }, [{ type: 'playerJoined', userId: a.userId, players }]);
        },
        leave(s, a) {
          if (!s.players.includes(a.userId)) return notPlayer();
          const players = s.players.filter((p) => p !== a.userId);
          if (players.length === 0) {
            const cancelled: CancelledState = {
              phase: 'cancelled',
              hostId: s.hostId,
              players,
              reason: 'empty',
              cancelledBy: null,
            };
            return done(cancelled, [{ type: 'gameCancelled', reason: 'empty', by: null }]);
          }
          // Si l'hôte part, le joueur arrivé le plus tôt devient hôte.
          const hostId = s.hostId === a.userId ? (players[0] as string) : s.hostId;
          return done({ ...s, players, hostId }, [{ type: 'playerLeft', userId: a.userId, players, hostId }]);
        },
        start: (s, a, env) => start(s, a.userId, env),
        timeout(s, a) {
          if (a.key !== TIMER_LOBBY) return staleTimer();
          const cancelled: CancelledState = { ...s, phase: 'cancelled', reason: 'expired', cancelledBy: null };
          return done(cancelled, [{ type: 'gameCancelled', reason: 'expired', by: null }]);
        },
      },

      clues: {
        clue(s, a) {
          if (!s.players.includes(a.userId)) return notPlayer();
          const expected = playerAt(s, s.turnIndex);
          if (a.userId !== expected) return fail('NOT_YOUR_TURN', "Ce n'est pas ton tour.");
          const text = a.text.trim().replace(/\s+/g, ' ');
          if (!text) return fail('EMPTY_CLUE', "L'indice ne peut pas être vide.");
          if (text.length > config.maxClueLength) {
            return fail('CLUE_TOO_LONG', `Indice trop long (${config.maxClueLength} caractères max).`);
          }
          // Contrôle réservé aux agents : refuser l'indice de la taupe parce qu'il contient
          // le mot lui apprendrait le mot secret.
          if (a.userId !== s.moleId && revealsWord(text, s.word)) {
            return fail('CLUE_REVEALS_WORD', "Ton indice contient le mot secret, trouve autre chose !");
          }
          return advanceTurn(s, { playerId: a.userId, round: roundAt(s, s.turnIndex), text });
        },
        timeout(s, a) {
          if (a.key !== turnTimerKey(s.turnIndex)) return staleTimer();
          return advanceTurn(s, { playerId: playerAt(s, s.turnIndex), round: roundAt(s, s.turnIndex), text: null });
        },
      },

      voting: {
        vote(s, a) {
          if (!s.players.includes(a.userId)) return notPlayer();
          if (!s.players.includes(a.targetId)) return fail('INVALID_TARGET', 'Ce joueur ne participe pas à la partie.');
          if (a.targetId === a.userId) return fail('SELF_VOTE', 'Tu ne peux pas voter contre toi-même.');
          const votes = { ...s.votes, [a.userId]: a.targetId };
          const cast = Object.keys(votes).length;
          const castEffect: MoleEffect = {
            type: 'voteCast',
            voterId: a.userId,
            votesCast: cast,
            votesExpected: s.players.length,
          };
          if (cast < s.players.length) return done({ ...s, votes }, [castEffect]);
          const resolved = resolveVotes(s, votes);
          return resolved.ok ? done(resolved.state, [castEffect, ...resolved.effects], resolved) : resolved;
        },
        timeout(s, a) {
          if (a.key !== TIMER_VOTE) return staleTimer();
          return resolveVotes(s, s.votes);
        },
      },

      guess: {
        guess(s, a) {
          if (a.userId !== s.moleId) return fail('NOT_THE_MOLE', 'Seule la taupe peut tenter de deviner le mot.');
          const word = a.word.trim();
          if (!word) return fail('EMPTY_GUESS', 'Propose un mot.');
          const found = sameWord(word, s.word);
          return finish(s, s.votes, found ? 'mole' : 'agents', found ? 'moleGuessed' : 'moleCaught', s.accusedId, word);
        },
        timeout(s, a) {
          if (a.key !== TIMER_GUESS) return staleTimer();
          return finish(s, s.votes, 'agents', 'moleCaught', s.accusedId, null);
        },
      },
    },

    anyPhase: {
      cancel(s, a) {
        if (a.userId !== s.hostId) return fail('NOT_HOST', "Seul l'hôte peut annuler la partie.");
        const cancelled: CancelledState = {
          phase: 'cancelled',
          hostId: s.hostId,
          players: s.players,
          reason: 'host',
          cancelledBy: a.userId,
        };
        return done(cancelled, [{ type: 'gameCancelled', reason: 'host', by: a.userId }], { timer: null });
      },
    },

    status(s) {
      switch (s.phase) {
        case 'lobby':
          return 'lobby';
        case 'finished':
          return 'finished';
        case 'cancelled':
          return 'cancelled';
        default:
          return 'running';
      }
    },

    participants(s): Participant[] {
      if (s.phase === 'lobby' || s.phase === 'cancelled') return s.players.map((userId) => ({ userId, role: null }));
      return s.players.map((userId) => ({ userId, role: userId === s.moleId ? 'mole' : 'agent' }));
    },

    timeoutAction: (key) => ({ type: 'timeout', key }),
  });
  return { ...machine, config };
}
