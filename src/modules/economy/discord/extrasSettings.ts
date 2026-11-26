import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { SettingsSection } from '../../../core/settings/types.js';
import { formatAmount, MAX_AMOUNT } from '../EconomyService.js';
import type { GetServices } from '../services.js';

const FIELDS = { role: 'richestRole', channel: 'richestChannel', heist: 'heist', cap: 'heistCap' } as const;

/** `/config` → « Rôles et braquage » : rôle du plus riche (et son annonce), braquages. */
export function createExtrasSettings(getServices: GetServices): SettingsSection {
  return {
    id: 'economy-extras',
    label: 'Rôles et braquage',
    emoji: '👑',
    hint: 'Rôle du membre le plus riche, braquages',
    describe(guildId) {
      const { extras, eco } = getServices();
      const x = extras.get(guildId);
      const { currencyName } = eco.getSettings(guildId);
      return [
        `**Rôle du plus riche :** ${x.richestRoleId ? `<@&${x.richestRoleId}>${x.richestUserId ? ` (détenu par <@${x.richestUserId}>)` : ''}` : 'aucun'}`,
        `**Annonce du changement :** ${x.richestChannelId ? `<#${x.richestChannelId}>` : 'aucune'}`,
        `**Braquages :** ${x.heistEnabled ? `activés, butin max ${formatAmount(x.heistCap, currencyName)}` : 'désactivés'}`,
        '-# Les rôles à acheter se créent avec `/admin boutique role`.',
      ].join('\n');
    },
    editor(guildId) {
      const x = getServices().extras.get(guildId);
      const role = new RoleSelectMenuBuilder().setCustomId(FIELDS.role).setPlaceholder('Aucun').setRequired(false).setMinValues(0).setMaxValues(1);
      if (x.richestRoleId) role.setDefaultRoles(x.richestRoleId);
      const channel = new ChannelSelectMenuBuilder()
        .setCustomId(FIELDS.channel)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setPlaceholder('Aucun : pas d’annonce')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1);
      if (x.richestChannelId) channel.setDefaultChannels(x.richestChannelId);
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('Rôle du membre le plus riche')
          .setDescription('Donné au n° 1 de /top fortune, vérifié toutes les heures')
          .setRoleSelectMenuComponent(role),
        new LabelBuilder()
          .setLabel('Salon d’annonce du plus riche')
          .setDescription('Annonce quand le rôle change de main ; vide = pas d’annonce')
          .setChannelSelectMenuComponent(channel),
        new LabelBuilder()
          .setLabel('Braquages (/eco braquer)')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId(FIELDS.heist)
              .addOptions(
                { label: 'Activés', value: 'on', default: x.heistEnabled },
                { label: 'Désactivés', value: 'off', default: !x.heistEnabled },
              ),
          ),
        new LabelBuilder()
          .setLabel('Butin maximal d’un braquage')
          .setDescription('5 à 15 % du solde de la cible, plafonné à ce montant')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(FIELDS.cap)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(16)
              .setValue(String(x.heistCap)),
          ),
      );
    },
    async submit(interaction) {
      const { extras } = getServices();
      const guild = interaction.guild;
      const capRaw = interaction.fields.getTextInputValue(FIELDS.cap).replace(/[\s  ]/g, '');
      const heistCap = /^\d+$/.test(capRaw) ? Number(capRaw) : NaN;
      if (!(heistCap >= 1 && heistCap <= MAX_AMOUNT)) return { ok: false, message: 'Le butin maximal doit être un nombre positif.' };
      const heistEnabled = interaction.fields.getStringSelectValues(FIELDS.heist)[0] !== 'off';

      const me = guild.members.me ?? (await guild.members.fetchMe());
      const selectedRole = interaction.fields.getSelectedRoles(FIELDS.role, false)?.first();
      let richestRoleId: string | null = null;
      if (selectedRole) {
        const role = guild.roles.cache.get(selectedRole.id);
        if (!role || role.id === guild.id || role.managed) {
          return { ok: false, message: `Le rôle <@&${selectedRole.id}> ne peut pas être attribué (rôle géré ou @everyone).` };
        }
        if (!role.editable) {
          return { ok: false, message: `Je ne peux pas attribuer <@&${role.id}> : il me faut « Gérer les rôles » et un rôle placé au-dessus de lui.` };
        }
        richestRoleId = role.id;
      }
      const selectedChannel = interaction.fields.getSelectedChannels(FIELDS.channel, false)?.first();
      let richestChannelId: string | null = null;
      if (selectedChannel) {
        const channel = guild.channels.cache.get(selectedChannel.id);
        const missing = channel?.permissionsFor(me).missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
        if (!channel || (missing && missing.length)) {
          return { ok: false, message: `Il me manque des permissions dans <#${selectedChannel.id}> : ${missing?.join(', ') ?? 'accès'}.` };
        }
        richestChannelId = channel.id;
      }

      const previous = extras.get(guild.id);
      const roleChanged = previous.richestRoleId !== richestRoleId;
      // Nouveau rôle : l'ancien détenteur perd l'ancien rôle, et le prochain passage horaire désigne le détenteur.
      if (roleChanged && previous.richestRoleId && previous.richestUserId) {
        const holder = await guild.members.fetch(previous.richestUserId).catch(() => null);
        await holder?.roles.remove(previous.richestRoleId, 'Rôle du plus riche changé').catch(() => undefined);
      }
      extras.set(guild.id, {
        richestRoleId,
        richestUserId: roleChanged ? null : previous.richestUserId,
        richestChannelId,
        heistEnabled,
        heistCap,
      });
      return {
        ok: true,
        message:
          '✅ Réglages enregistrés.' + (roleChanged && richestRoleId ? '\nℹ️ Le rôle sera attribué au plus riche dans l’heure.' : ''),
      };
    },
  };
}
