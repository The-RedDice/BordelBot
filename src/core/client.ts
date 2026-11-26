import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Intents minimaux pour un bot basé sur les slash commands.
 * - Guilds : salons, rôles, interactions.
 * - GuildModeration : événements de ban/unban (synchronisation des logs).
 * GuildMembers (privilégié) n'est pas nécessaire : les options `user` des
 * interactions fournissent déjà le membre résolu. À activer dans le Developer
 * Portal puis ici seulement si un module en a besoin.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration],
    partials: [Partials.GuildMember, Partials.User],
    allowedMentions: { parse: ['users'], repliedUser: false },
  });
}
