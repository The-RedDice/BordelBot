import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Message,
} from 'discord.js';
import type { SlashCommand, Subcommand } from '../../../core/commands/types.js';
import { relativeTime, replyEphemeral } from '../../../core/replies.js';
import { formatDuration, MAX_TEMPBAN_MS, MAX_TIMEOUT_MS, parseDuration } from '../duration.js';
import { HIERARCHY_MESSAGES } from '../policy.js';
import {
  base,
  botMember,
  BULK_DELETE_MAX_AGE_MS,
  checkBotPermission,
  checkTarget,
  confirm,
  dmLine,
  guard,
  sub,
  isApiError,
  notify,
  postModLog,
  reasonOption,
  requireMember,
  type Deps,
} from './helpers.js';
import { applyThreshold } from './autoSanction.js';
import { createChannelCommands } from './channels.js';
import { auditReason, caseLine, sanctionDm } from './render.js';

// ---------- Commandes ----------

export function createModerationCommands(deps: Deps): { commands: SlashCommand[]; subcommands: Subcommand[] } {
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
      const me = await botMember(i.guild);
      if (!(await checkTarget(i, me, target, false))) return;

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

      const threshold = service().thresholdFor(i.guildId, total);
      if (threshold) {
        const line = await applyThreshold(deps, i.guild, me, target, threshold, total);
        await i.followUp({ content: line, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
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
      .addStringOption((o) =>
        o.setName('duree').setDescription('Ban temporaire : levé automatiquement après 1h, 3j, 2sem…').setMaxLength(32),
      )
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
      const rawDuration = i.options.getString('duree');
      const durationMs = rawDuration === null ? null : parseDuration(rawDuration);
      if (rawDuration !== null && (durationMs === null || durationMs > MAX_TEMPBAN_MS)) {
        return replyEphemeral(i, 'Durée invalide. Exemples : `1h`, `3j`, `2sem` (10 ans max).');
      }
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
      const sent =
        member && !user.bot ? await notify(user, sanctionDm('ban', i.guild.name, reason, durationMs ?? undefined)) : false;
      await i.guild.bans.create(user.id, {
        reason: auditReason(i.user.tag, reason),
        deleteMessageSeconds: i.options.getInteger('messages') ?? 0,
      });
      const c = service().createCase({
        guildId: i.guildId,
        action: 'ban',
        targetId: user.id,
        moderatorId: i.user.id,
        reason,
        durationMs,
      });
      await confirm(i, c, [
        member ? dmLine(sent) : 'ℹ️ Utilisateur absent du serveur : banni préventivement.',
        c.expiresAt !== null ? `⏳ Levée automatique ${relativeTime(c.expiresAt)}.` : null,
      ]);
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
        if (isApiError(err, RESTJSONErrorCodes.UnknownBan)) {
          service().resolveBans(i.guildId, user.id);
          return replyEphemeral(i, 'Cet utilisateur n’est pas banni.');
        }
        throw err;
      }
      // Un ban temporaire levé à la main ne doit plus être traité par la tâche de fin de ban.
      service().resolveBans(i.guildId, user.id);
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

  const sanctions: Subcommand = {
    parent: 'sanctions',
    data: sub('voir', 'Historique des sanctions d’un utilisateur')
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
      const expiryDays = service().getWarnExpiryDays(i.guildId);
      const lines = cases.map((c) => caseLine(c, { expired: service().isWarnExpired(c) }));
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: `Sanctions de ${user.tag}`, iconURL: user.displayAvatarURL() })
        .setDescription(lines.length ? lines.join('\n\n').slice(0, 4096) : '*Aucune sanction.*')
        .setFooter({
          text:
            `${warns} avertissement(s) actif(s)` +
            (expiryDays > 0 ? ` (expirent après ${expiryDays} j)` : '') +
            ' · 10 derniers cas',
        });
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  };

  const delwarn: Subcommand = {
    parent: 'sanctions',
    data: sub('revoquer', 'Révoque un avertissement (il reste visible dans le journal)')
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

  return {
    commands: [warn, timeout, untimeout, kick, ban, unban, purge],
    subcommands: [sanctions, delwarn, ...createChannelCommands(deps)],
  };
}
