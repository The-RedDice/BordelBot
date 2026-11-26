import type { Subcommand } from '../../../core/commands/types.js';
import { leaderboardEmbed } from '../../../core/leaderboard.js';
import { formatAmount } from '../EconomyService.js';
import type { StatKey } from '../progress/achievements.js';
import type { GetServices } from '../services.js';
import { ECONOMY_COLOR } from './format.js';
import { guildOnly, subcommand } from './helpers.js';

const TOP_SIZE = 10;
const int = (n: number) => new Intl.NumberFormat('fr-FR').format(n);

interface StatBoard {
  readonly name: string;
  readonly description: string;
  readonly title: string;
  readonly stat: StatKey;
  readonly empty: string;
  format(value: number, currency: string): string;
}

const STAT_BOARDS: readonly StatBoard[] = [
  {
    name: 'victoires',
    description: 'Les membres qui ont gagné le plus de parties',
    title: '🏆 Classement des victoires',
    stat: 'games_won',
    empty: 'Aucune partie gagnée pour l’instant.',
    format: (v) => `${int(v)} victoire${v > 1 ? 's' : ''}`,
  },
  {
    name: 'daily',
    description: 'Les plus longues séries de récompenses quotidiennes',
    title: '📅 Records de série de daily',
    stat: 'daily_best_streak',
    empty: 'Personne n’a encore de série.',
    format: (v) => `${int(v)} jour${v > 1 ? 's' : ''}`,
  },
  {
    name: 'bourse',
    description: 'Les meilleurs traders (plus-values réalisées)',
    title: '📈 Classement des traders',
    stat: 'market_profit_total',
    empty: 'Aucune plus-value réalisée pour l’instant.',
    format: (v, cur) => `+${formatAmount(v, cur)}`,
  },
];

/** Contributions du module économie à `/top`. */
export function createEconomyTopCommands(getServices: GetServices): Subcommand[] {
  const fortune: Subcommand = {
    parent: 'top',
    data: subcommand('fortune', 'Les membres les plus riches du serveur'),
    execute: guildOnly(async (i, { eco }) => {
      const { currencyName: cur } = eco.getSettings(i.guildId);
      const embed = leaderboardEmbed({
        title: '💰 Les plus riches',
        color: ECONOMY_COLOR,
        rows: eco.leaderboard(i.guildId, TOP_SIZE).map((r) => ({ userId: r.userId, value: formatAmount(r.balance, cur) })),
        empty: 'Personne n’a encore d’argent sur ce serveur.',
        viewerRank: eco.getRank(i.guildId, i.user.id),
        viewerValue: formatAmount(eco.getBalance(i.guildId, i.user.id), cur),
        footer: 'Solde hors bourse',
      });
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }, getServices),
  };

  const boards = STAT_BOARDS.map(
    (b): Subcommand => ({
      parent: 'top',
      data: subcommand(b.name, b.description),
      execute: guildOnly(async (i, { eco, progress }) => {
        const { currencyName: cur } = eco.getSettings(i.guildId);
        const own = progress.stats(i.guildId, i.user.id)[b.stat] ?? 0;
        const embed = leaderboardEmbed({
          title: b.title,
          color: ECONOMY_COLOR,
          rows: progress.top(i.guildId, b.stat, TOP_SIZE).map((r) => ({ userId: r.userId, value: b.format(r.value, cur) })),
          empty: b.empty,
          viewerRank: progress.rank(i.guildId, i.user.id, b.stat),
          viewerValue: b.format(own, cur),
        });
        await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      }, getServices),
    }),
  );

  return [fortune, ...boards];
}
