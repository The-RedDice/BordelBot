import {
  ChannelType,
  PermissionFlagsBits,
  type ForumChannel,
  type NewsChannel,
  type PermissionOverwriteOptions,
  type TextChannel,
  type VoiceChannel,
} from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import { replyEphemeral } from '../../../core/replies.js';
import { formatDuration, parseDuration } from '../duration.js';
import { botMember, confirm, guard, postModLog, reasonOption, base, type Cmd, type Deps } from './helpers.js';
import { auditReason } from './render.js';

/** Permissions retirées à @everyone par un verrouillage. */
const LOCK_PERMISSIONS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'] as const;
type LockPermission = (typeof LOCK_PERMISSIONS)[number];
/** État d'origine de chaque permission : true = autorisée, false = refusée, null = héritée. */
type LockSnapshot = Record<LockPermission, boolean | null>;

/** Limite Discord du mode lent : 6 heures. */
export const MAX_SLOWMODE_SECONDS = 21_600;

const LOCKABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
const SLOWMODE_TYPES = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildForum] as const;

type LockableChannel = TextChannel | NewsChannel;
type SlowmodeChannel = TextChannel | VoiceChannel | ForumChannel;

/** « 0 », « off »… : désactiver ; sinon une durée (« 30s », « 2m »). Renvoie des secondes ou null. */
export function parseSlowmode(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (/^(0|off|non|aucun|d[ée]sactiv[ée])$/.test(s)) return 0;
  // Un nombre seul vaut des secondes ici (et non des minutes comme pour /timeout).
  const ms = /^\d+$/.test(s) ? Number(s) * 1000 : parseDuration(s);
  if (ms === null) return null;
  const seconds = Math.round(ms / 1000);
  return seconds >= 1 && seconds <= MAX_SLOWMODE_SECONDS ? seconds : null;
}

function isLockable(channel: unknown): channel is LockableChannel {
  return typeof channel === 'object' && channel !== null && 'type' in channel && (LOCKABLE as readonly unknown[]).includes(channel.type);
}

function isSlowmodable(channel: unknown): channel is SlowmodeChannel {
  return (
    typeof channel === 'object' && channel !== null && 'type' in channel && (SLOWMODE_TYPES as readonly unknown[]).includes(channel.type)
  );
}

function snapshotFrom(metadata: Readonly<Record<string, unknown>> | null): LockSnapshot {
  const raw = (metadata?.['previous'] ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    LOCK_PERMISSIONS.map((p) => [p, typeof raw[p] === 'boolean' ? raw[p] : null]),
  ) as LockSnapshot;
}

/** Vérifie que le bot peut modifier les permissions de ce salon ; répond sinon. */
async function checkChannelPermissions(i: Cmd, channel: LockableChannel | SlowmodeChannel, perms: bigint[]): Promise<boolean> {
  const me = await botMember(i.guild);
  const missing = channel.permissionsFor(me).missing(perms);
  if (missing.length === 0) return true;
  await replyEphemeral(i, `Il me manque des permissions dans ${channel} : ${missing.join(', ')}.`);
  return false;
}

