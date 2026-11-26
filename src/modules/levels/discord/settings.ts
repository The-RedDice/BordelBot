import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
} from 'discord.js';
import type { SettingsSection } from '../../../core/settings/types.js';
import { MAX_COOLDOWN_SECONDS, type AnnounceMode, type LevelService, type LevelSettings } from '../LevelService.js';
import { formatRoleRewards, MAX_ROLE_REWARDS, parseRoleRewards, type RoleRef } from '../rewards.js';

const FIELDS = {
  messageXp: 'messageXp',
  cooldown: 'cooldown',
  voice: 'voice',
  announce: 'announce',
  channel: 'channel',
  rewards: 'rewards',
  stack: 'stack',
} as const;

const ANNOUNCE_LABELS: Record<AnnounceMode, string> = {
  here: 'Dans le salon du message',
  channel: 'Dans un salon dédié',
  off: 'Désactivées',
};

/** « 15-25 » → [15, 25] ; « 20 » → [20, 20] ; null si invalide. */
export function parseXpRange(raw: string): [number, number] | null {
  const m = /^\s*(\d{1,4})\s*(?:[-–à]\s*(\d{1,4}))?\s*$/.exec(raw);
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : Number(m[2]);
  return [min, max];
}

const formatRange = (s: LevelSettings) =>
  s.messageXpMin === s.messageXpMax ? String(s.messageXpMin) : `${s.messageXpMin}-${s.messageXpMax}`;

const parseInteger = (raw: string): number => (/^\s*\d{1,6}\s*$/.test(raw) ? Number(raw.trim()) : NaN);

function textInput(id: string, value: string, maxLength: number): TextInputBuilder {
  return new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(maxLength).setValue(value);
}

export const roleRefs = (guild: Guild): RoleRef[] => [...guild.roles.cache.values()].map((r) => ({ id: r.id, name: r.name }));

