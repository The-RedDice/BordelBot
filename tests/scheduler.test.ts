import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import {
  BATCH_SIZE,
  JobScheduler,
  MAX_SLEEP_MS,
  RETRY_DELAYS_MS,
  type ScheduledJob,
} from '../src/core/scheduler/JobScheduler.js';

interface TestJobs {
  ping: { readonly n: number };
  other: { readonly text: string };
}

const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);
const RUNTIME = 'client';

describe('JobScheduler', () => {
  let db: Db;
  let now: number;
  let scheduler: JobScheduler<TestJobs, string>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = T0;
    scheduler = new JobScheduler<TestJobs, string>(db, { clock: () => now });
  });

  afterEach(async () => {
    await scheduler.stop();
    db.close();
  });

  const pending = () => db.prepare('SELECT COUNT(*) FROM scheduled_jobs WHERE failed_at IS NULL').pluck().get();

  it("n'exécute rien avant start, puis seulement les tâches échues, dans l'ordre", async () => {
    const seen: number[] = [];
    scheduler.register('ping', (job, runtime) => {
      expect(runtime).toBe(RUNTIME);
      seen.push(job.payload.n);
    });
    scheduler.schedule('ping', T0 + 2_000, { n: 2 });
    scheduler.schedule('ping', T0 - 1_000, { n: 1 });
    scheduler.schedule('ping', T0 + 60_000, { n: 3 });

    expect(await scheduler.tick()).toBe(0);
    scheduler.start(RUNTIME);
    await scheduler.tick();
    expect(seen).toEqual([1]);

    now = T0 + 2_000;
    await scheduler.tick();
    expect(seen).toEqual([1, 2]);
    expect(pending()).toBe(1);
  });

  it('rattrape au démarrage les tâches échues pendant un arrêt', async () => {
    scheduler.schedule('ping', T0 - 3_600_000, { n: 1 });
    const fresh = new JobScheduler<TestJobs, string>(db, { clock: () => now });
    const handler = vi.fn();
    fresh.register('ping', handler);
    fresh.start(RUNTIME);
    await fresh.tick();
    await fresh.stop();
    expect(handler).toHaveBeenCalledOnce();
    expect(pending()).toBe(0);
  });

  it('laisse en attente les types sans gestionnaire, sans bloquer les autres', async () => {
    const handler = vi.fn();
    scheduler.register('ping', handler);
    for (let i = 0; i < BATCH_SIZE + 5; i++) scheduler.schedule('other', T0 - 10_000, { text: 'x' });
    scheduler.schedule('ping', T0, { n: 1 });
    scheduler.start(RUNTIME);
    await scheduler.tick();
    expect(handler).toHaveBeenCalledOnce();
    expect(scheduler.list('other')).toHaveLength(BATCH_SIZE + 5);
  });

  it('remplace la tâche qui a la même clé et filtre par serveur', () => {
    const a = scheduler.schedule('ping', T0 + 1_000, { n: 1 }, { key: 'k', guildId: 'g1' });
    const b = scheduler.schedule('ping', T0 + 5_000, { n: 2 }, { key: 'k', guildId: 'g1' });
    scheduler.schedule('ping', T0 + 2_000, { n: 3 }, { guildId: 'g2' });
    expect(b).toBe(a);
    expect(scheduler.getByKey('k')).toMatchObject({ runAt: T0 + 5_000, payload: { n: 2 } });
    expect(scheduler.list('ping', { guildId: 'g1' }).map((j) => j.payload.n)).toEqual([2]);
    expect(scheduler.list('ping').map((j) => j.payload.n)).toEqual([3, 2]);
    expect(scheduler.cancelByKey('k')).toBe(true);
    expect(scheduler.get(a)).toBeUndefined();
  });

  it("réessaie après une erreur, puis abandonne quand les délais sont épuisés", async () => {
    let calls = 0;
    scheduler.register('ping', () => {
      calls++;
      throw new Error('Discord indisponible');
    });
    const id = scheduler.schedule('ping', T0, { n: 1 });
    scheduler.start(RUNTIME);

    for (const delay of RETRY_DELAYS_MS) {
      await scheduler.tick();
      expect(scheduler.get(id)).toMatchObject({ runAt: now + delay });
      now += delay;
    }
    await scheduler.tick();
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1);
    expect(scheduler.get(id)).toBeUndefined();
    const row = db.prepare('SELECT failed_at, last_error FROM scheduled_jobs WHERE id = ?').get(id);
    expect(row).toEqual({ failed_at: now, last_error: 'Discord indisponible' });

    // Replanifier avec une clé réactive une tâche abandonnée.
    scheduler.schedule('ping', T0, { n: 1 }, { key: 'k' });
    expect(scheduler.getByKey('k')?.attempts).toBe(0);
  });

  it('replanifie une tâche récurrente avec son nouveau contenu', async () => {
    scheduler.register('ping', (job) => ({ rescheduleAt: job.runAt + 7 * 86_400_000, payload: { n: job.payload.n + 1 } }));
    const id = scheduler.schedule('ping', T0, { n: 1 });
    scheduler.start(RUNTIME);
    await scheduler.tick();
    expect(scheduler.get(id)).toMatchObject({ runAt: T0 + 7 * 86_400_000, payload: { n: 2 }, attempts: 0 });
  });

  it("une annulation ou une replanification pendant l'exécution l'emporte", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    scheduler.register('ping', async (job: ScheduledJob<'ping', { n: number }>) => {
      await gate;
      return job.payload.n === 1 ? { rescheduleAt: T0 + 1_000 } : undefined;
    });
    const cancelled = scheduler.schedule('ping', T0, { n: 1 });
    const moved = scheduler.schedule('ping', T0, { n: 2 }, { key: 'moved' });
    scheduler.start(RUNTIME);
    const running = scheduler.tick();
    scheduler.cancel(cancelled);
    scheduler.schedule('ping', T0 + 3_600_000, { n: 2 }, { key: 'moved' });
    release();
    await running;
    expect(scheduler.get(cancelled)).toBeUndefined();
    expect(scheduler.get(moved)?.runAt).toBe(T0 + 3_600_000);
  });

  it('abandonne une tâche au contenu illisible', async () => {
    const handler = vi.fn();
    scheduler.register('ping', handler);
    db.prepare("INSERT INTO scheduled_jobs (kind, run_at, payload, created_at) VALUES ('ping', ?, '{oops', ?)").run(T0, T0);
    scheduler.start(RUNTIME);
    await scheduler.tick();
    expect(handler).not.toHaveBeenCalled();
    expect(pending()).toBe(0);
  });

  it('refuse deux gestionnaires pour le même type', () => {
    scheduler.register('ping', () => undefined);
    expect(() => scheduler.register('ping', () => undefined)).toThrow(/déjà/);
  });
});

describe('JobScheduler : minuterie', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("se règle sur la prochaine échéance et se réveille quand une tâche est ajoutée", async () => {
    vi.useFakeTimers({ now: T0 });
    const db = openDatabase(':memory:');
    runMigrations(db, migrations);
    const scheduler = new JobScheduler<TestJobs, string>(db);
    const seen: number[] = [];
    scheduler.register('ping', (job) => {
      seen.push(job.payload.n);
    });
    scheduler.start(RUNTIME);
    await vi.advanceTimersByTimeAsync(0);

    scheduler.schedule('ping', T0 + 10_000, { n: 1 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([1]);

    // Échéance lointaine : réveil au plus tard toutes les MAX_SLEEP_MS.
    scheduler.schedule('ping', Date.now() + 3 * MAX_SLEEP_MS + 500, { n: 2 });
    await vi.advanceTimersByTimeAsync(3 * MAX_SLEEP_MS);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([1, 2]);

    await scheduler.stop();
    db.close();
  });
});
