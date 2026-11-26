import { MessageFlags, type Interaction, type RepliableInteraction } from 'discord.js';
import type { CommandRegistry } from './commands/registry.js';
import type { BotContext } from './context.js';

const GENERIC_ERROR = "Une erreur inattendue s'est produite. Réessaie dans un instant.";

async function replyError(interaction: RepliableInteraction): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: GENERIC_ERROR, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: GENERIC_ERROR, flags: MessageFlags.Ephemeral });
    }
  } catch {
    // Interaction expirée ou déjà inaccessible : rien de plus à faire.
  }
}

/** Distribue chaque interaction au bon handler et isole les erreurs. */
export function createInteractionRouter(registry: CommandRegistry, ctx: BotContext) {
  const log = ctx.logger.child('interactions');

  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isChatInputCommand()) {
        const cmd = registry.getCommand(interaction.commandName);
        if (!cmd) {
          log.warn(`Commande inconnue : /${interaction.commandName}`);
          return;
        }
        await cmd.execute(interaction, ctx);
        return;
      }

      if (interaction.isAutocomplete()) {
        await registry.getCommand(interaction.commandName)?.autocomplete?.(interaction, ctx);
        return;
      }

      if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        const handler = registry.getComponentHandler(interaction.customId);
        if (!handler) {
          log.debug(`Aucun handler pour customId "${interaction.customId}"`);
          return;
        }
        await handler.handle(interaction, ctx);
      }
    } catch (err) {
      log.error(`Échec du traitement de l'interaction ${interaction.id}`, err);
      if (interaction.isRepliable()) await replyError(interaction);
    }
  };
}
