import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { BotModule } from '../commands/types.js';
import { replyEphemeral } from '../replies.js';
import type { SettingsSection } from './types.js';

export const CONFIG_PREFIX = 'config';
const CONFIG_COLOR = 0x5865f2;

function dashboard(sections: readonly SettingsSection[], guildId: string, guildName: string) {
  const embed = new EmbedBuilder()
    .setColor(CONFIG_COLOR)
    .setTitle(`⚙️ Réglages de ${guildName}`.slice(0, 256))
    .setFooter({ text: 'Clique sur une section pour la modifier' });
  for (const s of sections) {
    embed.addFields({ name: `${s.emoji} ${s.label}`, value: s.describe(guildId).slice(0, 1024) || '—' });
  }
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < sections.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        sections
          .slice(i, i + 5)
          .map((s) =>
            new ButtonBuilder()
              .setCustomId(`${CONFIG_PREFIX}:edit:${s.id}`)
              .setLabel(s.label)
              .setEmoji(s.emoji)
              .setStyle(ButtonStyle.Secondary),
          ),
      ),
    );
  }
  return { embeds: [embed], components: rows };
}

/** Réservé aux membres qui ont réellement « Gérer le serveur » (les permissions par défaut sont modifiables). */
async function canManage(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  if (interaction.inCachedGuild() && interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return true;
  await replyEphemeral(
    interaction,
    interaction.inCachedGuild()
      ? 'Il te faut la permission « Gérer le serveur ».'
      : 'Cette commande s’utilise sur un serveur où je suis présent.',
  );
  return false;
}

/**
 * `/config` : tableau de bord unique des réglages du serveur. Chaque module
 * fournit ses sections (`BotModule.settings`) ; ce module se contente de les
 * afficher, d'ouvrir leur modale et de rafraîchir le tableau après validation.
 * `getModules` est résolu à l'appel pour éviter une dépendance circulaire.
 */
export function createConfigModule(getModules: () => readonly BotModule[]): BotModule {
  const sections = (): SettingsSection[] => getModules().flatMap((m) => m.settings ?? []);
  const find = (id: string | undefined) => sections().find((s) => s.id === id);

  async function openEditor(interaction: ButtonInteraction<'cached'>, sectionId: string | undefined): Promise<void> {
    const section = find(sectionId);
    if (!section) return replyEphemeral(interaction, 'Section inconnue : relance `/config`.');
    const modal = section
      .editor(interaction.guildId)
      .setCustomId(`${CONFIG_PREFIX}:save:${section.id}`)
      .setTitle(`${section.emoji} ${section.label}`.slice(0, 45));
    await interaction.showModal(modal);
  }

  return {
    name: 'config',
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName('config')
          .setDescription('Tableau de bord des réglages du serveur')
          .setContexts(InteractionContextType.Guild)
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        async execute(interaction) {
          if (!(await canManage(interaction)) || !interaction.inCachedGuild()) return;
          await interaction.reply({
            ...dashboard(sections(), interaction.guildId, interaction.guild.name),
            flags: MessageFlags.Ephemeral,
          });
        },
      },
    ],
    components: [
      {
        prefix: CONFIG_PREFIX,
        async handle(interaction) {
          if (!(await canManage(interaction)) || !interaction.inCachedGuild()) return;
          const [, action, sectionId] = interaction.customId.split(':');

          if (action === 'edit' && interaction.isButton()) return openEditor(interaction, sectionId);

          if (action === 'save' && interaction.isModalSubmit()) {
            const section = find(sectionId);
            if (!section) return replyEphemeral(interaction, 'Section inconnue : relance `/config`.');
            const result = await section.submit(interaction);
            const content = result.message.slice(0, 2000);
            if (interaction.isFromMessage()) {
              await interaction.update({ content, ...dashboard(sections(), interaction.guildId, interaction.guild.name) });
            } else {
              await replyEphemeral(interaction, content);
            }
          }
        },
      },
    ],
  };
}
