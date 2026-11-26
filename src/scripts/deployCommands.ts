import { REST, Routes } from 'discord.js';
import { loadConfig } from '../config/env.js';
import { CommandRegistry } from '../core/commands/registry.js';
import { modules } from '../modules/index.js';

/**
 * Enregistre les slash commands auprès de Discord.
 * Avec DISCORD_DEV_GUILD_ID : sur cette guilde (effet immédiat).
 * Sans : globalement (propagation pouvant prendre jusqu'à une heure).
 */
const config = loadConfig();
const body = new CommandRegistry(modules).allCommands().map((c) => c.data.toJSON());
const rest = new REST().setToken(config.discordToken);

const route = config.devGuildId
  ? Routes.applicationGuildCommands(config.discordClientId, config.devGuildId)
  : Routes.applicationCommands(config.discordClientId);

await rest.put(route, { body });
console.log(
  `${body.length} commande(s) enregistrée(s) ${config.devGuildId ? `sur la guilde ${config.devGuildId}` : 'globalement'}.`,
);
