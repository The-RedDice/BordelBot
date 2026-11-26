import {
  AttachmentBuilder,
  Events,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type MessageCreateOptions,
  type PartialMessage,
  type ReadonlyCollection,
  type User,
} from 'discord.js';
import type { Deps } from './helpers.js';
import { bulkEmbed, bulkTranscript, deleteEmbed, editEmbed, type LoggedAuthor } from './messageLogRender.js';

const author = (u: User): LoggedAuthor => ({ id: u.id, tag: u.tag, avatarUrl: u.displayAvatarURL() });

/**
 * Publie les messages modifiés et supprimés dans le salon dédié (`/config` →
 * Modération). Le contenu d'avant n'est connu que pour les messages en cache :
 * ceux envoyés depuis le démarrage du bot (les 200 derniers par salon).
 * Les messages des bots, des webhooks et du salon de logs lui-même sont ignorés.
 */
export class MessageLogger {
  constructor(
    private readonly client: Client<true>,
    private readonly deps: Deps,
  ) {}

  start(): void {
    this.client.on(Events.MessageUpdate, this.onUpdate);
    this.client.on(Events.MessageDelete, this.onDelete);
    this.client.on(Events.MessageBulkDelete, this.onBulkDelete);
  }

  stop(): void {
    this.client.off(Events.MessageUpdate, this.onUpdate);
    this.client.off(Events.MessageDelete, this.onDelete);
    this.client.off(Events.MessageBulkDelete, this.onBulkDelete);
  }

  /** Salon de logs du serveur, sauf si l'événement vient de ce salon. */
  private logChannel(guild: Guild, sourceChannelId: string): GuildTextBasedChannel | null {
    const id = this.deps.getService().getMessageLogChannel(guild.id);
    if (!id || id === sourceChannelId) return null;
    const channel = guild.channels.cache.get(id);
    return channel?.isSendable() && channel.isTextBased() ? channel : null;
  }

  private async post(guild: Guild, channel: GuildTextBasedChannel, payload: MessageCreateOptions): Promise<void> {
    try {
      await channel.send({ ...payload, allowedMentions: { parse: [] } });
    } catch (err) {
      this.deps.logger().warn(`Impossible de publier dans le salon des logs de messages ${channel.id} sur ${guild.id}`, err);
    }
  }

  private readonly onUpdate = async (
    oldMessage: Message | PartialMessage,
    newMessage: Message,
  ): Promise<void> => {
    if (!newMessage.inGuild() || newMessage.author.bot || newMessage.webhookId || newMessage.system) return;
    const target = this.logChannel(newMessage.guild, newMessage.channelId);
    if (!target) return;
    const embed = editEmbed({
      author: author(newMessage.author),
      channelId: newMessage.channelId,
      url: newMessage.url,
      before: oldMessage.partial ? null : oldMessage.content,
      after: newMessage.content,
      at: newMessage.editedTimestamp ?? Date.now(),
    });
    if (embed) await this.post(newMessage.guild, target, { embeds: [embed] });
  };

  private readonly onDelete = async (message: Message | PartialMessage): Promise<void> => {
    if (!message.inGuild()) return;
    if (message.author?.bot || message.webhookId || message.system) return;
    const target = this.logChannel(message.guild, message.channelId);
    if (!target) return;
    const known = !message.partial;
    const embed = deleteEmbed({
      author: message.author ? author(message.author) : null,
      channelId: message.channelId,
      messageId: message.id,
      content: known ? message.content : null,
      attachments: message.attachments.map((a) => a.name),
      createdAt: message.createdTimestamp,
      at: Date.now(),
    });
    await this.post(message.guild, target, { embeds: [embed] });
  };

  private readonly onBulkDelete = async (
    messages: ReadonlyCollection<string, Message<true> | PartialMessage<true>>,
    channel: GuildTextBasedChannel,
  ): Promise<void> => {
    const target = this.logChannel(channel.guild, channel.id);
    if (!target) return;
    const relevant = [...messages.values()].filter((m) => !m.author?.bot && !m.webhookId);
    if (!relevant.length) return;
    const known = relevant.filter((m) => !m.partial);
    const transcript = bulkTranscript(
      relevant.map((m) => ({
        authorTag: m.author?.tag ?? null,
        authorId: m.author?.id ?? null,
        createdAt: m.createdTimestamp,
        content: m.partial ? null : m.content,
        attachments: m.attachments.map((a) => a.name),
      })),
    );
    const files = known.length
      ? [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `messages-${channel.id}-${Date.now()}.txt` })]
      : [];
    await this.post(channel.guild, target, { embeds: [bulkEmbed(channel.id, relevant.length, known.length, Date.now())], files });
  };
}
