import { randomUUID } from 'node:crypto';
import type { BotContext } from '../../core/context.js';
import type { Db } from '../../core/database/connection.js';
import type { Logger } from '../../core/logger.js';
import type { BaseAction, BaseState, GameError, GameMachine, GameOutcome } from './engine/fsm.js';
import { GameSession, realScheduler, type Scheduler } from './engine/GameSession.js';
import { cryptoRng, type Rng } from './engine/rng.js';

export interface GameServiceOptions {
  readonly scheduler?: Scheduler;
  readonly clock?: () => number;
  readonly rng?: Rng;
  readonly idFactory?: () => string;
}

export interface StartGameParams<S extends BaseState, A extends BaseAction, E> {
  readonly machine: GameMachine<S, A, E>;
  readonly initialState: S;
  readonly guildId: string;
  readonly channelId: string;
  readonly hostId: string;
}

export type StartGameResult<S extends BaseState, A extends BaseAction, E> =
  | { readonly ok: true; readonly session: GameSession<S, A, E> }
  | { readonly ok: false; readonly error: GameError };

interface Entry {
  readonly session: { readonly id: string; dispose(): void };
  readonly machine: unknown;
  readonly guildId: string;
}

const CHANNEL_BUSY: GameError = { code: 'CHANNEL_BUSY', message: 'Une partie est déjà en cours dans ce salon.' };

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function prepareStatements(db: Db) {
  return {
    insert: db.prepare(
      `INSERT INTO game_sessions (id, guild_id, channel_id, game, host_id, status, state_json, created_at)
       VALUES (@id, @guildId, @channelId, @game, @hostId, @status, @stateJson, @createdAt)`,
    ),
    snapshot: db.prepare('UPDATE game_sessions SET status = @status, state_json = @stateJson WHERE id = @id'),
    end: db.prepare(
      'UPDATE game_sessions SET status = @status, state_json = @stateJson, ended_at = @endedAt WHERE id = @id',
    ),
    participant: db.prepare(
      `INSERT INTO game_participants (session_id, user_id, role, result)
       VALUES (@sessionId, @userId, @role, @result)
       ON CONFLICT (session_id, user_id) DO UPDATE SET role = excluded.role, result = excluded.result`,
    ),
    cancelActive: db.prepare(
      "UPDATE game_sessions SET status = 'cancelled', ended_at = @endedAt WHERE status IN ('lobby', 'running')",
    ),
    cancelOne: db.prepare("UPDATE game_sessions SET status = 'cancelled', ended_at = @endedAt WHERE id = @id"),
  };
}
type Statements = ReturnType<typeof prepareStatements>;

/**
 * Orchestration des parties : une session active par salon, snapshot de l'état
 * en base à chaque transition, et `game:finished` émis sur l'EventBus en fin de
 * partie. Ne dépend pas de discord.js : l'adaptateur s'abonne à la session.
 */
export class GameService {
  private readonly byChannel = new Map<string, Entry>();
  private readonly scheduler: Scheduler;
  private readonly clock: () => number;
  private readonly rng: Rng;
  private readonly idFactory: () => string;
  private readonly logger: Logger;
  private readonly stmts: Statements;

  constructor(
    private readonly ctx: Pick<BotContext, 'db' | 'bus' | 'logger'>,
    options: GameServiceOptions = {},
  ) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.clock = options.clock ?? Date.now;
    this.rng = options.rng ?? cryptoRng;
    this.idFactory = options.idFactory ?? randomUUID;
    this.logger = ctx.logger.child('games');
    this.stmts = prepareStatements(ctx.db);
  }

  /**
   * Au démarrage : les parties en cours lors d'un arrêt ne peuvent pas reprendre
   * (timers et messages Discord perdus). On les marque annulées.
   */
  recoverInterrupted(): number {
    const { changes } = this.stmts.cancelActive.run({ endedAt: this.clock() });
    if (changes > 0) this.logger.warn(`${changes} partie(s) interrompue(s) marquée(s) comme annulée(s)`);
    return changes;
  }

  start<S extends BaseState, A extends BaseAction, E>(p: StartGameParams<S, A, E>): StartGameResult<S, A, E> {
    if (this.byChannel.has(p.channelId)) return { ok: false, error: CHANNEL_BUSY };

    const id = this.idFactory();
    try {
      this.stmts.insert.run({
        id,
        guildId: p.guildId,
        channelId: p.channelId,
        game: p.machine.kind,
        hostId: p.hostId,
        status: p.machine.status(p.initialState),
        stateJson: JSON.stringify(p.initialState),
        createdAt: this.clock(),
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, error: CHANNEL_BUSY };
      throw err;
    }

    const session = new GameSession(id, p.machine, p.initialState, {
      scheduler: this.scheduler,
      clock: this.clock,
      rng: this.rng,
      logger: this.logger,
    });

    session.subscribe({
      onTransition: ({ state }) => {
        this.stmts.snapshot.run({ id, status: p.machine.status(state), stateJson: JSON.stringify(state) });
      },
      onEnd: ({ state, outcome }) => {
        // Libérer le salon d'abord : même si l'écriture échoue, il ne reste pas bloqué.
        this.byChannel.delete(p.channelId);
        this.finalize(id, p, state, outcome);
      },
    });

    this.byChannel.set(p.channelId, { session, machine: p.machine, guildId: p.guildId });
    this.logger.info(`Partie ${p.machine.kind} ${id} créée dans le salon ${p.channelId}`);
    return { ok: true, session };
  }

  /** Session active du salon, si elle utilise bien cette machine (lecture typée et sûre). */
  get<S extends BaseState, A extends BaseAction, E>(
    channelId: string,
    machine: GameMachine<S, A, E>,
  ): GameSession<S, A, E> | undefined {
    const entry = this.byChannel.get(channelId);
    if (!entry || entry.machine !== machine) return undefined;
    return entry.session as GameSession<S, A, E>;
  }

  isChannelBusy(channelId: string): boolean {
    return this.byChannel.has(channelId);
  }

  get activeCount(): number {
    return this.byChannel.size;
  }

  /** Arrêt du bot : stoppe toutes les sessions et les marque annulées. */
  disposeAll(): void {
    const endedAt = this.clock();
    for (const entry of this.byChannel.values()) {
      entry.session.dispose();
      this.stmts.cancelOne.run({ id: entry.session.id, endedAt });
    }
    this.byChannel.clear();
  }

  private finalize<S extends BaseState, A extends BaseAction, E>(
    id: string,
    p: StartGameParams<S, A, E>,
    state: S,
    outcome: GameOutcome | null,
  ): void {
    const status = p.machine.status(state);
    const finishedAt = this.clock();
    const winners = new Set(outcome?.winnerIds ?? []);
    const losers = new Set(outcome?.loserIds ?? []);

    this.ctx.db.transaction(() => {
      this.stmts.end.run({ id, status, stateJson: JSON.stringify(state), endedAt: finishedAt });
      for (const { userId, role } of p.machine.participants(state)) {
        const result = !outcome ? null : winners.has(userId) ? 'win' : losers.has(userId) ? 'loss' : 'draw';
        this.stmts.participant.run({ sessionId: id, userId, role, result });
      }
    })();

    this.logger.info(`Partie ${id} terminée (${status})`);
    if (status === 'finished' && outcome) {
      void this.ctx.bus.emit('game:finished', {
        sessionId: id,
        guildId: p.guildId,
        channelId: p.channelId,
        game: p.machine.kind,
        winnerIds: outcome.winnerIds,
        loserIds: outcome.loserIds,
        finishedAt,
      });
    }
  }
}
