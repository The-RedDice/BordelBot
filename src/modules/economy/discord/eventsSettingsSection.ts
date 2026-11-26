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
import { formatAmount, MAX_AMOUNT } from '../EconomyService.js';
import type { GetServices } from '../services.js';

const FIELDS = { price: 'ticketPrice', rewards: 'rewards', role: 'championRole', channel: 'eventsChannel' } as const;

/** « 1000/500/250 » → [1000, 500, 250] ; null si invalide. */
export function parseRewards(input: string): [number, number, number] | null {
  const parts = input.replace(/[\s  ]/g, '').split(/[/;,]/);
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const values = parts.map(Number) as [number, number, number];
  return values.every((v) => v <= MAX_AMOUNT) ? values : null;
}

/** `/config` → « Loterie et saisons ». */
export function createEventsSettings(getServices: GetServices): SettingsSection {
  return {
    id: 'economy-events',
    label: 'Loterie et saisons',
    emoji: '🎟️',
    hint: 'Prix du ticket, bonus du podium mensuel, rôle de champion, annonces',
    describe(guildId) {
      const { events, eco } = getServices();
      const s = events.get(guildId);
      const { currencyName: cur } = eco.getSettings(guildId);
      return [
        `**Loterie :** ${s.ticketPrice > 0 ? `ticket à ${formatAmount(s.ticketPrice, cur)}, tirage le dimanche à 20 h` : 'désactivée'}`,
        `**Podium du mois :** ${s.rewards.map((r) => formatAmount(r, cur)).join(' / ')}`,
        `**Champion du mois :** ${s.championRoleId ? `<@&${s.championRoleId}>` : 'pas de rôle'}`,
        `**Annonces :** ${s.channelId ? `<#${s.channelId}>` : 'aucune'}`,
      ].join('\n');
    },
    editor(guildId) {
      const s = getServices().events.get(guildId);
      const role = new RoleSelectMenuBuilder().setCustomId(FIELDS.role).setPlaceholder('Aucun').setRequired(false).setMinValues(0).setMaxValues(1);
      if (s.championRoleId) role.setDefaultRoles(s.championRoleId);
      const channel = new ChannelSelectMenuBuilder()
        .setCustomId(FIELDS.channel)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setPlaceholder('Aucun : pas d’annonce')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(1);
      if (s.channelId) channel.setDefaultChannels(s.channelId);
      const text = (id: string, value: string) =>
        new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40).setValue(value);
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('Prix du ticket de loterie')
          .setDescription('90 % vont dans la cagnotte ; 0 = loterie désactivée')
          .setTextInputComponent(text(FIELDS.price, String(s.ticketPrice))),
        new LabelBuilder()
          .setLabel('Bonus du podium mensuel (1er/2e/3e)')
          .setDescription('Versés le 1er du mois au top 3 des gains, ex. 1000/500/250')
          .setTextInputComponent(text(FIELDS.rewards, s.rewards.join('/'))),
        new LabelBuilder()
          .setLabel('Rôle « Champion du mois »')
          .setDescription('Donné au 1er de la saison, jusqu’à la saison suivante')
          .setRoleSelectMenuComponent(role),
        new LabelBuilder()
          .setLabel('Salon des annonces')
          .setDescription('Tirage de la loterie et podium de la saison')
          .setChannelSelectMenuComponent(channel),
      );
    },
    async submit(interaction) {
      const { events } = getServices();
      const guild = interaction.guild;
      const priceRaw = interaction.fields.getTextInputValue(FIELDS.price).replace(/[\s  ]/g, '');
      const ticketPrice = /^\d+$/.test(priceRaw) ? Number(priceRaw) : NaN;
      if (!(ticketPrice >= 0 && ticketPrice <= 1_000_000_000)) return { ok: false, message: 'Le prix du ticket doit être un nombre positif (0 pour désactiver).' };
      const rewards = parseRewards(interaction.fields.getTextInputValue(FIELDS.rewards));
      if (!rewards) return { ok: false, message: 'Bonus du podium : trois nombres séparés par « / », par exemple `1000/500/250`.' };

      const me = guild.members.me ?? (await guild.members.fetchMe());
      const selectedRole = interaction.fields.getSelectedRoles(FIELDS.role, false)?.first();
      let championRoleId: string | null = null;
      if (selectedRole) {
        const role = guild.roles.cache.get(selectedRole.id);
        if (!role || role.id === guild.id || role.managed) {
          return { ok: false, message: `Le rôle <@&${selectedRole.id}> ne peut pas être attribué (rôle géré ou @everyone).` };
        }
        if (!role.editable) {
          return { ok: false, message: `Je ne peux pas attribuer <@&${role.id}> : il me faut « Gérer les rôles » et un rôle placé au-dessus de lui.` };
        }
        championRoleId = role.id;
      }
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
      const previous = events.get(guild.id);
      events.set(guild.id, { ...previous, ticketPrice, rewards, championRoleId, channelId });
      return { ok: true, message: '✅ Réglages de la loterie et des saisons enregistrés.' };
    },
  };
}
