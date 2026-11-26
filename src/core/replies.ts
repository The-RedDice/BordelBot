import { MessageFlags, type InteractionReplyOptions } from 'discord.js';

/** Ce dont les helpers ont besoin ; satisfait par les commandes, composants et modales. */
export interface Repliable {
  readonly deferred: boolean;
  readonly replied: boolean;
  reply(options: InteractionReplyOptions): Promise<unknown>;
  followUp(options: InteractionReplyOptions): Promise<unknown>;
}

/** Répond en privé, que l'interaction ait déjà été acquittée ou non. */
export async function replyEphemeral(interaction: Repliable, content: string): Promise<void> {
  const options: InteractionReplyOptions = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) await interaction.followUp(options);
  else await interaction.reply(options);
}

/** `<t:…:R>` : horodatage relatif affiché dans le fuseau de chaque utilisateur. */
export const relativeTime = (epochMs: number): string => `<t:${Math.ceil(epochMs / 1000)}:R>`;
