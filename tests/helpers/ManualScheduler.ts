import type { Scheduler } from '../../src/modules/games/engine/GameSession.js';

/** Horloge et timers manuels : `advance(ms)` exécute les timers échus dans l'ordre. */
export class ManualScheduler implements Scheduler {
  now = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();

  readonly clock = (): number => this.now;

  set(fn: () => void, delayMs: number): unknown {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + delayMs, fn });
    return id;
  }

  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  get pending(): number {
    return this.tasks.size;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.tasks) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = target;
  }
}
