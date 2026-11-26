import { GatewayIntentBits, type Client } from 'discord.js';
import type { BotModule } from '../../core/commands/types.js';
import type { Logger } from '../../core/logger.js';
import { createLevelCommands } from './discord/commands.js';
import type { LevelDeps } from './discord/effects.js';
import { createLevelSettings, roleRefs } from './discord/settings.js';
import { LevelTracker } from './discord/tracker.js';
import { LevelService } from './LevelService.js';

/**
 * Module Niveaux : XP gagné en discutant (un gain par minute au plus) et en vocal,
 * niveaux, rôles de récompense, annonces, `/profil niveau`, `/top niveaux` et
 * `/admin xp`. Le contenu des messages n'est jamais lu : seul leur auteur compte,
 * d'où des intents non privilégiés.
 */
let service: LevelService | undefined;
let logger: Logger | undefined;
let client: Client<true> | undefined;
let tracker: LevelTracker | undefined;

export function getLevelService(): LevelService {
  if (!service) throw new Error('Module niveaux non initialisé');
  return service;
}

const deps: LevelDeps = {
  getService: getLevelService,
  logger: () => {
    if (!logger) throw new Error('Module niveaux non initialisé');
    return logger;
  },
};

const guildRoles = (guildId: string) => {
  const guild = client?.guilds.cache.get(guildId);
  return guild ? roleRefs(guild) : [];
};

export const levelsModule: BotModule = {
  name: 'levels',
  intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
  subcommands: createLevelCommands(deps),
  settings: createLevelSettings(getLevelService, guildRoles),
  init(ctx) {
    service = new LevelService(ctx.db);
    logger = ctx.logger.child('levels');
  },
  ready(c) {
    client = c;
    tracker = new LevelTracker(c, deps);
    tracker.start();
  },
  dispose() {
    tracker?.stop();
    tracker = undefined;
    client = undefined;
    service = undefined;
    logger = undefined;
  },
};
