import { MessageFlags, type InteractionEditReplyOptions } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { relativeTime, replyEphemeral } from '../../../core/replies.js';
import { cryptoRng, type Rng } from '../../../core/rng.js';
import { formatAmount } from '../EconomyService.js';
import {
  colorEmoji,
  describeBet,
  parseBet,
  rouletteMultiplier,
  spinRoulette,
  type RouletteBet,
} from '../gambling/roulette.js';
import type { PlayerResult } from '../gambling/WagerService.js';
import type { GetServices } from '../services.js';
import { achievementLines, errorText } from './format.js';
import type { GuildCommand } from './helpers.js';

/** Durée pendant laquelle on peut miser après le premier pari. */
export const ROULETTE_WINDOW_MS = 30_000;
export const MAX_BETS_PER_PLAYER = 5;

interface Bet {
  readonly userId: string;
  readonly bet: RouletteBet;
  readonly stake: number;
}

interface Table {
  readonly wagerId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly endsAt: number;
  readonly bets: Bet[];
  /** Commande qui a ouvert la table : son message est la table elle-même. */
  readonly opener: { editReply(options: InteractionEditReplyOptions): Promise<unknown> };
  timer: NodeJS.Timeout | undefined;
}

/** Gain total de chaque joueur pour un numéro tiré. */
export function roulettePayouts(bets: readonly Bet[], result: number): Map<string, number> {
  const payouts = new Map<string, number>();
  for (const b of bets) payouts.set(b.userId, (payouts.get(b.userId) ?? 0) + b.stake * rouletteMultiplier(b.bet, result));
  return payouts;
}

function betLines(bets: readonly Bet[], currency: string): string[] {
  return bets.map((b) => `• <@${b.userId}> : ${formatAmount(b.stake, currency)} sur **${describeBet(b.bet)}**`);
}

/**
 * Roulette multijoueur, une table par salon : le premier pari ouvre la table,
 * les autres membres ont `ROULETTE_WINDOW_MS` pour miser, puis la bille est
 * lancée pour tout le monde. Les mises sont en dépôt (remboursées si le bot
 * redémarre avant le tirage).
 */
export class RouletteTables {
  private readonly tables = new Map<string, Table>();

  constructor(
    private readonly getServices: GetServices,
    private readonly logger: () => Logger,
    private readonly rng: Rng = cryptoRng,
  ) {}

  async bet(i: GuildCommand): Promise<void> {
    const bet = parseBet(i.options.getString('pari', true), i.options.getInteger('numero'));
    if (!bet) return replyEphemeral(i, 'Pour un numéro plein, indique aussi l’option `numero` (0 à 36).');
    const stake = i.options.getInteger('mise', true);
    const { wagers, eco } = this.getServices();
    const { currencyName } = eco.getSettings(i.guildId);
    const entry = { userId: i.user.id, stake, bet };

    const table = this.tables.get(i.channelId);
    if (!table) {
      const opened = wagers.open(i.guildId, 'roulette', [entry]);
      if (!opened.ok) return replyEphemeral(i, errorText(opened.error));
      // Enregistrée avant tout `await` : un second pari arrivé entre-temps rejoint cette table.
      const created: Table = {
        wagerId: opened.value,
        guildId: i.guildId,
        channelId: i.channelId,
        endsAt: Date.now() + ROULETTE_WINDOW_MS,
        bets: [{ userId: i.user.id, bet, stake }],
        opener: i,
        timer: undefined,
      };
      this.tables.set(i.channelId, created);
      created.timer = setTimeout(() => void this.spin(created), ROULETTE_WINDOW_MS);
      created.timer.unref();
      await i.reply({ content: this.render(created, currencyName), allowedMentions: { parse: [] } });
      return;
    }

    if (table.bets.filter((b) => b.userId === i.user.id).length >= MAX_BETS_PER_PLAYER) {
      return replyEphemeral(i, `${MAX_BETS_PER_PLAYER} paris au plus par joueur et par tour.`);
    }
    const added = wagers.add(table.wagerId, entry);
    if (!added.ok) return replyEphemeral(i, errorText(added.error));
    table.bets.push({ userId: i.user.id, bet, stake });
    await i.reply({
      content: `🎡 Pari enregistré : ${formatAmount(stake, currencyName)} sur **${describeBet(bet)}**. Tirage ${relativeTime(table.endsAt)}.`,
      flags: MessageFlags.Ephemeral,
    });
    await table.opener.editReply({ content: this.render(table, currencyName), allowedMentions: { parse: [] } }).catch((err: unknown) => {
      this.logger().debug('Roulette : table impossible à mettre à jour', err);
    });
  }

  dispose(): void {
    for (const t of this.tables.values()) clearTimeout(t.timer);
    this.tables.clear();
  }

  private render(table: Table, currency: string): string {
    return [
      `🎡 **Roulette** · faites vos jeux ! Tirage ${relativeTime(table.endsAt)}.`,
      'Pour miser : `/jeu roulette`.',
      '',
      ...betLines(table.bets, currency),
    ].join('\n');
  }

  private async spin(table: Table): Promise<void> {
    this.tables.delete(table.channelId);
    const result = spinRoulette(this.rng);
    const payouts = roulettePayouts(table.bets, result);
    const { wagers, eco } = this.getServices();
    const { currencyName: cur } = eco.getSettings(table.guildId);
    const settled = wagers.settle(table.wagerId, payouts);

    let lines: string[];
    if (!settled.ok) {
      this.logger().error(`Roulette ${table.wagerId} : règlement impossible`, settled.error);
      lines = [`⚠️ ${settled.error.message}`];
    } else {
      lines = [...settled.value].map(([userId, r]) => resultLine(userId, r, cur));
      lines.push(...[...settled.value.values()].flatMap((r) => achievementLines(r.unlocked, cur)));
    }
    const content = [
      `🎡 La bille s’arrête sur… ${colorEmoji(result)} **${result}** !`,
      '',
      ...betLines(table.bets, cur),
      '',
      ...lines,
    ].join('\n');
    await table.opener.editReply({ content: content.slice(0, 2000), allowedMentions: { parse: [] } }).catch((err: unknown) => {
      this.logger().warn('Roulette : résultat impossible à afficher', err);
    });
  }
}

function resultLine(userId: string, r: PlayerResult, cur: string): string {
  if (r.net > 0) return `🎉 <@${userId}> gagne **+${formatAmount(r.net, cur)}** (solde : ${formatAmount(r.balance, cur)})`;
  if (r.net === 0) return `🤝 <@${userId}> récupère sa mise`;
  return `💸 <@${userId}> perd ${formatAmount(-r.net, cur)}`;
}
