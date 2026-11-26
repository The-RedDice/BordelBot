import { EmbedBuilder } from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import { formatAmount } from '../EconomyService.js';
import { ACHIEVEMENTS } from '../progress/achievements.js';
import type { GetServices } from '../services.js';
import { ECONOMY_COLOR, signedAmount } from './format.js';
import { guildCommand, guildOnly, rejectBot } from './helpers.js';

const percent = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)} %` : '—');
const int = (n: number) => new Intl.NumberFormat('fr-FR').format(n);

export function createProfileCommands(getServices: GetServices): SlashCommand[] {
  const profil: SlashCommand = {
    data: guildCommand('profil', 'Fortune, parties, jeux d’argent et succès d’un membre').addUserOption((o) =>
      o.setName('membre').setDescription('Membre à consulter'),
    ),
    execute: guildOnly(async (i, { eco, progress, market }) => {
      const user = i.options.getUser('membre') ?? i.user;
      if (await rejectBot(i, user)) return;
      const g = i.guildId;
      const { currencyName: cur } = eco.getSettings(g);
      const s = progress.stats(g, user.id);
      const balance = eco.getBalance(g, user.id);
      const portfolio = market.portfolio(g, user.id);
      const rank = eco.getRank(g, user.id);
      const played = s.games_played ?? 0;
      const won = s.games_won ?? 0;
      const unlocked = progress.progress(g, user.id).filter((p) => p.unlockedAt !== null);

      const embed = new EmbedBuilder()
        .setColor(ECONOMY_COLOR)
        .setAuthor({ name: `Profil de ${user.displayName}`, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL({ size: 128 }))
        .addFields(
          {
            name: '💰 Fortune',
            value: [
              `Solde : **${formatAmount(balance, cur)}**`,
              `Bourse : ${formatAmount(portfolio.value, cur)}`,
              `Total : **${formatAmount(balance + portfolio.value, cur)}**`,
              rank ? `🏅 ${rank}ᵉ du classement` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            inline: true,
          },
          {
            name: '🎮 Parties',
            value: `Jouées : **${int(played)}**\nGagnées : **${int(won)}**\nVictoires : ${percent(won, played)}`,
            inline: true,
          },
          {
            name: '📅 Daily',
            value: `Série : **${eco.currentStreak(g, user.id)}** j\nRecord : ${s.daily_best_streak ?? 0} j`,
            inline: true,
          },
          {
            name: '🎰 Jeux d’argent',
            value: [
              `Misé : ${formatAmount(s.wagered_total ?? 0, cur)}`,
              `Plus gros gain : ${formatAmount(s.biggest_win ?? 0, cur)}`,
              `Duels gagnés : ${int(s.duels_won ?? 0)}`,
            ].join('\n'),
            inline: true,
          },
          {
            name: '📈 Bourse',
            value: [
              `Ordres : ${int(s.market_trades ?? 0)}`,
              `Plus-values réalisées : ${signedAmount(s.market_profit_total ?? 0, cur)}`,
              portfolio.positions.length ? `Latent : ${signedAmount(portfolio.value - portfolio.costBasis, cur)}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            inline: true,
          },
          {
            name: `🏅 Succès (${unlocked.length}/${ACHIEVEMENTS.length})`,
            value: unlocked.length ? unlocked.map((p) => p.achievement.emoji).join(' ') : '*Aucun pour l’instant*',
            inline: true,
          },
        );
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }, getServices),
  };

  const succes: SlashCommand = {
    data: guildCommand('succes', 'Les succès débloqués et ceux qui restent à obtenir').addUserOption((o) =>
      o.setName('membre').setDescription('Membre à consulter'),
    ),
    execute: guildOnly(async (i, { eco, progress }) => {
      const user = i.options.getUser('membre') ?? i.user;
      if (await rejectBot(i, user)) return;
      const { currencyName } = eco.getSettings(i.guildId);
      const list = progress.progress(i.guildId, user.id);
      const lines = list.map(({ achievement: a, unlockedAt, current }) => {
        const reward = a.reward > 0 ? ` · ${formatAmount(a.reward, currencyName)}` : '';
        if (unlockedAt !== null) return `✅ ${a.emoji} **${a.name}** — ${a.description}${reward}`;
        const shown = Math.max(0, Math.min(current, a.threshold));
        return `🔒 ${a.emoji} ${a.name} — ${a.description} *(${int(shown)}/${int(a.threshold)})*${reward}`;
      });
      const done = list.filter((p) => p.unlockedAt !== null).length;
      const embed = new EmbedBuilder()
        .setColor(ECONOMY_COLOR)
        .setAuthor({ name: `Succès de ${user.displayName}`, iconURL: user.displayAvatarURL() })
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${done}/${list.length} débloqué(s) · la récompense est versée au déblocage` });
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }, getServices),
  };

  return [profil, succes];
}
