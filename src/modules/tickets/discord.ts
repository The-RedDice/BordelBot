import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionContextType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type DMChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type ModalSubmitInteraction,
  type NonThreadGuildBasedChannel,
  type TextChannel,
} from 'discord.js';
import type { ComponentHandler, SlashCommand } from '../../core/commands/types.js';
import type { Logger } from '../../core/logger.js';
import { relativeTime, replyEphemeral } from '../../core/replies.js';
import {
  MAX_REASON_LENGTH,
  MAX_SUBJECT_LENGTH,
  ticketChannelName,
  ticketTranscript,
  type Ticket,
  type TicketService,
  type TranscriptMessage,
} from './TicketService.js';

export const TICKET_PREFIX = 'ticket';
export const TICKET_COLOR = 0x5865f2;
/** Délai entre la fermeture et la suppression du salon (le temps de lire le message de fermeture). */
export const DELETE_DELAY_MS = 10_000;
/** Messages lus au plus pour la transcription. */
export const TRANSCRIPT_LIMIT = 1_000;

export interface TicketDeps {
  readonly getService: () => TicketService;
  readonly logger: () => Logger;
}

const MEMBER_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

/** Staff = rôle configuré, ou permission « Gérer les salons ». */
function isStaff(member: GuildMember, staffRoleId: string | null): boolean {
  return (staffRoleId !== null && member.roles.cache.has(staffRoleId)) || member.permissions.has(PermissionFlagsBits.ManageChannels);
}

