import {
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type SlashCommandStringOption,
  type User,
} from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import type { Logger } from '../../../core/logger.js';
import { replyEphemeral } from '../../../core/replies.js';
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from '../duration.js';
import { MAX_REASON_LENGTH, type ModerationCase, type ModerationService } from '../ModerationService.js';
import { checkHierarchy, HIERARCHY_MESSAGES } from '../policy.js';
import { ACTION_LABELS, auditReason, caseEmbed, caseLine, sanctionDm } from './render.js';

type Cmd = ChatInputCommandInteraction<'cached'>;

interface Deps {
  readonly getService: () => ModerationService;
  readonly logger: () => Logger;
}

/** Les messages de plus de 14 jours ne peuvent pas être supprimés en masse (limite Discord). */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 3_600_000 - 60_000;

const PERMISSION_LABELS = new Map<bigint, string>([
  [PermissionFlagsBits.ModerateMembers, 'Exclure temporairement des membres'],
  [PermissionFlagsBits.KickMembers, 'Expulser des membres'],
  [PermissionFlagsBits.BanMembers, 'Bannir des membres'],
  [PermissionFlagsBits.ManageMessages, 'Gérer les messages'],
  [PermissionFlagsBits.ManageGuild, 'Gérer le serveur'],
]);

// ---------- Helpers ----------

/**
 * Vérifie le contexte et la permission du modérateur à l'exécution : les
 * permissions par défaut d'une commande peuvent être modifiées par les admins,
 * on ne laisse pas un rôle sans la permission Discord réelle agir via le bot.
 */
