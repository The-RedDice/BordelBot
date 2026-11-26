import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { describeThreshold, type WarnThreshold } from '../thresholds.js';
import { notify, postModLog, type Deps } from './helpers.js';
import { auditReason, sanctionDm } from './render.js';

const REQUIRED_PERMISSION: Record<WarnThreshold['action'], bigint> = {
  timeout: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
};

/**
 * Applique le palier atteint par un membre après un avertissement. Le bot agit en
 * son nom propre (il apparaît comme modérateur du cas) ; tout échec est rapporté
 * dans la ligne renvoyée, jamais levé : l'avertissement, lui, est déjà enregistré.
 */
export async function applyThreshold(
  deps: Deps,
  guild: Guild,
  me: GuildMember,
  target: GuildMember,
  threshold: WarnThreshold,
  warnCount: number,
): Promise<string> {
  const label = describeThreshold(threshold);
  const impossible = (why: string) => `⚠️ Palier atteint (${label}) mais sanction automatique impossible : ${why}`;

  if (!me.permissions.has(REQUIRED_PERMISSION[threshold.action])) return impossible('il me manque la permission requise.');
  if (target.id === guild.ownerId) return impossible('c’est le propriétaire du serveur.');
  if (me.roles.highest.position <= target.roles.highest.position) return impossible('son rôle est au-dessus du mien.');
  if (threshold.action === 'timeout' && target.permissions.has(PermissionFlagsBits.Administrator)) {
    return impossible('Discord ne permet pas d’exclure un administrateur.');
  }

  const reason = `Sanction automatique : ${warnCount} avertissements actifs`;
  const audit = auditReason(me.user.tag, reason);
  const durationMs = threshold.durationMs;
  try {
    let sent = false;
    if (threshold.action === 'timeout') {
      await target.timeout(durationMs, audit);
      sent = await notify(target.user, sanctionDm('timeout', guild.name, reason, durationMs ?? undefined));
    } else {
      // Le MP part avant : ensuite, le bot ne partage plus de serveur avec le membre.
      sent = await notify(target.user, sanctionDm(threshold.action, guild.name, reason, durationMs ?? undefined));
      if (threshold.action === 'kick') await target.kick(audit);
      else await guild.bans.create(target.id, { reason: audit });
    }
    const c = deps.getService().createCase({
      guildId: guild.id,
      action: threshold.action,
      targetId: target.id,
      moderatorId: me.id,
      reason,
      durationMs: threshold.action === 'kick' ? null : durationMs,
      metadata: { auto: true, warnCount },
    });
    await postModLog(deps, guild, c);
    return `⚙️ Palier atteint : ${label} appliqué automatiquement — **cas #${c.caseNumber}**${sent ? '' : ' (MP impossible)'}.`;
  } catch (err) {
    deps.logger().warn(`Sanction automatique impossible pour ${target.id} sur ${guild.id}`, err);
    return impossible('Discord a refusé l’action.');
  }
}
