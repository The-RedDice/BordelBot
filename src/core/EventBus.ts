import type { Logger } from './logger.js';

type Handler<P> = (payload: P) => void | Promise<void>;

/**
 * Bus d'événements typé, en mémoire.
 * - Un listener qui lève (sync ou async) est isolé : l'erreur est loggée,
 *   les autres listeners et l'émetteur ne sont pas affectés.
 * - `emit` retourne une Promise résolue quand tous les handlers ont terminé,
 *   ce qui rend les tests déterministes ; l'émetteur peut aussi l'ignorer.
 */
export class EventBus<Events extends { [K in keyof Events]: unknown }> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();

  constructor(private readonly logger?: Logger) {}

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      return handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    const results = await Promise.allSettled(
      [...set].map(async (h) => (h as Handler<Events[K]>)(payload)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger?.error(`Listener en échec pour "${String(event)}"`, r.reason);
      }
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}
