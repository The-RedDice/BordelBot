import type { BotModule } from '../../core/commands/types.js';
import type { Logger } from '../../core/logger.js';
import { createModerationCommands } from './discord/commands.js';
import { ModerationService } from './ModerationService.js';

/**
 * Module Modération : warn, timeout, kick, ban, purge, avec journal des
 * sanctions (moderation_cases) et salon de logs optionnel.
 * Chaque action est exécutée sur Discord puis enregistrée : un échec Discord
 * ne laisse pas de cas fantôme dans le journal.
 */
let service: ModerationService | undefined;
let logger: Logger | undefined;

export function getModerationService(): ModerationService {
  if (!service) throw new Error('Module modération non initialisé');
  return service;
}

export const moderationModule: BotModule = {
  name: 'moderation',
  commands: createModerationCommands({
    getService: getModerationService,
    logger: () => {
      if (!logger) throw new Error('Module modération non initialisé');
      return logger;
    },
  }),
  init(ctx) {
    service = new ModerationService(ctx);
    logger = ctx.logger.child('moderation');
  },
  dispose() {
    service = undefined;
    logger = undefined;
  },
};
