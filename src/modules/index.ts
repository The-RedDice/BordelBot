import type { BotModule } from '../core/commands/types.js';
import { coreModule } from '../core/coreModule.js';
import { createConfigModule } from '../core/settings/configModule.js';
import { birthdaysModule } from './birthdays/index.js';
import { economyModule } from './economy/index.js';
import { gamesModule } from './games/index.js';
import { levelsModule } from './levels/index.js';
import { moderationModule } from './moderation/index.js';
import { ticketsModule } from './tickets/index.js';

/**
 * Ordre d'initialisation : les consommateurs d'événements (économie) avant les
 * producteurs (jeux), pour qu'aucun événement ne soit émis sans abonné.
 */
const featureModules: readonly BotModule[] = [
  coreModule,
  economyModule,
  levelsModule,
  birthdaysModule,
  moderationModule,
  ticketsModule,
  gamesModule,
];

/** `/config` affiche les sections de réglages déclarées par les autres modules. */
export const modules: readonly BotModule[] = [...featureModules, createConfigModule(() => featureModules)];
