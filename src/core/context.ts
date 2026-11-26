import type { Db } from './database/connection.js';
import type { EventBus } from './EventBus.js';
import type { BotEvents } from './events.js';
import type { Logger } from './logger.js';

/** Dépendances injectées dans chaque module. Aucune référence au client Discord ici. */
export interface BotContext {
  readonly db: Db;
  readonly bus: EventBus<BotEvents>;
  readonly logger: Logger;
}