function ticketButtons(ticket: Ticket, claimedName?: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}:claim:${ticket.id}`)
      .setLabel(claimedName ? `Pris en charge par ${claimedName}`.slice(0, 80) : 'Prendre en charge')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(claimedName !== undefined),
    new ButtonBuilder().setCustomId(`${TICKET_PREFIX}:close:${ticket.id}`).setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
}

/**
 * Tickets d'assistance : un panneau avec un bouton ouvre, après un court
 * formulaire, un salon privé entre le membre et le staff. À la fermeture, la
 * transcription est archivée et envoyée au membre, puis le salon est supprimé.
 * Tout est en base : les boutons fonctionnent encore après un redémarrage.
 */
export class TicketDesk {
  /** Ouvertures en cours (création du salon) : évite deux tickets si on clique deux fois. */
  private readonly opening = new Set<string>();
  private client: Client<true> | undefined;

  constructor(private readonly deps: TicketDeps) {}

  start(client: Client<true>): void {
    this.client = client;
    client.on(Events.ChannelDelete, this.onChannelDelete);
  }

  stop(): void {
    this.client?.off(Events.ChannelDelete, this.onChannelDelete);
    this.client = undefined;
  }

  /** Salon supprimé à la main : le ticket est marqué fermé. */
  private readonly onChannelDelete = (channel: DMChannel | NonThreadGuildBasedChannel): void => {
    try {
      const ticket = this.deps.getService().byChannel(channel.id);
      if (ticket?.status === 'open') this.deps.getService().close(ticket.id, null, 'salon supprimé');
    } catch (err) {
      this.deps.logger().error(`Tickets : échec du suivi de la suppression du salon ${channel.id}`, err);
    }
  };

  // ---------- Commande ----------

  command(): SlashCommand {
    return {
      data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Tickets d’assistance')
        .setContexts(InteractionContextType.Guild)
        .addSubcommand((s) =>
          s
            .setName('panneau')
            .setDescription('Publie le bouton d’ouverture des tickets (Gérer le serveur)')
            .addChannelOption((o) =>
              o.setName('salon').setDescription('Salon du panneau (celui-ci par défaut)').addChannelTypes(ChannelType.GuildText),
            )
            .addStringOption((o) => o.setName('texte').setDescription('Texte du panneau').setMaxLength(1000)),
        )
        .addSubcommand((s) =>
          s
            .setName('ajouter')
            .setDescription('Donne accès à ce ticket à un membre (staff)')
            .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('retirer')
            .setDescription('Retire l’accès à ce ticket à un membre (staff)')
            .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('fermer')
            .setDescription('Ferme ce ticket')
            .addStringOption((o) => o.setName('raison').setDescription('Raison (dans la transcription)').setMaxLength(MAX_REASON_LENGTH)),
        ),
      execute: (i) => this.execute(i),
    };
  }

  private async execute(i: ChatInputCommandInteraction): Promise<void> {
    if (!i.inCachedGuild()) return replyEphemeral(i, 'Cette commande s’utilise sur un serveur où je suis présent.');
    const sub = i.options.getSubcommand();
    const service = this.deps.getService();

    if (sub === 'panneau') {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return replyEphemeral(i, 'Il te faut la permission « Gérer le serveur ».');
      const target = (i.options.getChannel('salon') as TextChannel | null) ?? i.channel;
      if (!target?.isSendable()) return replyEphemeral(i, 'Je ne peux pas écrire dans ce salon.');
      const embed = new EmbedBuilder()
        .setColor(TICKET_COLOR)
        .setTitle('📩 Besoin d’aide ?')
        .setDescription(
          i.options.getString('texte') ??
            'Clique sur le bouton pour ouvrir un ticket : un salon privé avec l’équipe du serveur. Un seul ticket ouvert à la fois.',
        );
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${TICKET_PREFIX}:open`).setLabel('Ouvrir un ticket').setEmoji('📩').setStyle(ButtonStyle.Primary),
      );
      try {
        await target.send({ embeds: [embed], components: [row] });
      } catch {
        return replyEphemeral(i, `Je n’ai pas pu publier le panneau dans ${target}.`);
      }
      return replyEphemeral(i, `✅ Panneau publié dans ${target}. Pense à régler la catégorie et le rôle du staff dans \`/config\` → Tickets.`);
    }

    const ticket = service.byChannel(i.channelId);
    if (!ticket || ticket.status !== 'open') return replyEphemeral(i, 'Cette commande s’utilise dans un ticket ouvert.');
    const staff = isStaff(i.member, service.getSettings(i.guildId).staffRoleId);

    if (sub === 'fermer') {
      if (!staff && i.user.id !== ticket.openerId) return replyEphemeral(i, 'Seuls le membre qui a ouvert le ticket et le staff peuvent le fermer.');
      return this.close(i, ticket, i.options.getString('raison'));
    }

    if (!staff) return replyEphemeral(i, 'Réservé au staff.');
    const user = i.options.getUser('membre', true);
    const channel = i.channel;
    if (!channel || !('permissionOverwrites' in channel)) return replyEphemeral(i, 'Salon introuvable.');
    if (sub === 'ajouter') {
      if (user.bot) return replyEphemeral(i, 'Inutile d’ajouter un bot.');
      await channel.permissionOverwrites.edit(user.id, Object.fromEntries(MEMBER_PERMS.map((p) => [permName(p), true])), {
        type: OverwriteType.Member,
        reason: `Ajouté au ticket #${ticket.number} par ${i.user.tag}`,
      });
      await i.reply({ content: `➕ ${user} a été ajouté·e au ticket par ${i.user}.`, allowedMentions: { users: [user.id] } });
      return;
    }
    if (user.id === ticket.openerId) return replyEphemeral(i, 'On ne retire pas l’auteur du ticket : ferme-le plutôt.');
    await channel.permissionOverwrites.delete(user.id, `Retiré du ticket #${ticket.number} par ${i.user.tag}`);
    await i.reply({ content: `➖ ${user} n’a plus accès au ticket.`, allowedMentions: { parse: [] } });
  }

  // ---------- Boutons et formulaires ----------

  components(): ComponentHandler {
    return {
      prefix: TICKET_PREFIX,
      handle: async (interaction) => {
        if (!interaction.inCachedGuild()) return;
        const [, action, rawId] = interaction.customId.split(':');
        if (interaction.isButton()) {
          if (action === 'open') return this.askSubject(interaction);
          const ticket = rawId ? this.deps.getService().byId(Number(rawId)) : null;
          if (!ticket || ticket.status !== 'open') return replyEphemeral(interaction, 'Ce ticket est fermé.');
          if (action === 'claim') return this.claim(interaction, ticket);
          if (action === 'close') return this.askCloseReason(interaction, ticket);
        }
        if (interaction.isModalSubmit()) {
          if (action === 'create') return this.open(interaction);
          if (action === 'closeReason') {
            const ticket = rawId ? this.deps.getService().byId(Number(rawId)) : null;
            if (!ticket || ticket.status !== 'open') return replyEphemeral(interaction, 'Ce ticket est déjà fermé.');
            return this.close(interaction, ticket, interaction.fields.getTextInputValue('reason'));
          }
        }
      },
    };
  }

  private async askSubject(i: ButtonInteraction<'cached'>): Promise<void> {
    const existing = this.deps.getService().openTicketOf(i.guildId, i.user.id);
    if (existing) return replyEphemeral(i, `Tu as déjà un ticket ouvert : <#${existing.channelId}>.`);
    await i.showModal(
      new ModalBuilder()
        .setCustomId(`${TICKET_PREFIX}:create`)
        .setTitle('Ouvrir un ticket')
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Sujet')
            .setDescription('En quelques mots : de quoi as-tu besoin ?')
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId('subject')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(MAX_SUBJECT_LENGTH),
            ),
        ),
    );
  }

  private async open(i: ModalSubmitInteraction<'cached'>): Promise<void> {
    const service = this.deps.getService();
    const key = `${i.guildId}:${i.user.id}`;
    const existing = service.openTicketOf(i.guildId, i.user.id);
    if (existing) return replyEphemeral(i, `Tu as déjà un ticket ouvert : <#${existing.channelId}>.`);
    if (this.opening.has(key)) return replyEphemeral(i, 'Ton ticket est en cours de création.');
    this.opening.add(key);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const settings = service.getSettings(i.guildId);
      const guild = i.guild;
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const staffRole = settings.staffRoleId ? guild.roles.cache.get(settings.staffRoleId) : undefined;
      const category = settings.categoryId ? guild.channels.cache.get(settings.categoryId) : undefined;
      const number = service.nextNumber(guild.id);
      const subject = i.fields.getTextInputValue('subject');

      let channel: TextChannel;
      try {
        channel = await guild.channels.create({
          name: ticketChannelName(number, i.user.username),
          type: ChannelType.GuildText,
          parent: category?.type === ChannelType.GuildCategory ? category.id : null,
          topic: `Ticket #${number} de ${i.user.tag} : ${subject}`.slice(0, 1024),
          reason: `Ticket #${number} ouvert par ${i.user.tag}`,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: i.user.id, allow: MEMBER_PERMS, type: OverwriteType.Member },
            ...(staffRole ? [{ id: staffRole.id, allow: [...MEMBER_PERMS, PermissionFlagsBits.ManageMessages], type: OverwriteType.Role }] : []),
            {
              id: me.id,
              allow: [...MEMBER_PERMS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
              type: OverwriteType.Member,
            },
          ],
        });
      } catch (err) {
        this.deps.logger().warn(`Tickets : création du salon impossible sur ${guild.id}`, err);
        await i.editReply('Je n’ai pas pu créer le salon du ticket (permission « Gérer les salons » manquante, ou catégorie pleine). Préviens le staff.');
        return;
      }

      let ticket: Ticket;
      try {
        ticket = service.create({ guildId: guild.id, number, channelId: channel.id, openerId: i.user.id, subject });
      } catch (err) {
        // Course perdue (autre ticket enregistré entre-temps) : on n'abandonne pas un salon vide.
        await channel.delete('Ticket en double').catch(() => undefined);
        throw err;
      }

      const embed = new EmbedBuilder()
        .setColor(TICKET_COLOR)
        .setTitle(`📩 Ticket #${ticket.number}`)
        .setDescription(
          settings.welcomeMessage ??
            'Merci d’avoir ouvert un ticket. Explique ta demande ici : un membre de l’équipe va te répondre.',
        )
        .addFields({ name: 'Sujet', value: ticket.subject }, { name: 'Ouvert par', value: `${i.user}`, inline: true })
        .setTimestamp(ticket.createdAt);
      await channel.send({
        content: `${i.user}${staffRole ? ` ${staffRole}` : ''}`,
        embeds: [embed],
        components: [ticketButtons(ticket)],
        allowedMentions: { users: [i.user.id], roles: staffRole ? [staffRole.id] : [] },
      });
      await i.editReply(`✅ Ton ticket est ouvert : ${channel}.`);
    } finally {
      this.opening.delete(key);
    }
  }

  private async claim(i: ButtonInteraction<'cached'>, ticket: Ticket): Promise<void> {
    const service = this.deps.getService();
    if (!isStaff(i.member, service.getSettings(i.guildId).staffRoleId)) return replyEphemeral(i, 'Réservé au staff.');
    if (ticket.claimedBy) return replyEphemeral(i, `Déjà pris en charge par <@${ticket.claimedBy}>.`);
    service.claim(ticket.id, i.user.id);
    await i.update({ components: [ticketButtons(ticket, i.member.displayName)] });
    await i.followUp({ content: `🙋 ${i.user} prend en charge ce ticket.`, allowedMentions: { parse: [] } });
  }

  private async askCloseReason(i: ButtonInteraction<'cached'>, ticket: Ticket): Promise<void> {
    const staff = isStaff(i.member, this.deps.getService().getSettings(i.guildId).staffRoleId);
    if (!staff && i.user.id !== ticket.openerId) return replyEphemeral(i, 'Seuls le membre qui a ouvert le ticket et le staff peuvent le fermer.');
    await i.showModal(
      new ModalBuilder()
        .setCustomId(`${TICKET_PREFIX}:closeReason:${ticket.id}`)
        .setTitle(`Fermer le ticket #${ticket.number}`)
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Raison (facultative)')
            .setDescription('Notée dans la transcription')
            .setTextInputComponent(
              new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(MAX_REASON_LENGTH),
            ),
        ),
    );
  }

  /** Ferme : transcription archivée et envoyée au membre, puis suppression du salon. */
  private async close(
    i: ChatInputCommandInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
    ticket: Ticket,
    reason: string | null,
  ): Promise<void> {
    const service = this.deps.getService();
    if (!service.close(ticket.id, i.user.id, reason)) return replyEphemeral(i, 'Ce ticket est déjà fermé.');
    const closed = service.byId(ticket.id) ?? ticket;
    await i.reply({
      content: `🔒 Ticket fermé par ${i.user}${closed.closeReason ? ` : ${closed.closeReason}` : ''}. Suppression du salon ${relativeTime(Date.now() + DELETE_DELAY_MS)}.`,
      allowedMentions: { parse: [] },
    });

    const channel = i.guild.channels.cache.get(ticket.channelId);
    const messages = channel?.isTextBased() ? await this.readMessages(channel) : [];
    const file = () =>
      new AttachmentBuilder(Buffer.from(ticketTranscript(closed, i.guild.name, messages), 'utf8'), { name: `ticket-${closed.number}.txt` });
    const summary = new EmbedBuilder()
      .setColor(TICKET_COLOR)
      .setTitle(`🔒 Ticket #${closed.number} fermé`)
      .addFields(
        { name: 'Ouvert par', value: `<@${closed.openerId}>`, inline: true },
        { name: 'Fermé par', value: `${i.user}`, inline: true },
        { name: 'Pris en charge', value: closed.claimedBy ? `<@${closed.claimedBy}>` : '—', inline: true },
        { name: 'Sujet', value: closed.subject },
        ...(closed.closeReason ? [{ name: 'Raison', value: closed.closeReason }] : []),
      )
      .setFooter({ text: `${messages.length} message(s) · ouvert le ${new Date(closed.createdAt).toLocaleDateString('fr-FR')}` });

    const archive = service.getSettings(i.guildId).transcriptChannelId;
    const archiveChannel = archive ? i.guild.channels.cache.get(archive) : undefined;
    if (archiveChannel?.isSendable()) {
      await archiveChannel
        .send({ embeds: [summary], files: [file()], allowedMentions: { parse: [] } })
        .catch((err: unknown) => this.deps.logger().warn(`Tickets : archive impossible sur ${i.guildId}`, err));
    }
    const opener = await i.client.users.fetch(closed.openerId).catch(() => null);
    await opener
      ?.send({ content: `🔒 Ton ticket #${closed.number} sur **${i.guild.name}** a été fermé. Voici la transcription.`, files: [file()] })
      .catch(() => undefined); // MP fermés

    if (channel) {
      const t = setTimeout(() => {
        void channel.delete(`Ticket #${closed.number} fermé par ${i.user.tag}`).catch((err: unknown) => {
          this.deps.logger().warn(`Tickets : suppression du salon ${channel.id} impossible`, err);
        });
      }, DELETE_DELAY_MS);
      t.unref();
    }
  }

  private async readMessages(channel: GuildTextBasedChannel): Promise<TranscriptMessage[]> {
    const out: TranscriptMessage[] = [];
    let before: string | undefined;
    try {
      while (out.length < TRANSCRIPT_LIMIT) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (batch.size === 0) break;
        for (const m of batch.values()) out.push(toTranscript(m));
        before = batch.last()?.id;
        if (batch.size < 100) break;
      }
    } catch (err) {
      this.deps.logger().warn(`Tickets : lecture des messages de ${channel.id} incomplète`, err);
    }
    return out;
  }
}

function toTranscript(m: Message): TranscriptMessage {
  const embeds = m.embeds.length ? ` [${m.embeds.length} embed(s)${m.embeds[0]?.title ? ` : ${m.embeds[0].title}` : ''}]` : '';
  return {
    authorTag: m.author.tag,
    authorId: m.author.id,
    createdAt: m.createdTimestamp,
    content: `${m.content}${embeds}`,
    attachments: m.attachments.map((a) => a.name),
    bot: m.author.bot,
  };
}

/** Nom de la permission attendu par `permissionOverwrites.edit` (« ViewChannel »…). */
function permName(flag: bigint): keyof typeof PermissionFlagsBits {
  const entry = Object.entries(PermissionFlagsBits).find(([, v]) => v === flag);
  return entry![0] as keyof typeof PermissionFlagsBits;
}
