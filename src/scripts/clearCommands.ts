import { REST, Routes, type RESTGetAPICurrentUserGuildsResult } from 'discord.js';
import { loadConfig } from '../config/env.js';

/**
 * Supprime toutes les slash commands de l'application : les globales et celles de
 * chaque guilde où le bot est présent (un ancien projet a pu en enregistrer sur
 * n'importe laquelle). Relancer `npm run deploy:commands` ensuite.
 */
const config = loadConfig();
const rest = new REST().setToken(config.discordToken);

await rest.put(Routes.applicationCommands(config.discordClientId), { body: [] });
console.log('Commandes globales supprimées.');

let after: string | undefined;
for (;;) {
  const query = new URLSearchParams({ limit: '200', ...(after ? { after } : {}) });
  const guilds = (await rest.get(Routes.userGuilds(), { query })) as RESTGetAPICurrentUserGuildsResult;
  for (const guild of guilds) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, guild.id), { body: [] });
    console.log(`Commandes de la guilde ${guild.name} (${guild.id}) supprimées.`);
  }
  if (guilds.length < 200) break;
  after = guilds.at(-1)?.id;
}