async function guard(i: ChatInputCommandInteraction, perm: bigint): Promise<Cmd | null> {
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

async function botMember(guild: Guild): Promise<GuildMember> {
  return guild.members.me ?? guild.members.fetchMe();
}

async function checkBotPermission(i: Cmd, me: GuildMember, perm: bigint): Promise<boolean> {
  if (me.permissions.has(perm)) return true;
  await replyEphemeral(i, `Il me manque la permission « ${PERMISSION_LABELS.get(perm) ?? 'requise'} ».`);
  return false;
}

/** Contrôle de hiérarchie ; répond et renvoie false si l'action est interdite. */
async function checkTarget(i: Cmd, me: GuildMember, target: GuildMember, botMustOutrank: boolean): Promise<boolean> {
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

async function requireMember(i: Cmd, option = 'membre'): Promise<GuildMember | null> {
  const member = i.options.getMember(option);
  if (!member) await replyEphemeral(i, 'Ce membre n’est pas (ou plus) sur le serveur.');
  return member;
}

/** MP au membre sanctionné. Échoue silencieusement si ses MP sont fermés. */
async function notify(user: User, text: string): Promise<boolean> {
  try {
    await user.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

const isApiError = (err: unknown, code: number): boolean => err instanceof DiscordAPIError && err.code === code;

/** Poste le cas dans le salon de logs s'il est configuré. N'échoue jamais. */
async function postModLog(deps: Deps, guild: Guild, c: ModerationCase): Promise<void> {
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
async function confirm(i: Cmd, c: ModerationCase, extra: (string | null)[] = []): Promise<void> {
  const lines = [`✅ ${ACTION_LABELS[c.action]} enregistré${c.action === 'purge' ? 'e' : ''} — **cas #${c.caseNumber}**.`, ...extra];
  const content = lines.filter(Boolean).join('\n');
  if (i.deferred) await i.editReply({ content, allowedMentions: { parse: [] } });
  else await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

const dmLine = (sent: boolean) => (sent ? '📨 Membre prévenu en MP.' : '📭 MP impossible (messages privés fermés).');

const base = (name: string, description: string, perm: bigint) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(perm);

const reasonOption = (required: boolean) => (o: SlashCommandStringOption) =>
  o.setName('raison').setDescription('Raison (visible par le membre et dans les logs)').setRequired(required).setMaxLength(MAX_REASON_LENGTH);

// ---------- Commandes ----------

export function createModerationCommands(deps: Deps): SlashCommand[] {
  const service = () => deps.getService();

  const warn: SlashCommand = {
    data: base('warn', 'Avertit un membre', PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('membre').setDescription('Membre à avertir').setRequired(true))
      .addStringOption(reasonOption(true)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ModerateMembers);
      if (!i) return;
      const target = await requireMember(i);
      if (!target) return;
      if (target.user.bot) return replyEphemeral(i, 'Avertir un bot n’a pas d’effet.');
      if (!(await checkTarget(i, await botMember(i.guild), target, false))) return;

      const reason = i.options.getString('raison', true);
      const c = service().createCase({
        guildId: i.guildId,
        action: 'warn',
        targetId: target.id,
        moderatorId: i.user.id,
        reason,
      });
      const sent = await notify(target.user, sanctionDm('warn', i.guild.name, c.reason));
      const total = service().countActiveWarns(i.guildId, target.id);
      await confirm(i, c, [`${target} a désormais **${total}** avertissement(s) actif(s).`, dmLine(sent)]);
      await postModLog(deps, i.guild, c);
    },
  };

  const timeout: SlashCommand = {
    data: base('timeout', 'Exclut temporairement un membre (il ne peut plus écrire ni parler)', PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('membre').setDescription('Membre à exclure').setRequired(true))
      .addStringOption((o) =>
        o.setName('duree').setDescription('Ex. : 10m, 2h, 1h30, 3j (28 jours max)').setRequired(true).setMaxLength(32),
      )
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ModerateMembers);
      if (!i) return;
      const target = await requireMember(i);
      if (!target) return;
      const durationMs = parseDuration(i.options.getString('duree', true));
      if (durationMs === null) return replyEphemeral(i, 'Durée invalide. Exemples : `10m`, `2h`, `1h30`, `3j`.');
      if (durationMs > MAX_TIMEOUT_MS) return replyEphemeral(i, 'Discord limite les exclusions à 28 jours.');

      const me = await botMember(i.guild);
      if (!(await checkBotPermission(i, me, PermissionFlagsBits.ModerateMembers))) return;
      if (!(await checkTarget(i, me, target, true))) return;
      if (target.permissions.has(PermissionFlagsBits.Administrator)) {
        return replyEphemeral(i, 'Discord ne permet pas d’exclure un administrateur.');
      }

      const reason = i.options.getString('raison');
      await target.timeout(durationMs, auditReason(i.user.tag, reason));
      const c = service().createCase({
        guildId: i.guildId,
        action: 'timeout',
        targetId: target.id,
        moderatorId: i.user.id,
        reason,
        durationMs,
      });
      const sent = await notify(target.user, sanctionDm('timeout', i.guild.name, c.reason, durationMs));
      await confirm(i, c, [`${target} est exclu·e pour ${formatDuration(durationMs)}.`, dmLine(sent)]);
      await postModLog(deps, i.guild, c);
    },
  };

  const untimeout: SlashCommand = {
    data: base('untimeout', 'Lève l’exclusion temporaire d’un membre', PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('membre').setDescription('Membre concerné').setRequired(true))
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ModerateMembers);
      if (!i) return;
      const target = await requireMember(i);
      if (!target) return;
      if (!target.isCommunicationDisabled()) return replyEphemeral(i, 'Ce membre n’est pas exclu.');
      const me = await botMember(i.guild);
      if (!(await checkBotPermission(i, me, PermissionFlagsBits.ModerateMembers))) return;
      if (!(await checkTarget(i, me, target, true))) return;

      const reason = i.options.getString('raison');
      await target.timeout(null, auditReason(i.user.tag, reason));
      const c = service().createCase({
        guildId: i.guildId,
        action: 'untimeout',
        targetId: target.id,
        moderatorId: i.user.id,
        reason,
      });
      await confirm(i, c);
      await postModLog(deps, i.guild, c);
    },
  };

  const kick: SlashCommand = {
    data: base('kick', 'Expulse un membre (il pourra revenir avec une invitation)', PermissionFlagsBits.KickMembers)
      .addUserOption((o) => o.setName('membre').setDescription('Membre à expulser').setRequired(true))
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.KickMembers);
      if (!i) return;
      const target = await requireMember(i);
      if (!target) return;
      const me = await botMember(i.guild);
      if (!(await checkBotPermission(i, me, PermissionFlagsBits.KickMembers))) return;
      if (!(await checkTarget(i, me, target, true))) return;

      const reason = i.options.getString('raison');
      // Le MP doit partir avant : après l'expulsion, le bot ne partage plus de serveur avec le membre.
      const sent = target.user.bot ? false : await notify(target.user, sanctionDm('kick', i.guild.name, reason));
      await target.kick(auditReason(i.user.tag, reason));
      const c = service().createCase({ guildId: i.guildId, action: 'kick', targetId: target.id, moderatorId: i.user.id, reason });
      await confirm(i, c, [dmLine(sent)]);
      await postModLog(deps, i.guild, c);
    },
  };

  const ban: SlashCommand = {
    data: base('ban', 'Bannit un utilisateur, même absent du serveur', PermissionFlagsBits.BanMembers)
      .addUserOption((o) =>
        o.setName('utilisateur').setDescription('Utilisateur à bannir (mention ou ID)').setRequired(true),
      )
      .addStringOption(reasonOption(false))
      .addIntegerOption((o) =>
        o
          .setName('messages')
          .setDescription('Supprimer ses messages récents')
          .addChoices(
            { name: 'Ne rien supprimer', value: 0 },
            { name: 'Dernière heure', value: 3_600 },
            { name: 'Dernières 24 h', value: 86_400 },
            { name: '7 derniers jours', value: 604_800 },
          ),
      ),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.BanMembers);
      if (!i) return;
      const user = i.options.getUser('utilisateur', true);
      const member = i.options.getMember('utilisateur');
      const me = await botMember(i.guild);
      if (!(await checkBotPermission(i, me, PermissionFlagsBits.BanMembers))) return;
      if (member) {
        if (!(await checkTarget(i, me, member, true))) return;
      } else if (user.id === i.user.id || user.id === me.id) {
        return replyEphemeral(i, HIERARCHY_MESSAGES[user.id === me.id ? 'BOT_ITSELF' : 'SELF']);
      }
      try {
        await i.guild.bans.fetch({ user: user.id, force: true });
        return replyEphemeral(i, 'Cet utilisateur est déjà banni.');
      } catch (err) {
        if (!isApiError(err, RESTJSONErrorCodes.UnknownBan)) throw err;
      }

      const reason = i.options.getString('raison');
      const sent = member && !user.bot ? await notify(user, sanctionDm('ban', i.guild.name, reason)) : false;
      await i.guild.bans.create(user.id, {
        reason: auditReason(i.user.tag, reason),
        deleteMessageSeconds: i.options.getInteger('messages') ?? 0,
      });
      const c = service().createCase({ guildId: i.guildId, action: 'ban', targetId: user.id, moderatorId: i.user.id, reason });
      await confirm(i, c, [member ? dmLine(sent) : 'ℹ️ Utilisateur absent du serveur : banni préventivement.']);
      await postModLog(deps, i.guild, c);
    },
  };

  const unban: SlashCommand = {
    data: base('unban', 'Lève le bannissement d’un utilisateur', PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName('utilisateur').setDescription('Utilisateur (ID)').setRequired(true))
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.BanMembers);
      if (!i) return;
      const me = await botMember(i.guild);
      if (!(await checkBotPermission(i, me, PermissionFlagsBits.BanMembers))) return;
      const user = i.options.getUser('utilisateur', true);
      const reason = i.options.getString('raison');
      try {
        await i.guild.bans.remove(user.id, auditReason(i.user.tag, reason));
      } catch (err) {
        if (isApiError(err, RESTJSONErrorCodes.UnknownBan)) return replyEphemeral(i, 'Cet utilisateur n’est pas banni.');
        throw err;
      }
      const c = service().createCase({ guildId: i.guildId, action: 'unban', targetId: user.id, moderatorId: i.user.id, reason });
      await confirm(i, c);
      await postModLog(deps, i.guild, c);
    },
  };

  const purge: SlashCommand = {
    data: base('purge', 'Supprime les derniers messages du salon', PermissionFlagsBits.ManageMessages)
      .addIntegerOption((o) =>
        o.setName('nombre').setDescription('Nombre de messages (1 à 100)').setRequired(true).setMinValue(1).setMaxValue(100),
      )
      .addUserOption((o) => o.setName('membre').setDescription('Uniquement les messages de ce membre'))
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ManageMessages);
      if (!i) return;
      const channel = i.channel;
      if (!channel || channel.isDMBased() || !channel.isTextBased() || !('bulkDelete' in channel)) {
        return replyEphemeral(i, 'Impossible de purger ce salon.');
      }
      const missing = i.appPermissions.missing([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory]);
      if (missing.length) return replyEphemeral(i, `Il me manque des permissions dans ce salon : ${missing.join(', ')}.`);

      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const count = i.options.getInteger('nombre', true);
      const author = i.options.getUser('membre');
      const minTimestamp = Date.now() - BULK_DELETE_MAX_AGE_MS;

      const fetched = await channel.messages.fetch({ limit: 100 });
      const toDelete: Message[] = [];
      let skippedOld = 0;
      for (const m of fetched.values()) {
        if (toDelete.length >= count) break;
        if (author && m.author.id !== author.id) continue;
        if (m.pinned) continue;
        if (m.createdTimestamp < minTimestamp) {
          skippedOld++;
          continue;
        }
        toDelete.push(m);
      }
      if (toDelete.length === 0) {
        await i.editReply('Aucun message à supprimer (les messages épinglés ou de plus de 14 jours sont ignorés).');
        return;
      }

      const deleted = await channel.bulkDelete(toDelete, true);
      const c = service().createCase({
        guildId: i.guildId,
        action: 'purge',
        targetId: channel.id,
        moderatorId: i.user.id,
        reason: i.options.getString('raison'),
        metadata: { requested: count, deleted: deleted.size, authorId: author?.id ?? null },
      });
      await confirm(i, c, [
        `🧹 ${deleted.size} message(s) supprimé(s)${author ? ` de ${author}` : ''}.`,
        skippedOld ? `ℹ️ ${skippedOld} message(s) de plus de 14 jours ignoré(s) (limite Discord).` : null,
      ]);
      await postModLog(deps, i.guild, c);
    },
  };

  const sanctions: SlashCommand = {
    data: base('sanctions', 'Historique des sanctions d’un utilisateur', PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true))
      .addBooleanOption((o) => o.setName('revoquees').setDescription('Inclure les avertissements révoqués')),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ModerateMembers);
      if (!i) return;
      const user = i.options.getUser('utilisateur', true);
      const cases = service().listCases(i.guildId, user.id, {
        limit: 10,
        includeRevoked: i.options.getBoolean('revoquees') ?? false,
      });
      const warns = service().countActiveWarns(i.guildId, user.id);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: `Sanctions de ${user.tag}`, iconURL: user.displayAvatarURL() })
        .setDescription(cases.length ? cases.map(caseLine).join('\n\n').slice(0, 4096) : '*Aucune sanction.*')
        .setFooter({ text: `${warns} avertissement(s) actif(s) · 10 derniers cas` });
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  };

  const delwarn: SlashCommand = {
    data: base('delwarn', 'Révoque un avertissement (il reste visible dans le journal)', PermissionFlagsBits.ModerateMembers)
      .addIntegerOption((o) => o.setName('cas').setDescription('Numéro du cas').setRequired(true).setMinValue(1))
      .addStringOption(reasonOption(false)),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ModerateMembers);
      if (!i) return;
      const r = service().revokeWarn(i.guildId, i.options.getInteger('cas', true), i.user.id, i.options.getString('raison'));
      if (!r.ok) return replyEphemeral(i, r.message);
      await replyEphemeral(i, `✅ Avertissement #${r.case.caseNumber} de <@${r.case.targetId}> révoqué.`);
    },
  };

  const modlogs: SlashCommand = {
    data: base('modlogs', 'Configure le salon des logs de modération', PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s
          .setName('definir')
          .setDescription('Choisit le salon des logs')
          .addChannelOption((o) =>
            o
              .setName('salon')
              .setDescription('Salon textuel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((s) => s.setName('desactiver').setDescription('Désactive les logs de modération'))
      .addSubcommand((s) => s.setName('voir').setDescription('Affiche le salon actuel')),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ManageGuild);
      if (!i) return;
      const sub = i.options.getSubcommand();
      if (sub === 'voir') {
        const id = service().getLogChannel(i.guildId);
        return replyEphemeral(i, id ? `Les logs sont envoyés dans <#${id}>.` : 'Aucun salon de logs configuré.');
      }
      if (sub === 'desactiver') {
        service().setLogChannel(i.guildId, null);
        return replyEphemeral(i, '✅ Logs de modération désactivés. Les sanctions restent enregistrées (`/sanctions`).');
      }
      const channel = i.options.getChannel('salon', true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
      const me = await botMember(i.guild);
      const missing = channel
        .permissionsFor(me)
        .missing([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
      if (missing.length) return replyEphemeral(i, `Il me manque des permissions dans ${channel} : ${missing.join(', ')}.`);
      service().setLogChannel(i.guildId, channel.id);
      await replyEphemeral(i, `✅ Les logs de modération seront envoyés dans ${channel}.`);
    },
  };

  return [warn, timeout, untimeout, kick, ban, unban, purge, sanctions, delwarn, modlogs];
}
