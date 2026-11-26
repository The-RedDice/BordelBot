import { readFileSync } from 'node:fs';
import { EmbedBuilder, MessageFlags, SlashCommandBuilder, version as discordJsVersion } from 'discord.js';
import type { BotModule } from './commands/types.js';
import { relativeTime } from './replies.js';

/**
 * Version lue dans package.json à la racine du dépôt. Le chemin relatif est le même
 * depuis `src/core/` (tsx) et `dist/core/` (build), d'où la lecture à l'exécution
 * plutôt qu'un import JSON, qui sortirait du rootDir du build.
 */
const botVersion: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'inconnue';
  } catch {
    return 'inconnue';
  }
})();

const formatMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

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
    {
      data: new SlashCommandBuilder().setName('info').setDescription('Informations sur le bot : version, latence, etc.'),
      async execute(interaction, ctx) {
        const response = await interaction.reply({
          content: 'Mesure de la latence…',
          flags: MessageFlags.Ephemeral,
          withResponse: true,
        });
        const sentAt = response.resource?.message?.createdTimestamp;
        const roundTrip = sentAt ? `${sentAt - interaction.createdTimestamp} ms` : 'n/d';

        const { client } = interaction;
        const wsPing = client.ws.ping;
        const startedAt = client.readyTimestamp;
        const schema = ctx.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number | null;

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL() })
          .addFields(
            { name: '📦 Version', value: `v${botVersion} · schéma v${schema ?? 0}`, inline: true },
            { name: '📡 WebSocket', value: wsPing >= 0 ? `${wsPing} ms` : 'n/d', inline: true },
            { name: '⏱️ Aller-retour', value: roundTrip, inline: true },
            { name: '🕒 Démarré', value: startedAt ? relativeTime(startedAt) : 'n/d', inline: true },
            { name: '🌐 Serveurs', value: String(client.guilds.cache.size), inline: true },
            { name: '💾 Mémoire', value: formatMb(process.memoryUsage().rss), inline: true },
            {
              name: '⚙️ Environnement',
              value: `Node.js ${process.version} · discord.js v${discordJsVersion} · ${process.platform}/${process.arch}`,
            },
          );

        await interaction.editReply({ content: '', embeds: [embed] });
      },
    },
  ],
};
