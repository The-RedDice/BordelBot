import type { Client } from 'discord.js';
import type { Db } from '../database/connection.js';
import type { Logger } from '../logger.js';

/** Délai maximal entre deux vérifications, même sans tâche proche (horloge système modifiée, tâche ajoutée à la main…). */
export const MAX_SLEEP_MS = 60_000;
/** Tâches exécutées au plus par passage ; s'il en reste, le passage suivant suit aussitôt. */
export const BATCH_SIZE = 25;
/** Délais avant chaque nouvel essai d'une tâche en échec. Après le dernier, la tâche est abandonnée. */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
/** Durée maximale d'attente de la tâche en cours à l'arrêt du bot. */
export const STOP_TIMEOUT_MS = 5_000;

export interface ScheduledJob<K extends string = string, P = unknown> {
  readonly id: number;
  readonly kind: K;
  readonly key: string | null;
  readonly guildId: string | null;
  readonly runAt: number;
  readonly payload: P;
  /** Échecs déjà subis (0 au premier essai). */
  readonly attempts: number;
  readonly createdAt: number;
}

/**
 * Ce que renvoie un gestionnaire :
 * - rien : la tâche est terminée et supprimée ;
 * - `{ rescheduleAt }` : la tâche est replanifiée (tâches récurrentes : tirage
 *   hebdomadaire, annonce quotidienne…), avec éventuellement un nouveau contenu.
 * Lever une erreur déclenche un nouvel essai plus tard (`RETRY_DELAYS_MS`).
 */
export type JobResult<P> = void | { readonly rescheduleAt: number; readonly payload?: P };

export type JobHandler<K extends string, P, R> = (
  job: ScheduledJob<K, P>,
  runtime: R,
) => JobResult<P> | Promise<JobResult<P>>;

export interface ScheduleOptions {
  readonly guildId?: string;
  /**
   * Clé unique : planifier de nouveau avec la même clé remplace la tâche existante
   * (et la réactive si elle avait échoué). Ex. `lottery:<guildId>`.
   */
  readonly key?: string;
}

export interface JobSchedulerOptions {
  readonly logger?: Logger;
  readonly clock?: () => number;
}

interface JobRow {
  id: number;
  kind: string;
  key: string | null;
  guild_id: string | null;
  run_at: number;
  payload: string;
  attempts: number;
  created_at: number;
}

type Kind<Jobs> = keyof Jobs & string;

/**
 * Planificateur de tâches persistant. Les échéances sont en base : une tâche
 * dont l'heure tombe pendant un arrêt du bot est exécutée au redémarrage.
 *
 * - Les modules déclarent leurs gestionnaires (`register`) dans `init` et
 *   planifient quand ils veulent ; rien ne s'exécute avant `start`, appelé quand
 *   le client Discord est prêt.
 * - Exécution « au moins une fois » : une tâche n'est supprimée qu'après la fin
 *   de son gestionnaire. Si le bot s'arrête en plein milieu, elle sera rejouée :
 *   les gestionnaires doivent le supporter (vérifier qu'une annonce n'a pas déjà
 *   été faite, par exemple).
 * - Les tâches d'un type sans gestionnaire restent en attente, sans bloquer les autres.
 * - Une seule minuterie, réglée sur la prochaine échéance (au plus `MAX_SLEEP_MS`).
 */
