import { RESTJSONErrorCodes, DiscordAPIError, type Client, type Guild } from 'discord.js';
import type { EventBus } from '../../../core/EventBus.js';
import type { BotEvents } from '../../../core/events.js';
import type { Logger } from '../../../core/logger.js';
import { isDue, type BirthdayService, type BirthdaySettings } from '../BirthdayService.js';
import { localTime, type LocalTime } from '../dates.js';

export interface BirthdayDeps {
  readonly getService: () => BirthdayService;
  readonly bus: () => EventBus<BotEvents>;
  readonly logger: () => Logger;
}

/** « a », « a et b », « a, b et c ». */
export function joinFr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

export function announcement(userIds: readonly string[], bonus: number, currency: string): string {
  const lines = [`🎂 **Joyeux anniversaire** à ${joinFr(userIds.map((id) => `<@${id}>`))} ! 🎉`];
  if (bonus > 0) {
    const amount = `${bonus.toLocaleString('fr-FR')} ${currency}`;
    lines.push(`🎁 ${amount} offert${userIds.length > 1 ? ' à chacun·e' : ''} pour l’occasion.`);
  }
  return lines.join('\n');
}

const isUnknownMember = (err: unknown) => err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMember;

/**
 * Passage horaire, pour chaque serveur configuré :
 * 1. retire le rôle d'anniversaire donné un autre jour ;
 * 2. si l'heure de l'annonce est passée et que ce jour n'a pas été traité,
 *    fête les anniversaires du jour (rôle, bonus via `birthday:celebrated`, annonce).
 * Rejouable sans risque : chaque anniversaire n'est fêté qu'une fois par an.
 */
export async function runBirthdays(client: Client<true>, deps: BirthdayDeps, now = Date.now()): Promise<void> {
  const service = deps.getService();
  for (const g of service.configuredGuilds()) {
    const guild = client.guilds.cache.get(g.guildId);
    if (!guild) continue;
    try {
      const local = localTime(now, g.timezone);
      await removeExpiredRoles(guild, local, deps);
      if (isDue(g, g.lastRun, local)) {
        await celebrateToday(guild, g, local, deps);
        service.markRun(guild.id, local.date);
      }
    } catch (err) {
      deps.logger().error(`Anniversaires : échec du passage sur ${g.guildId}`, err);
    }
  }
}

async function celebrateToday(guild: Guild, settings: BirthdaySettings, local: LocalTime, deps: BirthdayDeps): Promise<void> {
  const service = deps.getService();
  const celebrated: string[] = [];
  const role = settings.roleId ? guild.roles.cache.get(settings.roleId) : undefined;
  if (settings.roleId && !role?.editable) {
    deps.logger().warn(`Anniversaires : rôle ${settings.roleId} introuvable ou au-dessus du mien sur ${guild.id}`);
  }

  for (const b of service.birthdaysOn(guild.id, local)) {
    const member = await guild.members.fetch(b.userId).catch((err: unknown) => {
      if (!isUnknownMember(err)) throw err;
      return null; // a quitté le serveur
    });
    if (!member || member.user.bot) continue;
    if (!service.celebrate(guild.id, b.userId, local.year, local.date)) continue;
    celebrated.push(b.userId);

    if (role?.editable) {
      try {
        await member.roles.add(role, 'Anniversaire');
        service.recordRole(guild.id, b.userId, local.year, role.id);
      } catch (err) {
        deps.logger().warn(`Anniversaires : impossible de donner le rôle à ${b.userId} sur ${guild.id}`, err);
      }
    }
    await deps.bus().emit('birthday:celebrated', {
      guildId: guild.id,
      userId: b.userId,
      year: local.year,
      bonus: settings.bonus,
    });
  }

  if (!celebrated.length || !settings.channelId) return;
  const channel = guild.channels.cache.get(settings.channelId);
  if (!channel?.isSendable()) {
    deps.logger().warn(`Anniversaires : salon d'annonce ${settings.channelId} inaccessible sur ${guild.id}`);
    return;
  }
  try {
    await channel.send({
      content: announcement(celebrated, settings.bonus, service.currencyName(guild.id)),
      allowedMentions: { users: celebrated },
    });
  } catch (err) {
    deps.logger().warn(`Anniversaires : annonce impossible dans ${settings.channelId} sur ${guild.id}`, err);
  }
}

/** Retire les rôles d'anniversaire des jours précédents. Un échec est signalé une fois, sans réessai. */
async function removeExpiredRoles(guild: Guild, local: LocalTime, deps: BirthdayDeps): Promise<void> {
  const service = deps.getService();
  for (const p of service.pendingRoleRemovals(guild.id, local)) {
    try {
      const member = await guild.members.fetch(p.userId);
      await member.roles.remove(p.roleId, 'Fin de l’anniversaire');
    } catch (err) {
      if (!isUnknownMember(err)) {
        deps.logger().warn(`Anniversaires : impossible de retirer le rôle de ${p.userId} sur ${guild.id}`, err);
      }
    }
    service.markRoleRemoved(guild.id, p.userId, p.year);
  }
}
