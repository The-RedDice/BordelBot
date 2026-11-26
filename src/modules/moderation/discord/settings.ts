import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { SettingsSection } from '../../../core/settings/types.js';
import { MAX_WARN_EXPIRY_DAYS, type ModerationService } from '../ModerationService.js';
import { describeThreshold, formatThresholds, parseThresholds } from '../thresholds.js';

const FIELDS = { logs: 'logs', expiry: 'expiry', thresholds: 'thresholds' } as const;

export function createModerationSettings(getService: () => ModerationService): SettingsSection {
  return {
    id: 'moderation',
    label: 'Modération',
    emoji: '🛡️',
    hint: 'Salon de logs, expiration des avertissements, sanctions automatiques',
    describe(guildId) {
      const service = getService();
      const logs = service.getLogChannel(guildId);
      const days = service.getWarnExpiryDays(guildId);
      const thresholds = service.getThresholds(guildId);
      return [
        `**Logs :** ${logs ? `<#${logs}>` : 'désactivés'}`,
        `**Avertissements :** ${days > 0 ? `expirent après ${days} jour(s)` : 'permanents'}`,
        `**Sanctions automatiques :** ${thresholds.length ? '' : 'aucune'}`,
        ...thresholds.map((t) => `• ${describeThreshold(t)}`),
      ].join('\n');
    },
    editor(guildId) {
      const service = getService();
      const logs = service.getLogChannel(guildId);
      const select = new ChannelSelectMenuBuilder()
        .setCustomId(FIELDS.logs)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setPlaceholder('Aucun : logs désactivés')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1);
      if (logs) select.setDefaultChannels(logs);
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('Salon des logs de modération')
          .setDescription('Chaque sanction y est publiée ; vide pour désactiver')
          .setChannelSelectMenuComponent(select),
        new LabelBuilder()
          .setLabel('Expiration des avertissements (jours)')
          .setDescription('Un avertissement plus ancien ne compte plus ; 0 = jamais')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(FIELDS.expiry)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(4)
              .setValue(String(service.getWarnExpiryDays(guildId))),
          ),
        new LabelBuilder()
          .setLabel('Sanctions automatiques')
          .setDescription('Une règle par ligne, selon le nombre d’avertissements actifs')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(FIELDS.thresholds)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(500)
              .setPlaceholder('3 = timeout 1h\n5 = kick\n7 = ban 7j\n9 = ban')
              .setValue(formatThresholds(service.getThresholds(guildId))),
          ),
      );
    },
    async submit(interaction) {
      const service = getService();
      const guild = interaction.guild;

      const daysRaw = interaction.fields.getTextInputValue(FIELDS.expiry).trim();
      const days = /^\d+$/.test(daysRaw) ? Number(daysRaw) : NaN;
      if (!Number.isInteger(days) || days > MAX_WARN_EXPIRY_DAYS) {
        return { ok: false, message: `L’expiration doit être un nombre de jours entre 0 et ${MAX_WARN_EXPIRY_DAYS}.` };
      }
      const thresholds = parseThresholds(interaction.fields.getTextInputValue(FIELDS.thresholds));
      if (!thresholds.ok) return { ok: false, message: thresholds.message };

      const selected = interaction.fields.getSelectedChannels(FIELDS.logs, false)?.first();
      let logs: string | null = null;
      if (selected) {
        const channel = guild.channels.cache.get(selected.id);
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const missing = channel
          ?.permissionsFor(me)
          .missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
        if (!channel || (missing && missing.length)) {
          return { ok: false, message: `Il me manque des permissions dans <#${selected.id}> : ${missing?.join(', ') ?? 'accès'}.` };
        }
        logs = channel.id;
      }

      service.setLogChannel(guild.id, logs);
      service.setWarnExpiryDays(guild.id, days);
      service.setThresholds(guild.id, thresholds.value);
      const warnings: string[] = [];
      if (thresholds.value.length) {
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const needed = [
          ...new Set(
            thresholds.value.map((t) =>
              t.action === 'timeout'
                ? PermissionFlagsBits.ModerateMembers
                : t.action === 'kick'
                  ? PermissionFlagsBits.KickMembers
                  : PermissionFlagsBits.BanMembers,
            ),
          ),
        ];
        const missing = me.permissions.missing(needed);
        if (missing.length) warnings.push(`⚠️ Il me manque ${missing.join(', ')} pour appliquer certains paliers.`);
      }
      return { ok: true, message: ['✅ Réglages de modération enregistrés.', ...warnings].join('\n') };
    },
  };
}
