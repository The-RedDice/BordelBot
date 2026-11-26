import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Intents minimaux pour un bot basé sur les slash commands.
 * - Guilds : salons, rôles, interactions.
 * - GuildModeration : événements de ban/unban (synchronisation des logs).
 * GuildMembers (privilégié) n'est pas nécessaire : les options `user` des
 * interactions fournissent déjà le membre résolu.
 * Les modules ajoutent leurs propres intents et partials via `BotModule.intents`
 * et `BotModule.partials`. Un intent privilégié (MessageContent pour la
 * modération) doit aussi être activé dans le Developer Portal, sinon la
 * connexion est refusée.
 */
export function createDiscordClient(
  extraIntents: readonly GatewayIntentBits[] = [],
  extraPartials: readonly Partials[] = [],
): Client {
  return new Client({
    intents: [...new Set([GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, ...extraIntents])],
    partials: [...new Set([Partials.GuildMember, Partials.User, ...extraPartials])],
    allowedMentions: { parse: ['users'], repliedUser: false },
  });
}
