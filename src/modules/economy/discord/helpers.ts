import {
  InteractionContextType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type User,
} from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import { replyEphemeral } from '../../../core/replies.js';
import type { EconomyServices, GetServices } from '../services.js';

export type GuildCommand = ChatInputCommandInteraction<'cached' | 'raw'>;

/** Toutes les commandes d'économie sont réservées aux serveurs. */
export function guildOnly(
  handler: (i: GuildCommand, services: EconomyServices) => Promise<void>,
  getServices: GetServices,
): SlashCommand['execute'] {
  return async (interaction) => {
    if (!interaction.inGuild()) return replyEphemeral(interaction, 'Cette commande s’utilise sur un serveur.');
    return handler(interaction, getServices());
  };
}

/** Les bots n'ont pas de compte : on le signale plutôt que d'afficher un solde vide. */
export async function rejectBot(interaction: GuildCommand, user: User): Promise<boolean> {
  if (!user.bot) return false;
  await replyEphemeral(interaction, 'Les bots n’ont pas de compte.');
  return true;
}

export const guildCommand = (name: string, description: string) =>
  new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
