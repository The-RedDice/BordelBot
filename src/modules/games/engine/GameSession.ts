import type { Logger } from '../../../core/logger.js';
import {
  isTerminal,
  type BaseAction,
  type BaseState,
  type GameError,
  type GameMachine,
  type GameOutcome,
  type GameStatus,
  type TimerRequest,
} from './fsm.js';
import { cryptoRng, type Rng } from './rng.js';

/** Abstraction de setTimeout, remplaçable en test. */
export interface Scheduler {
  set(fn: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SessionHooks<S, E> {
  /** Après chaque transition acceptée, y compris celle qui termine la partie. */
  onTransition?(update: { readonly state: S; readonly previous: S; readonly effects: readonly E[] }): void;
  /** Une seule fois, quand la partie atteint un état terminal. `outcome` est null si elle est annulée. */
  onEnd?(result: { readonly state: S; readonly outcome: GameOutcome | null }): void;
}

export interface SessionOptions {
  readonly scheduler?: Scheduler;
  readonly clock?: () => number;
  readonly rng?: Rng;
  readonly logger?: Logger;
}

export type DispatchResult = { readonly ok: true } | { readonly ok: false; readonly error: GameError };

interface ActiveTimer {
  readonly key: string;
  readonly deadline: number;
  readonly handle: unknown;
}

/**
 * Exécute une machine : garde l'état courant, applique les actions, pilote le
 * timer et notifie les abonnés. Toujours indépendant de Discord.
 *
 * Les hooks ne doivent pas dispatcher eux-mêmes (dispatch réentrant interdit) :
 * l'adaptateur réagit aux effets en affichant, pas en rejouant des actions.
 */
export class GameSession<S extends BaseState, A extends BaseAction, E> {
  private current: S;
  private timer: ActiveTimer | null = null;
  private busy = false;
  private ended = false;
  private readonly hooks = new Set<SessionHooks<S, E>>();
  private readonly scheduler: Scheduler;
  private readonly clock: () => number;
  private readonly rng: Rng;
  private readonly logger: Logger | undefined;

  constructor(
    readonly id: string,
    readonly machine: GameMachine<S, A, E>,
    initialState: S,
    options: SessionOptions = {},
  ) {
    this.current = initialState;
    this.scheduler = options.scheduler ?? realScheduler;
    this.clock = options.clock ?? Date.now;
    this.rng = options.rng ?? cryptoRng;
    this.logger = options.logger;
    this.ended = isTerminal(machine.status(initialState));
    if (!this.ended) this.setTimer(machine.initialTimer(initialState));
  }

  get state(): S {
    return this.current;
  }

  get status(): GameStatus {
    return this.machine.status(this.current);
  }

  get isOver(): boolean {
    return this.ended;
  }

  /** Échéance du timer actif (epoch ms), pour afficher un compte à rebours. */
  get timerDeadline(): number | null {
    return this.timer?.deadline ?? null;
  }

  subscribe(hooks: SessionHooks<S, E>): () => void {
    this.hooks.add(hooks);
    return () => this.hooks.delete(hooks);
  }

  dispatch(action: A): DispatchResult {
    if (this.ended) return { ok: false, error: { code: 'GAME_OVER', message: 'La partie est terminée.' } };
    if (this.busy) throw new Error(`Dispatch réentrant interdit (session ${this.id}, action ${action.type})`);

    this.busy = true;
    try {
      const result = this.machine.transition(this.current, action, { now: this.clock(), rng: this.rng });
      if (!result.ok) return result;

      const previous = this.current;
      this.current = result.state;
      const over = isTerminal(this.machine.status(result.state));

      if (over) {
        this.ended = true;
        this.clearTimer();
      } else if (result.timer !== undefined) {
        this.setTimer(result.timer);
      }

      for (const h of this.hooks) {
        this.safely('onTransition', () => h.onTransition?.({ state: result.state, previous, effects: result.effects }));
      }
      if (over) {
        const outcome = this.machine.status(result.state) === 'finished' ? (result.outcome ?? null) : null;
        for (const h of this.hooks) this.safely('onEnd', () => h.onEnd?.({ state: result.state, outcome }));
      }
      return { ok: true };
    } finally {
      this.busy = false;
    }
  }

  /** Stoppe la session sans passer par la FSM (arrêt du bot). Aucun hook n'est appelé. */
  dispose(): void {
    this.ended = true;
    this.clearTimer();
    this.hooks.clear();
  }

  private setTimer(request: TimerRequest | null): void {
    this.clearTimer();
    if (!request) return;
    const { key, delayMs } = request;
    const handle = this.scheduler.set(() => this.fireTimer(key), delayMs);
    this.timer = { key, deadline: this.clock() + delayMs, handle };
  }

  private clearTimer(): void {
    if (this.timer) this.scheduler.clear(this.timer.handle);
    this.timer = null;
  }

  private fireTimer(key: string): void {
    if (this.timer?.key !== key || this.ended) return;
    this.timer = null;
    const result = this.dispatch(this.machine.timeoutAction(key));
    if (!result.ok) this.logger?.warn(`Timer "${key}" rejeté par la FSM (session ${this.id})`, result.error);
  }

  private safely(hook: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger?.error(`Hook ${hook} en échec (session ${this.id})`, err);
    }
  }
}