/** `getRoles` : rôles d'un serveur (depuis le cache du client), pour pré-remplir la modale avec `@Nom`. */
export function createLevelSettings(getService: () => LevelService, getRoles: (guildId: string) => RoleRef[]): SettingsSection[] {
  const gains: SettingsSection = {
    id: 'levels',
    label: 'Niveaux',
    emoji: '✨',
    hint: 'XP par message et en vocal, délai entre deux gains, annonces',
    describe(guildId) {
      const s = getService().getSettings(guildId);
      return [
        `**XP par message :** ${s.messageXpMax > 0 ? `${formatRange(s)} (une fois toutes les ${s.cooldownSeconds} s)` : 'désactivé'}`,
        `**XP vocal :** ${s.voiceXpPerMinute > 0 ? `${s.voiceXpPerMinute} par minute (à deux minimum, hors AFK)` : 'désactivé'}`,
        `**Annonces :** ${s.announce === 'channel' && s.announceChannelId ? `<#${s.announceChannelId}>` : ANNOUNCE_LABELS[s.announce].toLowerCase()}`,
      ].join('\n');
    },
    editor(guildId) {
      const s = getService().getSettings(guildId);
      const channel = new ChannelSelectMenuBuilder()
        .setCustomId(FIELDS.channel)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setPlaceholder('Seulement pour le mode « salon dédié »')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1);
      if (s.announceChannelId) channel.setDefaultChannels(s.announceChannelId);
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('XP par message')
          .setDescription('Gain aléatoire entre deux bornes, ex. 15-25 (0 = désactivé)')
          .setTextInputComponent(textInput(FIELDS.messageXp, formatRange(s), 9)),
        new LabelBuilder()
          .setLabel('Délai entre deux gains (secondes)')
          .setDescription('Anti-spam : les messages plus rapprochés ne rapportent rien')
          .setTextInputComponent(textInput(FIELDS.cooldown, String(s.cooldownSeconds), 4)),
        new LabelBuilder()
          .setLabel('XP vocal par minute')
          .setDescription('À au moins deux dans un salon, sans sourdine casque (0 = désactivé)')
          .setTextInputComponent(textInput(FIELDS.voice, String(s.voiceXpPerMinute), 4)),
        new LabelBuilder()
          .setLabel('Annonces de montée de niveau')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId(FIELDS.announce)
              .addOptions(
                (Object.keys(ANNOUNCE_LABELS) as AnnounceMode[]).map((mode) => ({
                  label: ANNOUNCE_LABELS[mode],
                  value: mode,
                  default: mode === s.announce,
                })),
              ),
          ),
        new LabelBuilder().setLabel('Salon des annonces').setChannelSelectMenuComponent(channel),
      );
    },
    async submit(interaction) {
      const read = (id: string) => interaction.fields.getTextInputValue(id);
      const range = parseXpRange(read(FIELDS.messageXp));
      if (!range) return { ok: false, message: '« XP par message » : un nombre (`20`) ou deux bornes (`15-25`).' };
      const cooldown = parseInteger(read(FIELDS.cooldown));
      if (Number.isNaN(cooldown)) return { ok: false, message: `Le délai est un nombre de secondes (0 à ${MAX_COOLDOWN_SECONDS}).` };
      const voice = parseInteger(read(FIELDS.voice));
      if (Number.isNaN(voice)) return { ok: false, message: '« XP vocal par minute » doit être un nombre entier.' };
      const announce = (interaction.fields.getStringSelectValues(FIELDS.announce)[0] ?? 'here') as AnnounceMode;

      const selected = interaction.fields.getSelectedChannels(FIELDS.channel, false)?.first();
      let announceChannelId: string | null = null;
      if (selected && announce === 'channel') {
        const guild = interaction.guild;
        const channel = guild.channels.cache.get(selected.id);
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const missing = channel?.permissionsFor(me).missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
        if (!channel || (missing && missing.length)) {
          return { ok: false, message: `Il me manque des permissions dans <#${selected.id}> : ${missing?.join(', ') ?? 'accès'}.` };
        }
        announceChannelId = channel.id;
      }

      const current = getService().getSettings(interaction.guildId);
      const r = getService().updateSettings(interaction.guildId, {
        ...current,
        messageXpMin: range[0],
        messageXpMax: range[1],
        cooldownSeconds: cooldown,
        voiceXpPerMinute: voice,
        announce,
        announceChannelId,
      });
      return r.ok ? { ok: true, message: '✅ Réglages des niveaux enregistrés.' } : { ok: false, message: r.message };
    },
  };

  const roles: SettingsSection = {
    id: 'level-roles',
    label: 'Rôles de niveau',
    emoji: '🏷️',
    hint: 'Rôles attribués automatiquement en atteignant un niveau',
    describe(guildId) {
      const service = getService();
      const rewards = service.getRoleRewards(guildId);
      if (rewards.length === 0) return '*Aucun rôle de niveau.*';
      return [
        ...rewards.map((r) => `• Niveau **${r.level}** → <@&${r.roleId}>`),
        service.getSettings(guildId).stackRoles ? '*Les rôles se cumulent.*' : '*Seul le rôle du plus haut palier est gardé.*',
      ].join('\n');
    },
    editor(guildId) {
      const service = getService();
      const s = service.getSettings(guildId);
      const text = formatRoleRewards(service.getRoleRewards(guildId), getRoles(guildId));
      const rules = new TextInputBuilder()
        .setCustomId(FIELDS.rewards)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1500)
        .setPlaceholder('5 = @Habitué\n10 = @Pilier\n25 = @Légende');
      if (text) rules.setValue(text);
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('Un rôle par palier, une règle par ligne')
          .setDescription(`Mention, ID ou nom exact du rôle ; ${MAX_ROLE_REWARDS} règles au plus`)
          .setTextInputComponent(rules),
        new LabelBuilder()
          .setLabel('Paliers précédents')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder().setCustomId(FIELDS.stack).addOptions(
              { label: 'Les rôles se cumulent', value: 'stack', default: s.stackRoles },
              { label: 'Seul le plus haut palier est gardé', value: 'replace', default: !s.stackRoles },
            ),
          ),
      );
    },
    async submit(interaction) {
      const guild = interaction.guild;
      const parsed = parseRoleRewards(interaction.fields.getTextInputValue(FIELDS.rewards), roleRefs(guild));
      if (!parsed.ok) return { ok: false, message: parsed.message };
      for (const r of parsed.value) {
        const role = guild.roles.cache.get(r.roleId);
        if (!role || role.id === guild.id || role.managed) {
          return { ok: false, message: `Le rôle <@&${r.roleId}> ne peut pas être attribué (rôle géré ou @everyone).` };
        }
        if (!role.editable) {
          return {
            ok: false,
            message: `Je ne peux pas attribuer <@&${r.roleId}> : il me faut « Gérer les rôles » et un rôle placé au-dessus de lui.`,
          };
        }
      }
      const service = getService();
      const stackRoles = (interaction.fields.getStringSelectValues(FIELDS.stack)[0] ?? 'stack') === 'stack';
      service.setRoleRewards(guild.id, parsed.value);
      const r = service.updateSettings(guild.id, { ...service.getSettings(guild.id), stackRoles });
      if (!r.ok) return { ok: false, message: r.message };
      return {
        ok: true,
        message:
          `✅ ${parsed.value.length} rôle(s) de niveau enregistré(s).` +
          (parsed.value.length ? ' Ils sont attribués à la prochaine montée de niveau de chaque membre.' : ''),
      };
    },
  };

  return [gains, roles];
}

