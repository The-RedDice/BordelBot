import type { Guild, GuildMember, SendableChannels } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import type { LevelService, XpChange } from '../LevelService.js';
import { rewardRoles } from '../rewards.js';

export interface LevelDeps {
  readonly getService: () => LevelService;
  readonly logger: () => Logger;
}

export interface ApplyOptions {
  /** Membre déjà résolu (message, état vocal) ; sinon il est récupéré à la demande. */
  readonly member?: GuildMember | null;
  /** Salon où a eu lieu l'activité : sert aux annonces en mode « here ». */
  readonly channel?: SendableChannels | null;
  /** false pour un ajustement admin : rôles synchronisés, sans annonce. */
  readonly announce?: boolean;
}

/**
 * Effets Discord d'un changement de niveau : synchronise les rôles de récompense
 * (ajout à la montée, retrait si un admin fait redescendre le membre) puis annonce
 * la montée de niveau. Les échecs (permission, rôle trop haut) sont journalisés
 * sans interrompre le reste.
 */
export async function applyLevelChange(deps: LevelDeps, guild: Guild, change: XpChange, options: ApplyOptions = {}): Promise<void> {
  if (change.levelAfter === change.levelBefore) return;
  const service = deps.getService();
  const log = deps.logger();
  const settings = service.getSettings(guild.id);
  const rewards = service.getRoleRewards(guild.id);

  const gained: string[] = [];
  if (rewards.length) {
    const member = options.member ?? (await guild.members.fetch(change.userId).catch(() => null));
    if (member) {
      const { keep, drop } = rewardRoles(rewards, change.levelAfter, settings.stackRoles);
      const editable = (id: string) => guild.roles.cache.get(id)?.editable ?? false;
      const add = keep.filter((id) => !member.roles.cache.has(id) && editable(id));
      const remove = drop.filter((id) => member.roles.cache.has(id) && editable(id));
      try {
        if (add.length) await member.roles.add(add, `Niveau ${change.levelAfter}`);
        if (remove.length) await member.roles.remove(remove, `Niveau ${change.levelAfter}`);
        gained.push(...add);
      } catch (err) {
        log.warn(`Impossible de mettre à jour les rôles de niveau de ${change.userId} sur ${guild.id}`, err);
      }
      const blocked = [...keep, ...drop].filter((id) => guild.roles.cache.has(id) && !editable(id));
      if (blocked.length) log.debug(`Rôles de niveau hors de portée du bot sur ${guild.id} : ${blocked.join(', ')}`);
    }
  }

  if (options.announce === false || change.levelAfter < change.levelBefore || settings.announce === 'off') return;
  const channel =
    settings.announce === 'channel' && settings.announceChannelId
      ? await guild.channels.fetch(settings.announceChannelId).catch(() => null)
      : (options.channel ?? null);
  if (!channel?.isSendable()) return;
  const lines = [
    `🎉 <@${change.userId}> passe au **niveau ${change.levelAfter}** !`,
    ...gained.map((id) => `🏷️ Nouveau rôle : <@&${id}>`),
  ];
  try {
    await channel.send({ content: lines.join('\n'), allowedMentions: { users: [change.userId] } });
  } catch (err) {
    log.debug(`Annonce de niveau impossible dans ${channel.id}`, err);
  }
}
