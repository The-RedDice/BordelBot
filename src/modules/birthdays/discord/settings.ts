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
import type { SettingsSection } from '../../../core/settings/types.js';
import { MAX_BIRTHDAY_BONUS, type BirthdayService } from '../BirthdayService.js';
import { isValidTimeZone } from '../dates.js';

const FIELDS = { channel: 'channel', role: 'role', bonus: 'bonus', hour: 'hour', timezone: 'timezone' } as const;

/** « 9 », « 9h », « 09:00 » → 9 ; null si invalide. */
export function parseHour(input: string): number | null {
  const m = /^(\d{1,2})\s*(?:h|:00)?$/i.exec(input.trim());
  const h = m ? Number(m[1]) : NaN;
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

export function createBirthdaySettings(getService: () => BirthdayService): SettingsSection {
  return {
    id: 'birthdays',
    label: 'Anniversaires',
    emoji: '🎂',
    hint: 'Salon d’annonce, rôle du jour, bonus, heure',
    describe(guildId) {
      const s = getService().getSettings(guildId);
      return [
        `**Annonce :** ${s.channelId ? `<#${s.channelId}> à ${s.hour} h (${s.timezone})` : 'désactivée'}`,
        `**Rôle du jour :** ${s.roleId ? `<@&${s.roleId}>` : 'aucun'}`,
        `**Bonus :** ${s.bonus > 0 ? s.bonus.toLocaleString('fr-FR') : 'aucun'}`,
      ].join('\n');
    },
    editor(guildId) {
      const s = getService().getSettings(guildId);
      const channel = new ChannelSelectMenuBuilder()
        .setCustomId(FIELDS.channel)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setPlaceholder('Aucun : pas d’annonce')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1);
      if (s.channelId) channel.setDefaultChannels(s.channelId);
      const role = new RoleSelectMenuBuilder()
        .setCustomId(FIELDS.role)
        .setPlaceholder('Aucun')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1);
      if (s.roleId) role.setDefaultRoles(s.roleId);
      const text = (id: string, value: string, max: number) =>
        new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setValue(value);

      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('Salon des annonces')
          .setDescription('Le bot y souhaite les anniversaires du jour')
          .setChannelSelectMenuComponent(channel),
        new LabelBuilder()
          .setLabel('Rôle du jour')
          .setDescription('Porté le jour de l’anniversaire, retiré le lendemain')
          .setRoleSelectMenuComponent(role),
        new LabelBuilder()
          .setLabel('Bonus offert')
          .setDescription(`Monnaie offerte une fois par an ; 0 = aucun (${MAX_BIRTHDAY_BONUS.toLocaleString('fr-FR')} max)`)
          .setTextInputComponent(text(FIELDS.bonus, String(s.bonus), 7)),
        new LabelBuilder()
          .setLabel('Heure de l’annonce')
          .setDescription('Heure locale, de 0 à 23')
          .setTextInputComponent(text(FIELDS.hour, String(s.hour), 5)),
        new LabelBuilder()
          .setLabel('Fuseau horaire')
          .setDescription('Nom IANA, ex. Europe/Paris, America/Montreal')
          .setTextInputComponent(text(FIELDS.timezone, s.timezone, 64)),
      );
    },
    async submit(interaction) {
      const guild = interaction.guild;
      const bonusRaw = interaction.fields.getTextInputValue(FIELDS.bonus).replace(/[\s  ]/g, '');
      const bonus = /^\d+$/.test(bonusRaw) ? Number(bonusRaw) : NaN;
      if (!(bonus >= 0 && bonus <= MAX_BIRTHDAY_BONUS)) {
        return { ok: false, message: `Le bonus doit être un nombre entre 0 et ${MAX_BIRTHDAY_BONUS.toLocaleString('fr-FR')}.` };
      }
      const hour = parseHour(interaction.fields.getTextInputValue(FIELDS.hour));
      if (hour === null) return { ok: false, message: 'L’heure doit être un nombre de 0 à 23.' };
      const timezone = interaction.fields.getTextInputValue(FIELDS.timezone).trim();
      if (!isValidTimeZone(timezone)) {
        return { ok: false, message: `Fuseau horaire inconnu : « ${timezone} ». Exemple : \`Europe/Paris\`.` };
      }

      const me = guild.members.me ?? (await guild.members.fetchMe());
      const selectedChannel = interaction.fields.getSelectedChannels(FIELDS.channel, false)?.first();
      let channelId: string | null = null;
      if (selectedChannel) {
        const channel = guild.channels.cache.get(selectedChannel.id);
        const missing = channel?.permissionsFor(me).missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
        if (!channel || (missing && missing.length)) {
          return { ok: false, message: `Il me manque des permissions dans <#${selectedChannel.id}> : ${missing?.join(', ') ?? 'accès'}.` };
        }
        channelId = channel.id;
      }

      const selectedRole = interaction.fields.getSelectedRoles(FIELDS.role, false)?.first();
      let roleId: string | null = null;
      if (selectedRole) {
        const role = guild.roles.cache.get(selectedRole.id);
        if (!role || role.id === guild.id || role.managed) {
          return { ok: false, message: `Le rôle <@&${selectedRole.id}> ne peut pas être attribué (rôle géré ou @everyone).` };
        }
        if (!role.editable) {
          return {
            ok: false,
            message: `Je ne peux pas attribuer <@&${role.id}> : il me faut « Gérer les rôles » et un rôle placé au-dessus de lui.`,
          };
        }
        roleId = role.id;
      }

      getService().setSettings(guild.id, { channelId, roleId, bonus, hour, timezone });
      return {
        ok: true,
        message:
          '✅ Réglages des anniversaires enregistrés.' +
          (channelId || roleId || bonus > 0 ? '' : '\nℹ️ Ni salon, ni rôle, ni bonus : les anniversaires ne seront pas fêtés.'),
      };
    },
  };
}
