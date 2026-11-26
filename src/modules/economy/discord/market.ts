import { AttachmentBuilder, EmbedBuilder, InteractionContextType, SlashCommandBuilder, type SlashCommandStringOption } from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import { relativeTime, replyEphemeral } from '../../../core/replies.js';
import { formatAmount } from '../EconomyService.js';
import { MARKET_ASSETS } from '../market/assets.js';
import { formatPrice, renderPriceChart } from '../market/chart.js';
import { DIVIDEND_HOUR, dividendFor, MARKET_FEE_RATE, MAX_TRADE_QUANTITY } from '../market/MarketService.js';

/** 0,002 → « 0,2 % ». */
export const rateText = (rate: number): string => `${(rate * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
import type { GetServices } from '../services.js';
import { achievementLines, errorText, percentChange, signedAmount } from './format.js';
import { guildOnly, rejectBot } from './helpers.js';

const MARKET_COLOR = 0x00b894;
const HOUR = 3_600_000;
const PERIODS: Record<string, { label: string; ms: number }> = {
  '1h': { label: '1 heure', ms: HOUR },
  '6h': { label: '6 heures', ms: 6 * HOUR },
  '24h': { label: '24 heures', ms: 24 * HOUR },
  '7j': { label: '7 jours', ms: 7 * 24 * HOUR },
  '30j': { label: '30 jours', ms: 30 * 24 * HOUR },
};

const assetOption = (o: SlashCommandStringOption) =>
  o
    .setName('actif')
    .setDescription('Actif coté')
    .setRequired(true)
    .addChoices(...MARKET_ASSETS.map((a) => ({ name: `${a.emoji} ${a.name} (${a.symbol})`, value: a.symbol })));

const feeText = `${Math.round(MARKET_FEE_RATE * 100)} %`;

export function createMarketCommand(getServices: GetServices): SlashCommand {
  const data = new SlashCommandBuilder()
    .setName('bourse')
    .setDescription('Bourse fictive : cours, graphiques, achat et vente')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('cours').setDescription('Cours de tous les actifs et dernières actualités'))
    .addSubcommand((s) =>
      s
        .setName('graphique')
        .setDescription('Graphique du cours d’un actif')
        .addStringOption(assetOption)
        .addStringOption((o) =>
          o
            .setName('periode')
            .setDescription('Période affichée (24 h par défaut)')
            .addChoices(...Object.entries(PERIODS).map(([value, p]) => ({ name: p.label, value }))),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('acheter')
        .setDescription(`Achète des titres au cours actuel (frais : ${feeText})`)
        .addStringOption(assetOption)
        .addIntegerOption((o) =>
          o.setName('quantite').setDescription('Nombre de titres').setRequired(true).setMinValue(1).setMaxValue(MAX_TRADE_QUANTITY),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('vendre')
        .setDescription(`Vend des titres au cours actuel (frais : ${feeText})`)
        .addStringOption(assetOption)
        .addIntegerOption((o) =>
          o
            .setName('quantite')
            .setDescription('Nombre de titres (tous par défaut)')
            .setMinValue(1)
            .setMaxValue(MAX_TRADE_QUANTITY),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('portefeuille')
        .setDescription('Titres détenus, valeur et plus-values')
        .addUserOption((o) => o.setName('membre').setDescription('Membre à consulter')),
    );

  const execute = guildOnly(async (i, { eco, market }) => {
    const sub = i.options.getSubcommand();
    const { currencyName: cur } = eco.getSettings(i.guildId);

    if (sub === 'cours') {
      const lines = market.quotes().map(
        (q) =>
          `${q.asset.emoji} **${q.asset.symbol}** ${q.asset.name} — **${formatPrice(q.price)}**\n` +
          `  1 h : ${percentChange(q.change1h)} · 24 h : ${percentChange(q.change24h)}` +
          (q.asset.dividendRate ? ` · 💵 dividende ${rateText(q.asset.dividendRate)}/jour` : ''),
      );
      const news = market.news(4);
      const embed = new EmbedBuilder()
        .setColor(MARKET_COLOR)
        .setTitle('📊 Bourse du Bordel')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Cours mis à jour toutes les 5 minutes · prix en ${cur} · frais ${feeText}` });
      if (news.length) {
        embed.addFields({
          name: '📰 Dernières actualités',
          value: news
            .map((n) => `${relativeTime(n.at)} ${n.asset.emoji} ${n.headline} (${percentChange(n.change)})`)
            .join('\n')
            .slice(0, 1024),
        });
      }
      await i.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'graphique') {
      const asset = market.getAsset(i.options.getString('actif', true));
      if (!asset) return replyEphemeral(i, 'Actif inconnu.');
      const period = PERIODS[i.options.getString('periode') ?? '24h'] ?? (PERIODS['24h'] as { label: string; ms: number });
      const points = market.history(asset, period.ms);
      if (points.length < 2) return replyEphemeral(i, 'Pas encore assez d’historique pour tracer un graphique.');
      await i.deferReply();
      const prices = points.map((p) => p.price);
      const first = points[0]?.price ?? 0;
      const last = points[points.length - 1]?.price ?? 0;
      const file = new AttachmentBuilder(renderPriceChart(points), { name: `${asset.symbol.toLowerCase()}.png` });
      const embed = new EmbedBuilder()
        .setColor(last >= first ? 0x3ba55d : 0xed4245)
        .setTitle(`${asset.emoji} ${asset.name} (${asset.symbol}) — ${period.label}`)
        .addFields(
          { name: 'Cours', value: `**${formatPrice(last)}** ${cur}`, inline: true },
          { name: 'Variation', value: percentChange(first > 0 ? last / first - 1 : null), inline: true },
          { name: 'Plus haut / bas', value: `${formatPrice(Math.max(...prices))} / ${formatPrice(Math.min(...prices))}`, inline: true },
        )
        .setImage(`attachment://${file.name}`);
      await i.editReply({ embeds: [embed], files: [file] });
      return;
    }

    if (sub === 'acheter' || sub === 'vendre') {
      const symbol = i.options.getString('actif', true);
      const quantity = i.options.getInteger('quantite');
      const r =
        sub === 'acheter'
          ? market.buy(i.guildId, i.user.id, symbol, quantity ?? 0)
          : market.sell(i.guildId, i.user.id, symbol, quantity);
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const t = r.value;
      const verb = sub === 'acheter' ? 'achète' : 'vend';
      const lines = [
        `${sub === 'acheter' ? '📈' : '📉'} ${i.user} ${verb} **${t.quantity} ${t.asset.symbol}** à ${formatPrice(t.price)} ` +
          `(${sub === 'acheter' ? 'débité' : 'crédité'} : **${formatAmount(t.total, cur)}**, dont ${formatAmount(t.fee, cur)} de frais)`,
        t.profit !== null ? `Plus-value réalisée : **${signedAmount(t.profit, cur)}**` : null,
        `Il te reste ${t.remaining} ${t.asset.symbol} · solde : ${formatAmount(t.balance, cur)}`,
        ...achievementLines(t.unlocked, cur),
      ];
      await i.reply({ content: lines.filter(Boolean).join('\n'), allowedMentions: { parse: [] } });
      return;
    }

    // portefeuille
    const user = i.options.getUser('membre') ?? i.user;
    if (await rejectBot(i, user)) return;
    const p = market.portfolio(i.guildId, user.id);
    const embed = new EmbedBuilder()
      .setColor(MARKET_COLOR)
      .setAuthor({ name: `Portefeuille de ${user.displayName}`, iconURL: user.displayAvatarURL() });
    if (p.positions.length === 0) {
      embed.setDescription('*Aucun titre. `/bourse acheter` pour investir.*');
    } else {
      embed.setDescription(
        p.positions
          .map((pos) => {
            const pct = pos.costBasis > 0 ? percentChange(pos.value / pos.costBasis - 1) : '—';
            return (
              `${pos.asset.emoji} **${pos.quantity} ${pos.asset.symbol}** × ${formatPrice(pos.price)} = ` +
              `**${formatAmount(pos.value, cur)}**\n  ${signedAmount(pos.profit, cur)} (${pct})`
            );
          })
          .join('\n'),
      );
      embed.addFields(
        { name: 'Valeur totale', value: formatAmount(p.value, cur), inline: true },
        { name: 'Investi', value: formatAmount(p.costBasis, cur), inline: true },
        { name: 'Plus-value latente', value: signedAmount(p.value - p.costBasis, cur), inline: true },
      );
      const daily = p.positions.reduce(
        (sum, pos) => sum + (pos.asset.dividendRate ? dividendFor(pos.quantity, pos.price, pos.asset.dividendRate) : 0),
        0,
      );
      if (daily > 0) {
        embed.addFields({ name: '💵 Dividendes', value: `≈ ${formatAmount(daily, cur)} par jour, versés à ${DIVIDEND_HOUR} h (heure de Paris)` });
      }
    }
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }, getServices);

  return { data, execute };
}
