import { REST, Routes } from 'discord.js';
import { loadConfig } from '../config/env.js';

/**
 * Supprime toutes les slash commands de l'application : les globales et, si
 * DISCORD_DEV_GUILD_ID est défini, celles de la guilde de dev. Relancer
 * `npm run deploy:commands` ensuite pour réenregistrer les commandes actuelles.
 */
const config = loadConfig();
const rest = new REST().setToken(config.discordToken);

await rest.put(Routes.applicationCommands(config.discordClientId), { body: [] });
console.log('Commandes globales supprimées.');

if (config.devGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.devGuildId), { body: [] });
  console.log(`Commandes de la guilde ${config.devGuildId} supprimées.`);
}