export class JobScheduler<Jobs extends { [K in keyof Jobs]: unknown }, Runtime = Client<true>> {
  private readonly handlers = new Map<string, JobHandler<string, unknown, Runtime>>();
  private readonly clock: () => number;
  private runtime: Runtime | undefined;
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<number> | undefined;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly options: JobSchedulerOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Déclare le gestionnaire d'un type de tâche. Renvoie une fonction de désinscription. */
  register<K extends Kind<Jobs>>(kind: K, handler: JobHandler<K, Jobs[K], Runtime>): () => void {
    if (this.handlers.has(kind)) throw new Error(`Gestionnaire déjà déclaré pour la tâche "${kind}"`);
    this.handlers.set(kind, handler as JobHandler<string, unknown, Runtime>);
    this.arm();
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  /** Planifie une tâche à `runAt` (timestamp en ms ; dans le passé = dès que possible). Renvoie son id. */
  schedule<K extends Kind<Jobs>>(kind: K, runAt: number, payload: Jobs[K], options: ScheduleOptions = {}): number {
    if (!Number.isFinite(runAt)) throw new RangeError(`Échéance invalide : ${runAt}`);
    const json = JSON.stringify(payload ?? {});
    const id = this.db
      .prepare(
        `INSERT INTO scheduled_jobs (kind, key, guild_id, run_at, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           kind = excluded.kind, guild_id = excluded.guild_id, run_at = excluded.run_at,
           payload = excluded.payload, attempts = 0, last_error = NULL, failed_at = NULL
         RETURNING id`,
      )
      .pluck()
      .get(kind, options.key ?? null, options.guildId ?? null, Math.round(runAt), json, this.clock()) as number;
    this.arm();
    return id;
  }

  /** Annule une tâche. Si elle est en cours d'exécution, elle ne sera ni replanifiée ni réessayée. */
  cancel(id: number): boolean {
    return this.db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id).changes > 0;
  }

  cancelByKey(key: string): boolean {
    return this.db.prepare('DELETE FROM scheduled_jobs WHERE key = ?').run(key).changes > 0;
  }

  get<K extends Kind<Jobs>>(id: number): ScheduledJob<K, Jobs[K]> | undefined {
    const row = this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ? AND failed_at IS NULL').get(id) as
      | JobRow
      | undefined;
    return row ? (toJob(row) as ScheduledJob<K, Jobs[K]>) : undefined;
  }

  getByKey<K extends Kind<Jobs>>(key: string): ScheduledJob<K, Jobs[K]> | undefined {
    const row = this.db.prepare('SELECT * FROM scheduled_jobs WHERE key = ? AND failed_at IS NULL').get(key) as
      | JobRow
      | undefined;
    return row ? (toJob(row) as ScheduledJob<K, Jobs[K]>) : undefined;
  }

  /** Tâches en attente d'un type, de la plus proche à la plus lointaine (ex. `/rappel liste`). */
  list<K extends Kind<Jobs>>(kind: K, filter: { readonly guildId?: string } = {}): ScheduledJob<K, Jobs[K]>[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_jobs
         WHERE kind = ? AND failed_at IS NULL AND (? IS NULL OR guild_id = ?)
         ORDER BY run_at, id`,
      )
      .all(kind, filter.guildId ?? null, filter.guildId ?? null) as JobRow[];
    return rows.map((r) => toJob(r) as ScheduledJob<K, Jobs[K]>);
  }

  /** Démarre l'exécution. `runtime` (le client Discord en production) est transmis aux gestionnaires. */
  start(runtime: Runtime): void {
    this.runtime = runtime;
    this.stopped = false;
    const orphans = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM scheduled_jobs WHERE failed_at IS NULL GROUP BY kind')
      .all() as { kind: string; n: number }[];
    for (const { kind, n } of orphans) {
      if (!this.handlers.has(kind)) this.options.logger?.warn(`${n} tâche(s) "${kind}" sans gestionnaire : ignorée(s)`);
    }
    void this.run();
  }

  /** Arrête la minuterie et attend la fin de la tâche en cours (au plus `STOP_TIMEOUT_MS`). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.current) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref());
      await Promise.race([this.current.then(() => undefined), timeout]);
    }
    this.runtime = undefined;
  }

  /**
   * Exécute les tâches échues (au plus `BATCH_SIZE`). Renvoie le nombre de tâches
   * traitées. Sans effet avant `start` ou si un passage est déjà en cours.
   */
  tick(): Promise<number> {
    return this.run();
  }

  private run(): Promise<number> {
    if (this.current) return this.current;
    this.current = this.runBatch().finally(() => {
      this.current = undefined;
      this.arm();
    });
    return this.current;
  }

  private async runBatch(): Promise<number> {
    const runtime = this.runtime;
    if (runtime === undefined || this.stopped) return 0;
    const due = this.db
      .prepare(
        `SELECT * FROM scheduled_jobs
         WHERE failed_at IS NULL AND run_at <= ? AND kind IN (SELECT value FROM json_each(?))
         ORDER BY run_at, id LIMIT ?`,
      )
      .all(this.clock(), this.registeredKinds(), BATCH_SIZE) as JobRow[];
    let done = 0;
    for (const row of due) {
      if (this.stopped) break;
      await this.runOne(row, runtime);
      done++;
    }
    return done;
  }

  private async runOne(row: JobRow, runtime: Runtime): Promise<void> {
    const handler = this.handlers.get(row.kind);
    if (!handler) return;
    // Les écritures ne portent que sur la version lue : si la tâche a été annulée
    // ou replanifiée (même clé) pendant l'exécution, ce changement l'emporte.
    const where = 'WHERE id = ? AND run_at = ? AND payload = ?';
    const same = [row.id, row.run_at, row.payload] as const;

    let job: ScheduledJob;
    try {
      job = toJob(row);
    } catch (err) {
      this.db.prepare(`UPDATE scheduled_jobs SET failed_at = ?, last_error = ? ${where}`).run(this.clock(), describe(err), ...same);
      this.options.logger?.error(`Tâche #${row.id} (${row.kind}) illisible, abandonnée`, err);
      return;
    }

