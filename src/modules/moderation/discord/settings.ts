import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { SettingsSection } from '../../../core/settings/types.js';
import {
  describeAutomod,
  formatFlood,
  parseAutomodTimeout,
  parseDuplicates,
  parseFlood,
  type AutomodSettingsStore,
} from '../automod/settings.js';
import { formatDuration } from '../duration.js';
import { MAX_WARN_EXPIRY_DAYS, type ModerationService } from '../ModerationService.js';
import { describeThreshold, formatThresholds, parseThresholds } from '../thresholds.js';

const FIELDS = { logs: 'logs', messageLogs: 'messageLogs', expiry: 'expiry', thresholds: 'thresholds' } as const;
const AUTOMOD_FIELDS = { flood: 'flood', duplicates: 'duplicates', timeout: 'timeout', discord: 'discord' } as const;

const SEND = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function channelSelect(customId: string, current: string | null): ChannelSelectMenuBuilder {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setPlaceholder('Aucun : désactivé')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1);
  if (current) select.setDefaultChannels(current);
  return select;
}

/** Salon choisi dans la modale, après vérification des permissions du bot. */
async function pickChannel(
  interaction: ModalSubmitInteraction<'cached'>,
  customId: string,
  needed: readonly bigint[],
): Promise<{ ok: true; id: string | null } | { ok: false; message: string }> {
  const selected = interaction.fields.getSelectedChannels(customId, false)?.first();
  if (!selected) return { ok: true, id: null };
  const guild = interaction.guild;
  const channel = guild.channels.cache.get(selected.id);
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const missing = channel?.permissionsFor(me).missing([...needed]);
  if (!channel || (missing && missing.length)) {
    return { ok: false, message: `Il me manque des permissions dans <#${selected.id}> : ${missing?.join(', ') ?? 'accès'}.` };
  }
  return { ok: true, id: channel.id };
}

export function createModerationSettings(getService: () => ModerationService): SettingsSection {
  return {
    id: 'moderation',
    label: 'Modération',
    emoji: '🛡️',
    hint: 'Salons de logs, expiration des avertissements, sanctions automatiques',
    describe(guildId) {
      const service = getService();
      const logs = service.getLogChannel(guildId);
      const messageLogs = service.getMessageLogChannel(guildId);
      const days = service.getWarnExpiryDays(guildId);
      const thresholds = service.getThresholds(guildId);
      return [
        `**Logs des sanctions :** ${logs ? `<#${logs}>` : 'désactivés'}`,
        `**Logs des messages :** ${messageLogs ? `<#${messageLogs}>` : 'désactivés'}`,
        `**Avertissements :** ${days > 0 ? `expirent après ${days} jour(s)` : 'permanents'}`,
        `**Sanctions automatiques :** ${thresholds.length ? '' : 'aucune'}`,
        ...thresholds.map((t) => `• ${describeThreshold(t)}`),
      ].join('\n');
    },
    editor(guildId) {
      const service = getService();
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('Salon des logs de sanctions')
          .setDescription('Chaque sanction y est publiée ; vide pour désactiver')
          .setChannelSelectMenuComponent(channelSelect(FIELDS.logs, service.getLogChannel(guildId))),
        new LabelBuilder()
          .setLabel('Salon des logs de messages')
          .setDescription('Messages modifiés et supprimés ; à réserver au staff')
          .setChannelSelectMenuComponent(channelSelect(FIELDS.messageLogs, service.getMessageLogChannel(guildId))),
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

      const logs = await pickChannel(interaction, FIELDS.logs, SEND);
      if (!logs.ok) return logs;
      // La transcription des suppressions en masse est envoyée en fichier joint.
      const messageLogs = await pickChannel(interaction, FIELDS.messageLogs, [...SEND, PermissionFlagsBits.AttachFiles]);
      if (!messageLogs.ok) return messageLogs;

      service.setLogChannel(guild.id, logs.id);
      service.setMessageLogChannel(guild.id, messageLogs.id);
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
      if (messageLogs.id && messageLogs.id === logs.id) {
        warnings.push('ℹ️ Les deux logs partagent le même salon : les sanctions risquent d’y être noyées.');
      }
      return { ok: true, message: ['✅ Réglages de modération enregistrés.', ...warnings].join('\n') };
    },
  };
}

