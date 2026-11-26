import { EmbedBuilder, SlashCommandSubcommandGroupBuilder, type Client } from 'discord.js';
import type { Subcommand } from '../../../core/commands/types.js';
import type { BotJobs } from '../../../core/jobs.js';
import type { Logger } from '../../../core/logger.js';
import { relativeTime, replyEphemeral } from '../../../core/replies.js';
import type { JobHandler } from '../../../core/scheduler/JobScheduler.js';
import { formatAmount } from '../EconomyService.js';
import { lotteryJobKey, MAX_TICKETS_PER_PLAYER, POT_SHARE } from '../lottery/LotteryService.js';
import type { GetServices } from '../services.js';
import { ECONOMY_COLOR, errorText } from './format.js';
import { guildOnly } from './helpers.js';

/** `/eco loterie acheter|voir`. */
export function createLotteryCommand(getServices: GetServices): Subcommand {
  const data = new SlashCommandSubcommandGroupBuilder()
    .setName('loterie')
    .setDescription('Loterie hebdomadaire : tirage le dimanche à 20 h')
    .addSubcommand((s) =>
      s
        .setName('acheter')
        .setDescription('Achète des tickets pour le prochain tirage')
        .addIntegerOption((o) =>
          o.setName('tickets').setDescription('Nombre de tickets (1 par défaut)').setMinValue(1).setMaxValue(MAX_TICKETS_PER_PLAYER),
        ),
    )
    .addSubcommand((s) => s.setName('voir').setDescription('Cagnotte, tickets vendus et tes chances'));

  return {
    parent: 'eco',
    data,
    execute: guildOnly(async (i, { lottery, eco, events, scheduler }) => {
      const { currencyName: cur } = eco.getSettings(i.guildId);
      if (i.options.getSubcommand() === 'acheter') {
        const r = lottery.buy(i.guildId, i.user.id, i.options.getInteger('tickets') ?? 1);
        if (!r.ok) return replyEphemeral(i, errorText(r.error));
        const p = r.value;
        if (p.opened) {
          scheduler.schedule(
            'lottery:draw',
            p.draw.drawsAt,
            { guildId: i.guildId, drawId: p.draw.id },
            { key: lotteryJobKey(i.guildId), guildId: i.guildId },
          );
        }
        await i.reply({
          content:
            `🎟️ ${i.user} achète **${p.bought} ticket(s)** pour ${formatAmount(p.cost, cur)} (${p.owned} au total).\n` +
            `💰 Cagnotte : **${formatAmount(p.draw.pot, cur)}** · tirage ${relativeTime(p.draw.drawsAt)}`,
          allowedMentions: { parse: [] },
        });
        return;
      }

      const draw = lottery.current(i.guildId);
      const { ticketPrice } = events.get(i.guildId);
      const embed = new EmbedBuilder().setColor(ECONOMY_COLOR).setTitle('🎟️ Loterie de la semaine');
      if (ticketPrice <= 0) {
        embed.setDescription('*La loterie est désactivée sur ce serveur.*');
      } else if (!draw) {
        embed.setDescription(
          `Aucun ticket vendu pour l’instant. Le premier ticket ouvre le tirage du dimanche suivant à 20 h.\n` +
            `Ticket : ${formatAmount(ticketPrice, cur)} · \`/eco loterie acheter\``,
        );
      } else {
        const entries = lottery.entries(draw.id);
        const total = entries.reduce((sum, e) => sum + e.count, 0);
        const mine = lottery.ticketsOf(draw.id, i.user.id);
        embed.setDescription(
          [
            `💰 Cagnotte : **${formatAmount(draw.pot, cur)}**`,
            `🎫 ${total} ticket(s) vendu(s) à ${entries.length} joueur(s) · ${formatAmount(ticketPrice, cur)} le ticket`,
            `⏰ Tirage ${relativeTime(draw.drawsAt)}`,
            mine > 0 ? `🍀 Tu as ${mine} ticket(s) : ${((mine / total) * 100).toFixed(1).replace('.', ',')} % de chances.` : 'Tu n’as pas de ticket.',
          ].join('\n'),
        );
      }
      embed.setFooter({ text: `${Math.round(POT_SHARE * 100)} % du prix des tickets vont dans la cagnotte · un seul gagnant` });
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }, getServices),
  };
}

/** Tirage planifié : désigne le gagnant, lui verse la cagnotte, l'annonce. */
export function lotteryDrawHandler(
  getServices: GetServices,
  logger: () => Logger,
): JobHandler<'lottery:draw', BotJobs['lottery:draw'], Client<true>> {
  return async ({ payload: { guildId, drawId } }, client) => {
    const { lottery, events, eco } = getServices();
    const r = lottery.runDraw(drawId);
    if (!r.ok) throw new Error(r.error.message);
    const result = r.value;
    if (!result || !result.winnerId) return;
    const { channelId } = events.get(guildId);
    const channel = channelId ? client.guilds.cache.get(guildId)?.channels.cache.get(channelId) : undefined;
    if (!channel?.isSendable()) return;
    const { currencyName: cur } = eco.getSettings(guildId);
    await channel
      .send({
        content:
          `🎟️ **Tirage de la loterie !** <@${result.winnerId}> remporte la cagnotte de **${formatAmount(result.prize, cur)}** ` +
          `(${result.tickets} ticket(s), ${result.players} joueur(s)).\nProchain tirage : achetez vos tickets avec \`/eco loterie acheter\`.`,
        allowedMentions: { users: [result.winnerId] },
      })
      .catch((err: unknown) => logger().warn(`Annonce de la loterie impossible sur ${guildId}`, err));
  };
}
