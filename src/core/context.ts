import type { Db } from './database/connection.js';
import type { EventBus } from './EventBus.js';
import type { BotEvents } from './events.js';
import type { BotJobs } from './jobs.js';
import type { Logger } from './logger.js';
import type { JobScheduler } from './scheduler/JobScheduler.js';

/**
 * Dépendances injectées dans chaque module. Aucune référence au client Discord ici :
 * le planificateur ne le reçoit qu'à son démarrage, et le transmet à ses gestionnaires.
 */
export interface BotContext {
  readonly db: Db;
  readonly bus: EventBus<BotEvents>;
  readonly logger: Logger;
  readonly scheduler: JobScheduler<BotJobs>;
}
