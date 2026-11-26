import {
  DiscordAPIError,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type SlashCommandStringOption,
  type User,
} from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { replyEphemeral } from '../../../core/replies.js';
import { MAX_REASON_LENGTH, type ModerationCase, type ModerationService } from '../ModerationService.js';
import { checkHierarchy, HIERARCHY_MESSAGES } from '../policy.js';
import { ACTION_LABELS, caseEmbed } from './render.js';

export type Cmd = ChatInputCommandInteraction<'cached'>;

export interface Deps {
  readonly getService: () => ModerationService;
  readonly logger: () => Logger;
}

/** Les messages de plus de 14 jours ne peuvent pas être supprimés en masse (limite Discord). */
export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 3_600_000 - 60_000;

export const PERMISSION_LABELS = new Map<bigint, string>([
  [PermissionFlagsBits.ModerateMembers, 'Exclure temporairement des membres'],
  [PermissionFlagsBits.KickMembers, 'Expulser des membres'],
  [PermissionFlagsBits.BanMembers, 'Bannir des membres'],
  [PermissionFlagsBits.ManageMessages, 'Gérer les messages'],
  [PermissionFlagsBits.ManageGuild, 'Gérer le serveur'],
  [PermissionFlagsBits.ManageChannels, 'Gérer les salons'],
  [PermissionFlagsBits.ManageRoles, 'Gérer les rôles'],
]);

// ---------- Helpers ----------

/**
 * Vérifie le contexte et la permission du modérateur à l'exécution : les
 * permissions par défaut d'une commande peuvent être modifiées par les admins,
 * on ne laisse pas un rôle sans la permission Discord réelle agir via le bot.
 */
export async function guard(i: ChatInputCommandInteraction, perm: bigint): Promise<Cmd | null> {
  if (!i.inCachedGuild()) {
    await replyEphemeral(i, 'Cette commande s’utilise sur un serveur où je suis présent.');
    return null;
  }
  if (!i.memberPermissions.has(perm)) {
    await replyEphemeral(i, `Il te faut la permission « ${PERMISSION_LABELS.get(perm) ?? 'requise'} ».`);
    return null;
  }
  return i;
}

export async function botMember(guild: Guild): Promise<GuildMember> {
  return guild.members.me ?? guild.members.fetchMe();
}

export async function checkBotPermission(i: Cmd, me: GuildMember, perm: bigint): Promise<boolean> {
  if (me.permissions.has(perm)) return true;
  await replyEphemeral(i, `Il me manque la permission « ${PERMISSION_LABELS.get(perm) ?? 'requise'} ».`);
  return false;
}

/** Contrôle de hiérarchie ; répond et renvoie false si l'action est interdite. */
export async function checkTarget(i: Cmd, me: GuildMember, target: GuildMember, botMustOutrank: boolean): Promise<boolean> {
  const error = checkHierarchy({
    actorId: i.user.id,
    targetId: target.id,
    botId: me.id,
    ownerId: i.guild.ownerId,
    actorPosition: i.member.roles.highest.position,
    targetPosition: target.roles.highest.position,
    botPosition: me.roles.highest.position,
    botMustOutrank,
  });
  if (!error) return true;
  await replyEphemeral(i, HIERARCHY_MESSAGES[error]);
  return false;
}

export async function requireMember(i: Cmd, option = 'membre'): Promise<GuildMember | null> {
  const member = i.options.getMember(option);
  if (!member) await replyEphemeral(i, 'Ce membre n’est pas (ou plus) sur le serveur.');
  return member;
}

/** MP au membre sanctionné. Échoue silencieusement si ses MP sont fermés. */
export async function notify(user: User, text: string): Promise<boolean> {
  try {
    await user.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

export const isApiError = (err: unknown, code: number): boolean => err instanceof DiscordAPIError && err.code === code;

/** Poste le cas dans le salon de logs s'il est configuré. N'échoue jamais. */
export async function postModLog(deps: Deps, guild: Guild, c: ModerationCase): Promise<void> {
  const channelId = deps.getService().getLogChannel(guild.id);
  if (!channelId) return;
  try {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    if (!channel?.isSendable()) return;
    await channel.send({ embeds: [caseEmbed(c)], allowedMentions: { parse: [] } });
  } catch (err) {
    deps.logger().warn(`Impossible de poster le cas #${c.caseNumber} dans le salon de logs ${channelId}`, err);
  }
}

/** Réponse au modérateur, privée : le journal public est le salon de logs. */
export async function confirm(i: Cmd, c: ModerationCase, extra: (string | null)[] = []): Promise<void> {
  const lines = [`✅ ${ACTION_LABELS[c.action]} enregistré${c.action === 'purge' ? 'e' : ''} — **cas #${c.caseNumber}**.`, ...extra];
  const content = lines.filter(Boolean).join('\n');
  if (i.deferred) await i.editReply({ content, allowedMentions: { parse: [] } });
  else await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

export const dmLine = (sent: boolean) => (sent ? '📨 Membre prévenu en MP.' : '📭 MP impossible (messages privés fermés).');

export const base = (name: string, description: string, perm: bigint) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(perm);

export const reasonOption = (required: boolean) => (o: SlashCommandStringOption) =>
  o.setName('raison').setDescription('Raison (visible par le membre et dans les logs)').setRequired(required).setMaxLength(MAX_REASON_LENGTH);
