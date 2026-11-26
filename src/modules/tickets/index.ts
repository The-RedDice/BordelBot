import type { BotModule } from '../../core/commands/types.js';
import type { Logger } from '../../core/logger.js';
import { TicketDesk, type TicketDeps } from './discord.js';
import { createTicketSettings } from './settings.js';
import { TicketService } from './TicketService.js';

/**
 * Module Tickets : panneau d'ouverture (`/ticket panneau`), salon privé entre le
 * membre et le staff, prise en charge, fermeture avec transcription archivée et
 * envoyée au membre. Les tickets sont en base : les boutons survivent aux redémarrages.
 */
let service: TicketService | undefined;
let logger: Logger | undefined;

function getService(): TicketService {
  if (!service) throw new Error('Module tickets non initialisé');
  return service;
}

const deps: TicketDeps = {
  getService,
  logger: () => {
    if (!logger) throw new Error('Module tickets non initialisé');
    return logger;
  },
};

const desk = new TicketDesk(deps);

export const ticketsModule: BotModule = {
  name: 'tickets',
  commands: [desk.command()],
  components: [desk.components()],
  settings: [createTicketSettings(getService)],
  init(ctx) {
    service = new TicketService(ctx.db);
    logger = ctx.logger.child('tickets');
  },
  ready(client) {
    desk.start(client);
  },
  dispose() {
    desk.stop();
    service = undefined;
    logger = undefined;
  },
};
