import type { BotModule } from '../core/commands/types.js';
import { coreModule } from '../core/coreModule.js';
import { economyModule } from './economy/index.js';
import { gamesModule } from './games/index.js';
import { moderationModule } from './moderation/index.js';

/**
 * Ordre d'initialisation : les consommateurs d'événements (économie) avant les
 * producteurs (jeux), pour qu'aucun événement ne soit émis sans abonné.
 */
export const modules: readonly BotModule[] = [coreModule, economyModule, moderationModule, gamesModule];
