/**
 * Noyau FSM des jeux. Aucune dépendance à discord.js ni à la base de données.
 *
 * Un jeu est une fonction pure `(état, action, env) -> transition` :
 * - l'état est un objet JSON sérialisable, discriminé par `phase` ;
 * - les actions sont discriminées par `type` ;
 * - une transition réussie renvoie le nouvel état, des effets (ce que l'adaptateur
 *   doit afficher), éventuellement une demande de timer et un résultat de partie.
 * Le hasard et l'heure sont injectés via `env`, ce qui rend chaque partie rejouable.
 */
import type { GameKind } from '../../../core/events.js';
import type { Rng } from './rng.js';

export type GameStatus = 'lobby' | 'running' | 'finished' | 'cancelled';

export interface BaseState {
  readonly phase: string;
}
export interface BaseAction {
  readonly type: string;
}

export interface GameEnv {
  readonly now: number;
  readonly rng: Rng;
}

/** Refus d'une action. `message` est destiné au joueur (affichable tel quel). */
export interface GameError {
  readonly code: string;
  readonly message: string;
}

export interface GameOutcome {
  readonly winnerIds: readonly string[];
  readonly loserIds: readonly string[];
}

export interface Participant {
  readonly userId: string;
  readonly role: string | null;
}

/**
 * Une session gère un seul timer actif à la fois (suffisant pour des jeux par
 * phases). À l'échéance, elle dispatche `machine.timeoutAction(key)`.
 */
export interface TimerRequest {
  readonly key: string;
  readonly delayMs: number;
}

export interface TransitionOk<S, E> {
  readonly ok: true;
  readonly state: S;
  readonly effects: readonly E[];
  /** Absent : timer inchangé. `null` : timer annulé. Objet : remplace le timer actif. */
  readonly timer?: TimerRequest | null;
  /** Renseigné lorsque la transition termine la partie avec un vainqueur. */
  readonly outcome?: GameOutcome;
}

export interface TransitionErr {
  readonly ok: false;
  readonly error: GameError;
}

export type Transition<S, E> = TransitionOk<S, E> | TransitionErr;

export interface TransitionExtras {
  readonly timer?: TimerRequest | null;
  readonly outcome?: GameOutcome;
}

export function ok<S, E>(state: S, effects: readonly E[] = [], extras: TransitionExtras = {}): TransitionOk<S, E> {
  return { ok: true, state, effects, ...extras };
}

export function fail(code: string, message: string): TransitionErr {
  return { ok: false, error: { code, message } };
}

export interface GameMachine<S extends BaseState, A extends BaseAction, E> {
  readonly kind: GameKind;
  transition(state: S, action: A, env: GameEnv): Transition<S, E>;
  status(state: S): GameStatus;
  participants(state: S): readonly Participant[];
  timeoutAction(key: string): A;
  /** Timer à armer à la création de la session (ex. expiration du lobby). */
  initialTimer(state: S): TimerRequest | null;
}

type Handler<S, E, SP, AP> = (state: SP, action: AP, env: GameEnv) => Transition<S, E>;

/** Table de transitions : pour chaque phase, les actions qu'elle accepte. */
export type TransitionTable<S extends BaseState, A extends BaseAction, E> = {
  readonly [P in S['phase']]?: {
    readonly [T in A['type']]?: Handler<S, E, Extract<S, { phase: P }>, Extract<A, { type: T }>>;
  };
};

/** Actions acceptées dans toute phase non terminale (ex. annulation par l'hôte). */
export type AnyPhaseTable<S extends BaseState, A extends BaseAction, E> = {
  readonly [T in A['type']]?: Handler<S, E, S, Extract<A, { type: T }>>;
};

export interface MachineSpec<S extends BaseState, A extends BaseAction, E> {
  readonly kind: GameKind;
  readonly transitions: TransitionTable<S, A, E>;
  readonly anyPhase?: AnyPhaseTable<S, A, E>;
  status(state: S): GameStatus;
  participants(state: S): readonly Participant[];
  timeoutAction(key: string): A;
  initialTimer?(state: S): TimerRequest | null;
}

export function isTerminal(status: GameStatus): boolean {
  return status === 'finished' || status === 'cancelled';
}

export function createMachine<S extends BaseState, A extends BaseAction, E>(
  spec: MachineSpec<S, A, E>,
): GameMachine<S, A, E> {
  type LooseTable = Partial<Record<string, Handler<S, E, S, A>>>;
  return {
    kind: spec.kind,
    status: (s) => spec.status(s),
    participants: (s) => spec.participants(s),
    timeoutAction: (k) => spec.timeoutAction(k),
    initialTimer: (s) => spec.initialTimer?.(s) ?? null,
    transition(state, action, env) {
      if (isTerminal(spec.status(state))) return fail('GAME_OVER', 'La partie est terminée.');
      const byPhase = spec.transitions[state.phase as S['phase']] as LooseTable | undefined;
      const handler = byPhase?.[action.type] ?? (spec.anyPhase as LooseTable | undefined)?.[action.type];
      if (!handler) {
        return fail('INVALID_ACTION', "Cette action n'est pas possible à ce stade de la partie.");
      }
      return handler(state, action, env);
    },
  };
}
