import type { BotModule } from '../../core/commands/types.js';
import type { Logger } from '../../core/logger.js';
import { createModerationCommands } from './discord/commands.js';
import type { Deps } from './discord/helpers.js';
import { createModerationSettings } from './discord/settings.js';
import { TempbanSweeper } from './discord/tempbans.js';
import { ModerationService } from './ModerationService.js';

/**
 * Module Modération : warn, timeout, kick, ban (temporaire ou non), purge,
 * verrouillage et mode lent des salons, avec journal des sanctions
 * (moderation_cases), salon de logs optionnel et sanctions automatiques par paliers.
 * Chaque action est exécutée sur Discord puis enregistrée : un échec Discord
 * ne laisse pas de cas fantôme dans le journal.
 */
let service: ModerationService | undefined;
let logger: Logger | undefined;
let sweeper: TempbanSweeper | undefined;

export function getModerationService(): ModerationService {
  if (!service) throw new Error('Module modération non initialisé');
  return service;
}

const deps: Deps = {
  getService: getModerationService,
  logger: () => {
    if (!logger) throw new Error('Module modération non initialisé');
    return logger;
  },
};

export const moderationModule: BotModule = {
  name: 'moderation',
  commands: createModerationCommands(deps),
  settings: [createModerationSettings(getModerationService)],
  init(ctx) {
    service = new ModerationService(ctx);
    logger = ctx.logger.child('moderation');
  },
  ready(client) {
    sweeper = new TempbanSweeper(client, deps);
    sweeper.start();
  },
  dispose() {
    sweeper?.stop();
    sweeper = undefined;
    service = undefined;
    logger = undefined;
  },
};
