import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { SettingsSection } from '../../core/settings/types.js';
import { MAX_WELCOME_LENGTH, type TicketService } from './TicketService.js';

const FIELDS = { category: 'category', staff: 'staffRole', transcripts: 'transcripts', welcome: 'welcome' } as const;

export function createTicketSettings(getService: () => TicketService): SettingsSection {
  return {
    id: 'tickets',
    label: 'Tickets',
    emoji: '📩',
    hint: 'Catégorie des tickets, rôle du staff, archive des transcriptions',
    describe(guildId) {
      const service = getService();
      const s = service.getSettings(guildId);
      return [
        `**Catégorie :** ${s.categoryId ? `<#${s.categoryId}>` : 'aucune (racine du serveur)'}`,
        `**Staff :** ${s.staffRoleId ? `<@&${s.staffRoleId}>` : 'aucun rôle (seuls « Gérer les salons » voient les tickets)'}`,
        `**Transcriptions :** ${s.transcriptChannelId ? `<#${s.transcriptChannelId}>` : 'non archivées (envoyées seulement au membre)'}`,
        `**Tickets ouverts :** ${service.countOpen(guildId)}`,
        '-# Panneau d’ouverture : `/ticket panneau`.',
      ].join('\n');
    },
    editor(guildId) {
      const s = getService().getSettings(guildId);
      const category = new ChannelSelectMenuBuilder()
        .setCustomId(FIELDS.category)
        .setChannelTypes(ChannelType.GuildCategory)
        .setPlaceholder('Aucune : racine du serveur')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1);
      if (s.categoryId) category.setDefaultChannels(s.categoryId);
      const staff = new RoleSelectMenuBuilder().setCustomId(FIELDS.staff).setPlaceholder('Aucun').setRequired(false).setMinValues(0).setMaxValues(1);
      if (s.staffRoleId) staff.setDefaultRoles(s.staffRoleId);
      const transcripts = new ChannelSelectMenuBuilder()
        .setCustomId(FIELDS.transcripts)
        .setChannelTypes(ChannelType.GuildText)
        .setPlaceholder('Aucun : pas d’archive')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1);
      if (s.transcriptChannelId) transcripts.setDefaultChannels(s.transcriptChannelId);
      const welcome = new TextInputBuilder()
        .setCustomId(FIELDS.welcome)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(MAX_WELCOME_LENGTH)
        .setPlaceholder('Merci d’avoir ouvert un ticket. Explique ta demande ici…');
      if (s.welcomeMessage) welcome.setValue(s.welcomeMessage);
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder().setLabel('Catégorie des tickets').setDescription('Les salons de tickets y sont créés').setChannelSelectMenuComponent(category),
        new LabelBuilder().setLabel('Rôle du staff').setDescription('Voit tous les tickets et peut les prendre en charge').setRoleSelectMenuComponent(staff),
        new LabelBuilder()
          .setLabel('Archive des transcriptions')
          .setDescription('Salon réservé au staff ; la transcription part aussi en MP au membre')
          .setChannelSelectMenuComponent(transcripts),
        new LabelBuilder().setLabel('Message d’accueil').setDescription('Vide = message par défaut').setTextInputComponent(welcome),
      );
    },
    async submit(interaction) {
      const guild = interaction.guild;
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const warnings: string[] = [];

      const categoryId = interaction.fields.getSelectedChannels(FIELDS.category, false)?.first()?.id ?? null;
      if (categoryId) {
        const category = guild.channels.cache.get(categoryId);
        const missing = category?.permissionsFor(me).missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]);
        if (!category || (missing && missing.length)) {
          return { ok: false, message: `Il me manque des permissions dans la catégorie <#${categoryId}> : ${missing?.join(', ') ?? 'accès'}.` };
        }
      } else if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        warnings.push('⚠️ Il me manque « Gérer les salons » pour créer les tickets.');
      }

      const staffRoleId = interaction.fields.getSelectedRoles(FIELDS.staff, false)?.first()?.id ?? null;
      if (staffRoleId === guild.id) return { ok: false, message: '@everyone ne peut pas être le rôle du staff.' };

      const transcriptChannelId = interaction.fields.getSelectedChannels(FIELDS.transcripts, false)?.first()?.id ?? null;
      if (transcriptChannelId) {
        const channel = guild.channels.cache.get(transcriptChannelId);
        const missing = channel
          ?.permissionsFor(me)
          .missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]);
        if (!channel || (missing && missing.length)) {
          return { ok: false, message: `Il me manque des permissions dans <#${transcriptChannelId}> : ${missing?.join(', ') ?? 'accès'}.` };
        }
      }

      getService().setSettings(guild.id, {
        categoryId,
        staffRoleId,
        transcriptChannelId,
        welcomeMessage: interaction.fields.getTextInputValue(FIELDS.welcome),
      });
      return { ok: true, message: ['✅ Réglages des tickets enregistrés.', ...warnings].join('\n') };
    },
  };
}