    let result: JobResult<unknown>;
    try {
      result = await handler(job, runtime);
    } catch (err) {
      const delay = RETRY_DELAYS_MS[row.attempts];
      if (delay === undefined) {
        this.db
          .prepare(`UPDATE scheduled_jobs SET attempts = attempts + 1, failed_at = ?, last_error = ? ${where}`)
          .run(this.clock(), describe(err), ...same);
        this.options.logger?.error(`Tâche #${row.id} (${row.kind}) abandonnée après ${row.attempts + 1} essais`, err);
      } else {
        this.db
          .prepare(`UPDATE scheduled_jobs SET attempts = attempts + 1, run_at = ?, last_error = ? ${where}`)
          .run(this.clock() + delay, describe(err), ...same);
        this.options.logger?.warn(
          `Tâche #${row.id} (${row.kind}) en échec, nouvel essai dans ${Math.round(delay / 60_000)} min`,
          err,
        );
      }
      return;
    }

    if (result && Number.isFinite(result.rescheduleAt)) {
      const payload = 'payload' in result ? JSON.stringify(result.payload ?? {}) : row.payload;
      this.db
        .prepare(`UPDATE scheduled_jobs SET run_at = ?, payload = ?, attempts = 0, last_error = NULL ${where}`)
        .run(Math.round(result.rescheduleAt), payload, ...same);
    } else {
      this.db.prepare(`DELETE FROM scheduled_jobs ${where}`).run(...same);
    }
  }

  /** Règle la minuterie sur la prochaine échéance connue. */
  private arm(): void {
    if (this.runtime === undefined || this.stopped || this.current) return;
    clearTimeout(this.timer);
    const next = this.db
      .prepare(
        `SELECT MIN(run_at) FROM scheduled_jobs
         WHERE failed_at IS NULL AND kind IN (SELECT value FROM json_each(?))`,
      )
      .pluck()
      .get(this.registeredKinds()) as number | null;
    const delay = next === null ? MAX_SLEEP_MS : Math.min(Math.max(next - this.clock(), 0), MAX_SLEEP_MS);
    this.timer = setTimeout(() => void this.run(), delay);
    this.timer.unref();
  }

  private registeredKinds(): string {
    return JSON.stringify([...this.handlers.keys()]);
  }
}

function toJob(row: JobRow): ScheduledJob {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    guildId: row.guild_id,
    runAt: row.run_at,
    payload: JSON.parse(row.payload) as unknown,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

function describe(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
