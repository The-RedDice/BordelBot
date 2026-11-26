import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { BotModule } from './commands/types.js';

/** Commandes transverses (diagnostic). */
export const coreModule: BotModule = {
  name: 'core',
  commands: [
    {
      data: new SlashCommandBuilder().setName('ping').setDescription('Vérifie que le bot répond'),
      async execute(interaction) {
        await interaction.reply({
          content: `Pong ! Latence WebSocket : ${interaction.client.ws.ping} ms`,
          flags: MessageFlags.Ephemeral,
        });
      },
    },
  ],
};
