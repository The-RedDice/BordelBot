import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import type { ModerationCase } from '../ModerationService.js';
import { applyThreshold } from './autoSanction.js';
import { notify, postModLog, type Deps } from './helpers.js';
import { auditReason, sanctionDm } from './render.js';

export interface AutoWarnResult {
  readonly case: ModerationCase;
  /** Un palier de sanction a été atteint (et sa sanction tentée). */
  readonly thresholdReached: boolean;
}

/**
 * Avertissement émis par le bot lui-même (automod) : même effet qu'un `/warn`
 * (MP, salon de logs, paliers de sanctions), le bot apparaissant comme modérateur.
 */
export async function autoWarn(
  deps: Deps,
  guild: Guild,
  me: GuildMember,
  target: GuildMember,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<AutoWarnResult> {
  const service = deps.getService();
  const c = service.createCase({
    guildId: guild.id,
    action: 'warn',
    targetId: target.id,
    moderatorId: me.id,
    reason,
    metadata: { ...metadata, auto: true },
  });
  await notify(target.user, sanctionDm('warn', guild.name, c.reason));
  await postModLog(deps, guild, c);

  const total = service.countActiveWarns(guild.id, target.id);
  const threshold = service.thresholdFor(guild.id, total);
  if (threshold) {
    const line = await applyThreshold(deps, guild, me, target, threshold, total);
    deps.logger().info(`Automod, palier atteint pour ${target.id} sur ${guild.id} : ${line}`);
  }
  return { case: c, thresholdReached: threshold !== null };
}

/** Raison pour laquelle le bot ne peut pas exclure ce membre, ou null s'il le peut. */
export function cannotTimeout(guild: Guild, me: GuildMember, target: GuildMember): string | null {
  if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) return 'permission « Exclure temporairement » manquante';
  if (target.id === guild.ownerId) return 'propriétaire du serveur';
  if (target.permissions.has(PermissionFlagsBits.Administrator)) return 'administrateur';
  if (me.roles.highest.position <= target.roles.highest.position) return 'rôle au-dessus du mien';
  return null;
}

/** Exclusion immédiate par l'automod, enregistrée comme un cas. Ne lève jamais. */
export async function autoTimeout(
  deps: Deps,
  guild: Guild,
  me: GuildMember,
  target: GuildMember,
  durationMs: number,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<ModerationCase | null> {
  const why = cannotTimeout(guild, me, target);
  if (why) {
    deps.logger().warn(`Automod : exclusion impossible de ${target.id} sur ${guild.id} (${why})`);
    return null;
  }
  // Déjà exclu plus longtemps (par un palier, par exemple) : on ne raccourcit pas.
  const current = target.communicationDisabledUntilTimestamp ?? 0;
  if (current >= Date.now() + durationMs) return null;
  try {
    await target.timeout(durationMs, auditReason(me.user.tag, reason));
  } catch (err) {
    deps.logger().warn(`Automod : Discord a refusé l'exclusion de ${target.id} sur ${guild.id}`, err);
    return null;
  }
  const c = deps.getService().createCase({
    guildId: guild.id,
    action: 'timeout',
    targetId: target.id,
    moderatorId: me.id,
    reason,
    durationMs,
    metadata: { ...metadata, auto: true },
  });
  await notify(target.user, sanctionDm('timeout', guild.name, reason, durationMs));
  await postModLog(deps, guild, c);
  return c;
}
