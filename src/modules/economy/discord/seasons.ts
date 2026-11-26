import { DiscordAPIError, RESTJSONErrorCodes, type Client, type Guild } from 'discord.js';
import type { Subcommand } from '../../../core/commands/types.js';
import { leaderboardEmbed, MEDALS } from '../../../core/leaderboard.js';
import type { Logger } from '../../../core/logger.js';
import { relativeTime } from '../../../core/replies.js';
import { monthId, monthLabel, monthRange, PARIS, previousMonthId } from '../../../core/time.js';
import { formatAmount } from '../EconomyService.js';
import type { SeasonClose } from '../seasons/SeasonService.js';
import type { GetServices } from '../services.js';
import { ECONOMY_COLOR } from './format.js';
import { guildOnly, subcommand } from './helpers.js';

const TOP_SIZE = 10;

/** `/top saison [classement]` : classements du mois en cours, et le podium de la saison passée. */
export function createSeasonTopCommand(getServices: GetServices): Subcommand {
  return {
    parent: 'top',
    data: subcommand('saison', 'Classement du mois (remis à zéro chaque mois, podium récompensé)').addStringOption((o) =>
      o
        .setName('classement')
        .setDescription('Gains du mois (par défaut) ou victoires du mois')
        .addChoices({ name: 'Gains du mois', value: 'gains' }, { name: 'Victoires du mois', value: 'victoires' }),
    ),
    execute: guildOnly(async (i, { seasons, eco }) => {
      const { currencyName: cur } = eco.getSettings(i.guildId);
      const season = seasons.currentSeason();
      const wins = i.options.getString('classement') === 'victoires';
      const rows = wins
        ? seasons.winsBoard(i.guildId, season, TOP_SIZE).map((r) => ({ userId: r.userId, value: `${r.value} victoire${r.value > 1 ? 's' : ''}` }))
        : seasons.earningsBoard(i.guildId, season, TOP_SIZE).map((r) => ({ userId: r.userId, value: `+${formatAmount(r.value, cur)}` }));
      const own = seasons.earningsOf(i.guildId, season, i.user.id);
      const embed = leaderboardEmbed({
        title: `${wins ? '🏆 Victoires' : '📈 Gains'} · saison ${monthLabel(season)}`,
        color: ECONOMY_COLOR,
        rows,
        empty: 'Personne n’est encore classé ce mois-ci.',
        viewerRank: wins ? null : own.rank,
        viewerValue: `+${formatAmount(own.value, cur)}`,
        footer: wins ? 'Le podium officiel classe les gains du mois' : 'Hors virements, ajustements et achats',
      });
      embed.setDescription(`${embed.data.description ?? ''}\n\n⏳ Fin de la saison ${relativeTime(seasons.seasonEnd(season))}`);
      const last = seasons.lastSeason(i.guildId);
      if (last) {
        const podium = seasons.results(i.guildId, last);
        embed.addFields({
          name: `Podium de ${monthLabel(last)}`,
          value: podium.map((p) => `${MEDALS[p.rank - 1]} <@${p.userId}> — +${formatAmount(p.score, cur)}`).join('\n') || '—',
        });
      }
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }, getServices),
  };
}

/** Prochaine clôture : début du mois suivant (heure de Paris), plus une minute de marge. */
export function nextSeasonClose(at: number): number {
  return monthRange(monthId(at, PARIS), PARIS).end + 60_000;
}

/**
 * Clôture mensuelle, pour chaque serveur qui a une économie : podium archivé et
 * récompensé, rôle de champion transmis, annonce. Rejouable sans double bonus.
 */
export async function closeSeasons(client: Client<true>, getServices: GetServices, logger: Logger, now = Date.now()): Promise<void> {
  const { seasons } = getServices();
  const season = previousMonthId(monthId(now, PARIS));
  for (const guildId of seasons.guilds()) {
    try {
      const r = seasons.close(guildId, season);
      if (!r.ok) throw new Error(r.error.message);
      const guild = client.guilds.cache.get(guildId);
      if (r.value && guild) await celebrate(guild, r.value, getServices, logger);
    } catch (err) {
      logger.error(`Échec de la clôture de la saison ${season} sur ${guildId}`, err);
    }
  }
}

async function celebrate(guild: Guild, result: SeasonClose, getServices: GetServices, logger: Logger): Promise<void> {
  const { events, eco } = getServices();
  const settings = events.get(guild.id);
  const champion = result.podium[0]?.userId ?? null;

  // Rôle de champion : retiré à l'ancien, donné au nouveau.
  const role = settings.championRoleId ? guild.roles.cache.get(settings.championRoleId) : undefined;
  if (role?.editable) {
    if (settings.championUserId && settings.championUserId !== champion) {
      const previous = await guild.members.fetch(settings.championUserId).catch(() => null);
      await previous?.roles.remove(role, 'Fin du titre de champion du mois').catch(() => undefined);
    }
    if (champion) {
      try {
        const member = await guild.members.fetch(champion);
        await member.roles.add(role, `Champion de la saison ${monthLabel(result.season)}`);
      } catch (err) {
        if (!(err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMember)) {
          logger.warn(`Rôle de champion impossible à donner sur ${guild.id}`, err);
        }
      }
    }
  } else if (settings.championRoleId) {
    logger.warn(`Rôle de champion introuvable ou au-dessus du mien sur ${guild.id}`);
  }
  if (settings.championUserId !== champion) events.set(guild.id, { ...settings, championUserId: champion });

  const channel = settings.channelId ? guild.channels.cache.get(settings.channelId) : undefined;
  if (!channel?.isSendable() || result.podium.length === 0) return;
  const { currencyName: cur } = eco.getSettings(guild.id);
  const lines = [
    `🏁 **Fin de la saison ${monthLabel(result.season)} !** Podium des gains du mois :`,
    ...result.podium.map(
      (p) =>
        `${MEDALS[p.rank - 1]} <@${p.userId}> — +${formatAmount(p.score, cur)}` + (p.reward > 0 ? ` · 🎁 ${formatAmount(p.reward, cur)}` : ''),
    ),
    role && champion ? `👑 <@${champion}> porte le rôle **${role.name}** jusqu’à la fin du mois.` : null,
    'Les classements de saison repartent de zéro : `/top saison`.',
  ].filter((l): l is string => l !== null);
  await channel
    .send({ content: lines.join('\n'), allowedMentions: { users: result.podium.map((p) => p.userId) } })
    .catch((err: unknown) => logger.warn(`Annonce de la saison impossible sur ${guild.id}`, err));
}
