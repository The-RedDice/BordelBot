import type { GameEnv, TransitionOk } from '../../src/modules/games/engine/fsm.js';
import { seededRng } from '../../src/modules/games/engine/rng.js';
import { createMoleLobby, currentTurnPlayer, type MoleMachine } from '../../src/modules/games/mole/machine.js';
import type { CluesState, MoleAction, MoleEffect, MoleState, VotingState } from '../../src/modules/games/mole/types.js';

export const PLAYERS = ['alice', 'bob', 'carol', 'dave'] as const;

export const env = (seed = 1): GameEnv => ({ now: 0, rng: seededRng(seed) });

/** Applique une action qui DOIT réussir. */
export function step(
  machine: MoleMachine,
  state: MoleState,
  action: MoleAction,
  e: GameEnv = env(),
): TransitionOk<MoleState, MoleEffect> {
  const r = machine.transition(state, action, e);
  if (!r.ok) throw new Error(`Action ${action.type} refusée : ${r.error.code} (${r.error.message})`);
  return r;
}

export function errorCode(machine: MoleMachine, state: MoleState, action: MoleAction): string | null {
  const r = machine.transition(state, action, env());
  return r.ok ? null : r.error.code;
}

export function lobby(machine: MoleMachine, players: readonly string[] = PLAYERS): MoleState {
  let s: MoleState = createMoleLobby(players[0] as string);
  for (const p of players.slice(1)) s = step(machine, s, { type: 'join', userId: p }).state;
  return s;
}

export function started(machine: MoleMachine, players: readonly string[] = PLAYERS, seed = 1): CluesState {
  const s = step(machine, lobby(machine, players), { type: 'start', userId: players[0] as string }, env(seed)).state;
  if (s.phase !== 'clues') throw new Error(`Phase inattendue : ${s.phase}`);
  return s;
}

export function toVoting(machine: MoleMachine, s: MoleState): VotingState {
  let state = s;
  let i = 0;
  while (state.phase === 'clues') {
    const userId = currentTurnPlayer(state) as string;
    state = step(machine, state, { type: 'clue', userId, text: `indice ${i++}` }).state;
  }
  if (state.phase !== 'voting') throw new Error(`Phase inattendue : ${state.phase}`);
  return state;
}

/** Tout le monde vote pour `target`, sauf `target` qui vote pour quelqu'un d'autre. */
export function everyoneVotes(machine: MoleMachine, s: VotingState, target: string) {
  let r: TransitionOk<MoleState, MoleEffect> | undefined;
  let state: MoleState = s;
  for (const voter of s.players) {
    const t = voter === target ? (s.players.find((p) => p !== target) as string) : target;
    r = step(machine, state, { type: 'vote', userId: voter, targetId: t });
    state = r.state;
  }
  return r as TransitionOk<MoleState, MoleEffect>;
}
