import { DiscordAPIError, RESTJSONErrorCodes, escapeMarkdown, type Client, type Guild, type GuildMember } from 'discord.js';
import { formatDuration } from '../../../core/duration.js';
import type { Logger } from '../../../core/logger.js';
import { relativeTime } from '../../../core/replies.js';
import type { JobHandler } from '../../../core/scheduler/JobScheduler.js';
import type { BotJobs } from '../../../core/jobs.js';
import { formatAmount, type ShopItem } from '../EconomyService.js';
import type { GetServices } from '../services.js';
import { roleExpiryKey, type RoleGrant } from '../shop/RoleShop.js';
import { errorText } from './format.js';

const isApiError = (err: unknown, ...codes: number[]) => err instanceof DiscordAPIError && codes.includes(Number(err.code));

/** « permanent » ou « 7 j ». */
export const roleDurationText = (item: Pick<ShopItem, 'roleDurationMs'>): string =>
  item.roleDurationMs === null ? 'permanent' : formatDuration(item.roleDurationMs);

export const grantLine = (g: RoleGrant): string =>
  `• <@&${g.roleId}> · ${g.expiresAt === null ? 'permanent' : `jusqu’à ${relativeTime(g.expiresAt)}`}`;

/**
 * Achat d'un article « rôle » : le rôle doit pouvoir être attribué avant de
 * débiter ; si Discord le refuse malgré tout, l'achat est annulé et remboursé.
 * Renvoie le message à afficher à l'acheteur.
 */
export async function buyRoleItem(guild: Guild, member: GuildMember, item: ShopItem, getServices: GetServices): Promise<string> {
  const { roleShop, eco, scheduler } = getServices();
  const role = item.roleId ? guild.roles.cache.get(item.roleId) : undefined;
  if (!role || !role.editable) return 'Ce rôle n’est plus disponible à l’achat (il a été supprimé ou placé au-dessus du mien). Préviens un admin.';

  const r = roleShop.buy(guild.id, member.id, item.key);
  if (!r.ok) return errorText(r.error);
  const p = r.value;
  try {
    if (!member.roles.cache.has(role.id)) await member.roles.add(role, `Achat en boutique : ${item.name}`);
  } catch {
    const undo = roleShop.undo(guild.id, member.id, p);
    return undo.ok
      ? 'Discord a refusé de t’attribuer ce rôle : tu as été remboursé·e.'
      : `Discord a refusé de t’attribuer ce rôle, et le remboursement a échoué (${undo.error.message}). Préviens un admin.`;
  }
  if (p.expiresAt !== null) {
    scheduler.schedule(
      'shop:roleExpiry',
      p.expiresAt,
      { guildId: guild.id, userId: member.id, roleId: role.id },
      { key: roleExpiryKey(guild.id, member.id, role.id), guildId: guild.id },
    );
  }
  const { currencyName } = eco.getSettings(guild.id);
  const until =
    p.expiresAt === null ? 'pour toujours' : p.previous?.expiresAt ? `prolongé jusqu’à ${relativeTime(p.expiresAt)}` : `jusqu’à ${relativeTime(p.expiresAt)}`;
  return (
    `🎭 Tu as acheté le rôle ${role} (${until}) pour ${formatAmount(p.price, currencyName)}.\n` +
    `Nouveau solde : ${formatAmount(p.balance, currencyName)}`
  );
}

/** Fin d'un rôle acheté : retiré au membre, puis oublié. Une prolongation entre-temps replanifie la tâche. */
export function roleExpiryHandler(getServices: GetServices): JobHandler<'shop:roleExpiry', BotJobs['shop:roleExpiry'], Client<true>> {
  return async ({ payload: { guildId, userId, roleId } }, client) => {
    const { roleShop } = getServices();
    const grant = roleShop.grant(guildId, userId, roleId);
    if (!grant || grant.expiresAt === null) return undefined;
    if (grant.expiresAt > Date.now()) return { rescheduleAt: grant.expiresAt };
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      try {
        const member = await guild.members.fetch(userId);
        await member.roles.remove(roleId, 'Fin du rôle acheté en boutique');
      } catch (err) {
        // Membre parti ou rôle supprimé : plus rien à retirer. Sinon (permissions…), le planificateur réessaiera.
        if (!isApiError(err, RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownRole)) throw err;
      }
    }
    roleShop.revoke(guildId, userId, roleId);
    return undefined;
  };
}

/**
 * Donne le rôle du plus riche au n° 1 de `/top fortune` encore présent sur le
 * serveur, et le retire à l'ancien détenteur. Appelé toutes les heures.
 */
export async function updateRichest(client: Client<true>, getServices: GetServices, logger: Logger): Promise<void> {
  const { eco, extras } = getServices();
  for (const g of extras.richestRoleGuilds()) {
    const guild = client.guilds.cache.get(g.guildId);
    if (!guild) continue;
    try {
      const role = g.richestRoleId ? guild.roles.cache.get(g.richestRoleId) : undefined;
      if (!role?.editable) {
        logger.warn(`Rôle du plus riche introuvable ou au-dessus du mien sur ${guild.id}`);
        continue;
      }
      let richest: GuildMember | null = null;
      let balance = 0;
      for (const entry of eco.leaderboard(guild.id, 10)) {
        const member = await guild.members.fetch(entry.userId).catch((err: unknown) => {
          if (isApiError(err, RESTJSONErrorCodes.UnknownMember)) return null;
          throw err;
        });
        if (member && !member.user.bot) {
          richest = member;
          balance = entry.balance;
          break;
        }
      }

      if (richest && !richest.roles.cache.has(role.id)) await richest.roles.add(role, 'Membre le plus riche');
      const previousId = g.richestUserId;
      if (previousId && previousId !== richest?.id) {
        const previous = await guild.members.fetch(previousId).catch(() => null);
        if (previous?.roles.cache.has(role.id)) await previous.roles.remove(role, 'N’est plus le membre le plus riche');
      }
      if ((richest?.id ?? null) === previousId) continue;

      extras.set(guild.id, { ...g, richestUserId: richest?.id ?? null });
      const channel = g.richestChannelId ? guild.channels.cache.get(g.richestChannelId) : undefined;
      if (richest && channel?.isSendable()) {
        const { currencyName } = eco.getSettings(guild.id);
        await channel
          .send({
            content: `👑 ${richest} devient le membre le plus riche du serveur avec **${formatAmount(balance, currencyName)}** et reçoit le rôle **${escapeMarkdown(role.name)}** !`,
            allowedMentions: { users: [richest.id] },
          })
          .catch((err: unknown) => logger.warn(`Annonce du plus riche impossible sur ${guild.id}`, err));
      }
    } catch (err) {
      logger.error(`Échec de la mise à jour du plus riche sur ${g.guildId}`, err);
    }
  }
}