export function createChannelCommands(deps: Deps): SlashCommand[] {
  const service = () => deps.getService();

  const lock: SlashCommand = {
    data: base('lock', 'Verrouille un salon : plus personne ne peut y écrire', PermissionFlagsBits.ManageChannels)
      .addChannelOption((o) => o.setName('salon').setDescription('Salon (celui-ci par défaut)').addChannelTypes(...LOCKABLE))
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ManageChannels);
      if (!i) return;
      const channel = i.options.getChannel('salon', false, [...LOCKABLE]) ?? i.channel;
      if (!isLockable(channel)) return replyEphemeral(i, 'Seuls les salons textuels et d’annonces peuvent être verrouillés.');
      if (!(await checkChannelPermissions(i, channel, [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]))) return;

      const everyone = i.guild.roles.everyone;
      const overwrite = channel.permissionOverwrites.cache.get(everyone.id);
      if (service().openLock(i.guildId, channel.id) || overwrite?.deny.has(PermissionFlagsBits.SendMessages)) {
        return replyEphemeral(i, `${channel} est déjà verrouillé.`);
      }
      const previous = Object.fromEntries(
        LOCK_PERMISSIONS.map((p) => [
          p,
          overwrite?.allow.has(PermissionFlagsBits[p]) ? true : overwrite?.deny.has(PermissionFlagsBits[p]) ? false : null,
        ]),
      ) as LockSnapshot;

      await i.deferReply({ flags: 'Ephemeral' });
      const reason = i.options.getString('raison');
      // Annonce avant le verrouillage : ensuite, le bot lui-même pourrait ne plus pouvoir écrire.
      await channel
        .send({ content: `🔒 Ce salon est verrouillé par la modération.${reason ? `\n> ${reason}` : ''}`, allowedMentions: { parse: [] } })
        .catch(() => undefined);
      const denied = Object.fromEntries(LOCK_PERMISSIONS.map((p) => [p, false])) as PermissionOverwriteOptions;
      await channel.permissionOverwrites.edit(everyone, denied, { reason: auditReason(i.user.tag, reason) });

      const c = service().createCase({
        guildId: i.guildId,
        action: 'lock',
        targetId: channel.id,
        moderatorId: i.user.id,
        reason,
        metadata: { previous },
      });
      await confirm(i, c, [`🔒 ${channel} est verrouillé. \`/unlock\` pour rouvrir.`]);
      await postModLog(deps, i.guild, c);
    },
  };

  const unlock: SlashCommand = {
    data: base('unlock', 'Déverrouille un salon et restaure ses permissions', PermissionFlagsBits.ManageChannels)
      .addChannelOption((o) => o.setName('salon').setDescription('Salon (celui-ci par défaut)').addChannelTypes(...LOCKABLE))
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ManageChannels);
      if (!i) return;
      const channel = i.options.getChannel('salon', false, [...LOCKABLE]) ?? i.channel;
      if (!isLockable(channel)) return replyEphemeral(i, 'Seuls les salons textuels et d’annonces peuvent être déverrouillés.');
      if (!(await checkChannelPermissions(i, channel, [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]))) return;

      const everyone = i.guild.roles.everyone;
      const open = service().openLock(i.guildId, channel.id);
      const overwrite = channel.permissionOverwrites.cache.get(everyone.id);
      if (!open && !overwrite?.deny.has(PermissionFlagsBits.SendMessages)) {
        return replyEphemeral(i, `${channel} n’est pas verrouillé.`);
      }

      await i.deferReply({ flags: 'Ephemeral' });
      const reason = i.options.getString('raison');
      // Sans trace du verrouillage (fait à la main), on remet les permissions en « hérité ».
      const restore = snapshotFrom(open?.metadata ?? null) as PermissionOverwriteOptions;
      await channel.permissionOverwrites.edit(everyone, restore, { reason: auditReason(i.user.tag, reason) });
      if (open) service().resolveCase(open.id);

      const c = service().createCase({ guildId: i.guildId, action: 'unlock', targetId: channel.id, moderatorId: i.user.id, reason });
      await channel.send({ content: '🔓 Ce salon est de nouveau ouvert.', allowedMentions: { parse: [] } }).catch(() => undefined);
      await confirm(i, c, [`🔓 ${channel} est déverrouillé.`]);
      await postModLog(deps, i.guild, c);
    },
  };

  const slowmode: SlashCommand = {
    data: base('slowmode', 'Mode lent : délai minimal entre deux messages d’un membre', PermissionFlagsBits.ManageChannels)
      .addStringOption((o) =>
        o.setName('duree').setDescription('Ex. : 5s, 30s, 2m, 1h (6 h max) ; 0 ou off pour désactiver').setRequired(true).setMaxLength(16),
      )
      .addChannelOption((o) => o.setName('salon').setDescription('Salon (celui-ci par défaut)').addChannelTypes(...SLOWMODE_TYPES))
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ManageChannels);
      if (!i) return;
      const seconds = parseSlowmode(i.options.getString('duree', true));
      if (seconds === null) return replyEphemeral(i, 'Durée invalide : de `1s` à `6h`, ou `off` pour désactiver.');
      const channel = i.options.getChannel('salon', false, [...SLOWMODE_TYPES]) ?? i.channel;
      if (!isSlowmodable(channel)) return replyEphemeral(i, 'Le mode lent ne s’applique pas à ce type de salon.');
      if (!(await checkChannelPermissions(i, channel, [PermissionFlagsBits.ManageChannels]))) return;
      const previous = channel.rateLimitPerUser ?? 0;
      if (previous === seconds) {
        return replyEphemeral(i, seconds ? `Le mode lent est déjà de ${formatDuration(seconds * 1000)}.` : 'Le mode lent est déjà désactivé.');
      }

      const reason = i.options.getString('raison');
      await channel.setRateLimitPerUser(seconds, auditReason(i.user.tag, reason));
      const c = service().createCase({
        guildId: i.guildId,
        action: 'slowmode',
        targetId: channel.id,
        moderatorId: i.user.id,
        reason,
        metadata: { seconds, previous },
      });
      await confirm(i, c, [
        seconds ? `🐌 Mode lent de ${formatDuration(seconds * 1000)} dans ${channel}.` : `Mode lent désactivé dans ${channel}.`,
      ]);
      await postModLog(deps, i.guild, c);
    },
  };

  return [lock, unlock, slowmode];
}
