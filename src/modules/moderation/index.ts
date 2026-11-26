import { GatewayIntentBits, Partials } from 'discord.js';
import type { BotModule } from '../../core/commands/types.js';
import type { Logger } from '../../core/logger.js';
import { AutomodSettingsStore } from './automod/settings.js';
import { AutomodListener } from './discord/automod.js';
import { createModerationCommands } from './discord/commands.js';
import type { Deps } from './discord/helpers.js';
import { MessageLogger } from './discord/messageLogs.js';
import { createAutomodSettings, createModerationSettings } from './discord/settings.js';
import { TempbanSweeper } from './discord/tempbans.js';
import { ModerationService } from './ModerationService.js';

/**
 * Module Modération : warn, timeout, kick, ban (temporaire ou non), purge,
 * verrouillage et mode lent des salons, avec journal des sanctions
 * (moderation_cases), salon de logs optionnel et sanctions automatiques par paliers.
 * Chaque action est exécutée sur Discord puis enregistrée : un échec Discord
 * ne laisse pas de cas fantôme dans le journal.
 * S'y ajoutent les notes internes (`/note`), les logs des messages modifiés et
 * supprimés, et l'automod (flood, messages répétés, lien avec l'AutoMod de Discord).
 */
let service: ModerationService | undefined;
let automod: AutomodSettingsStore | undefined;
let logger: Logger | undefined;
let sweeper: TempbanSweeper | undefined;
let messageLogger: MessageLogger | undefined;
let automodListener: AutomodListener | undefined;

export function getModerationService(): ModerationService {
  if (!service) throw new Error('Module modération non initialisé');
  return service;
}

function getAutomodSettings(): AutomodSettingsStore {
  if (!automod) throw new Error('Module modération non initialisé');
  return automod;
}

const deps: Deps = {
  getService: getModerationService,
  getAutomod: getAutomodSettings,
  logger: () => {
    if (!logger) throw new Error('Module modération non initialisé');
    return logger;
  },
};

const { commands, subcommands } = createModerationCommands(deps);

export const moderationModule: BotModule = {
  name: 'moderation',
  // MessageContent (privilégié) : contenu des messages modifiés/supprimés et messages répétés.
  // AutoModerationExecution : actions de l'AutoMod de Discord.
  intents: [
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.AutoModerationExecution,
  ],
  // Sans Partials.Message, la suppression d'un message absent du cache passerait inaperçue.
  partials: [Partials.Message],
  commands,
  subcommands,
  settings: [createModerationSettings(getModerationService), createAutomodSettings(getAutomodSettings)],
  init(ctx) {
    service = new ModerationService(ctx);
    automod = new AutomodSettingsStore(ctx.db);
    logger = ctx.logger.child('moderation');
  },
  ready(client) {
    sweeper = new TempbanSweeper(client, deps);
    sweeper.start();
    messageLogger = new MessageLogger(client, deps);
    messageLogger.start();
    automodListener = new AutomodListener(client, deps);
    automodListener.start();
  },
  dispose() {
    sweeper?.stop();
    messageLogger?.stop();
    automodListener?.stop();
    sweeper = undefined;
    messageLogger = undefined;
    automodListener = undefined;
    service = undefined;
    automod = undefined;
    logger = undefined;
  },
};