export function createAutomodSettings(getStore: () => AutomodSettingsStore): SettingsSection {
  return {
    id: 'automod',
    label: 'Automod',
    emoji: '🤖',
    hint: 'Flood, messages répétés, lien avec l’AutoMod de Discord',
    describe(guildId) {
      return [
        ...describeAutomod(getStore().get(guildId)),
        '-# Mots interdits, invitations et mentions de masse : AutoMod de Discord (Paramètres du serveur → AutoMod).',
      ].join('\n');
    },
    editor(guildId) {
      const s = getStore().get(guildId);
      const text = (id: string, value: string, placeholder: string) =>
        new TextInputBuilder()
          .setCustomId(id)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(16)
          .setPlaceholder(placeholder)
          .setValue(value);
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('Flood (messages/secondes)')
          .setDescription('Ex. 6/5 : 6 messages en 5 s déclenchent l’automod ; 0 = désactivé')
          .setTextInputComponent(text(AUTOMOD_FIELDS.flood, formatFlood(s), '6/5')),
        new LabelBuilder()
          .setLabel('Messages identiques répétés')
          .setDescription('Nombre de messages identiques en 1 minute ; 0 = désactivé')
          .setTextInputComponent(text(AUTOMOD_FIELDS.duplicates, String(s.duplicateCount), '3')),
        new LabelBuilder()
          .setLabel('Exclusion immédiate')
          .setDescription('En plus de l’avertissement, ex. 5m ou 1h ; 0 = aucune')
          .setTextInputComponent(text(AUTOMOD_FIELDS.timeout, s.timeoutMs > 0 ? compactDuration(s.timeoutMs) : '0', '5m')),
        new LabelBuilder()
          .setLabel('Infractions à l’AutoMod de Discord')
          .setDescription('Les compter comme avertissements (paliers de sanctions)')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId(AUTOMOD_FIELDS.discord)
              .addOptions(
                { label: 'Oui : chacune vaut un avertissement', value: 'on', default: s.discordWarns },
                { label: 'Non : sans effet sur les avertissements', value: 'off', default: !s.discordWarns },
              ),
          ),
      );
    },
    async submit(interaction) {
      const flood = parseFlood(interaction.fields.getTextInputValue(AUTOMOD_FIELDS.flood));
      if (!flood.ok) return flood;
      const duplicates = parseDuplicates(interaction.fields.getTextInputValue(AUTOMOD_FIELDS.duplicates));
      if (!duplicates.ok) return duplicates;
      const timeout = parseAutomodTimeout(interaction.fields.getTextInputValue(AUTOMOD_FIELDS.timeout));
      if (!timeout.ok) return timeout;
      const discordWarns = interaction.fields.getStringSelectValues(AUTOMOD_FIELDS.discord)[0] === 'on';

      const store = getStore();
      const previous = store.get(interaction.guildId);
      store.set(interaction.guildId, {
        floodMessages: flood.value?.floodMessages ?? 0,
        floodSeconds: flood.value?.floodSeconds ?? previous.floodSeconds,
        duplicateCount: duplicates.value,
        timeoutMs: timeout.value,
        discordWarns,
      });

      const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
      const needed = [PermissionFlagsBits.ManageMessages];
      if (timeout.value > 0) needed.push(PermissionFlagsBits.ModerateMembers);
      // Discord n'envoie les actions de l'AutoMod qu'aux bots qui ont « Gérer le serveur ».
      if (discordWarns) needed.push(PermissionFlagsBits.ManageGuild);
      const missing = me.permissions.missing(needed);
      const warnings = missing.length ? [`⚠️ Il me manque ${missing.join(', ')} pour que l’automod fonctionne entièrement.`] : [];
      return { ok: true, message: ['✅ Réglages de l’automod enregistrés.', ...warnings].join('\n') };
    },
  };
}

/** « 1 h 30 min » → « 1h30min » : relisible par `parseDuration`. */
function compactDuration(ms: number): string {
  return formatDuration(ms).replace(/ /g, '');
}
