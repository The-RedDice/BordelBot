import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type InteractionEditReplyOptions,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { relativeTime, replyEphemeral } from '../../../core/replies.js';
import { cryptoRng, type Rng } from '../../../core/rng.js';
import { formatAmount } from '../EconomyService.js';
import { BOARD_SPECS, isOver, legalMoves, newBoard, play, type BoardGame, type BoardState } from '../gambling/boards.js';
import type { GetServices } from '../services.js';
import { achievementLines, errorText } from './format.js';
import type { GuildCommand } from './helpers.js';

export const BOARD_PREFIX = 'board';
/** Délai pour accepter un défi. */
export const BOARD_ACCEPT_MS = 60_000;
/** Délai pour jouer son coup ; au-delà, le joueur perd par abandon. */
export const BOARD_TURN_MS = 120_000;

const NAMES: Record<BoardGame, string> = { morpion: 'Morpion', puissance4: 'Puissance 4' };
const MARKS: Record<BoardGame, readonly [string, string, string]> = {
  morpion: ['▫️', '❌', '⭕'],
  puissance4: ['⚫', '🔴', '🟡'],
};
const COLUMN_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];

interface Editable {
  editReply(options: InteractionEditReplyOptions): Promise<unknown>;
}

interface Match {
  readonly id: string;
  readonly game: BoardGame;
  readonly guildId: string;
  /** Lanceur du défi, puis adversaire ; l'ordre de jeu est tiré au sort à l'acceptation. */
  readonly challengerId: string;
  readonly opponentId: string;
  readonly stake: number;
  /** [joueur 1, joueur 2] une fois la partie lancée. */
  players: readonly [string, string] | null;
  wagerId: string | null;
  state: BoardState | null;
  last: Editable;
  timer: NodeJS.Timeout | undefined;
}

/** Plateau en texte (puissance 4) : les colonnes sont numérotées au-dessus. */
export function boardText(state: BoardState): string {
  const spec = BOARD_SPECS[state.game];
  const marks = MARKS[state.game];
  const rows: string[] = [];
  for (let r = 0; r < spec.rows; r++) {
    rows.push(
      state.cells
        .slice(r * spec.cols, (r + 1) * spec.cols)
        .map((c, i) => (state.line.includes(r * spec.cols + i) ? '✨' : marks[c]))
        .join(''),
    );
  }
  return [COLUMN_EMOJIS.slice(0, spec.cols).join(''), ...rows].join('\n');
}

/**
 * Morpion et puissance 4 entre deux membres, avec une mise facultative : chacun
 * mise la même somme, le gagnant remporte le tout, une égalité rembourse.
 * Les parties sont en mémoire, les mises en dépôt (remboursées si le bot redémarre).
 */
export class BoardMatches {
  private readonly matches = new Map<string, Match>();

  constructor(
    private readonly getServices: GetServices,
    private readonly logger: () => Logger,
    private readonly rng: Rng = cryptoRng,
  ) {}

  async challenge(i: GuildCommand, game: BoardGame): Promise<void> {
    const opponent = i.options.getUser('adversaire', true);
    const stake = i.options.getInteger('mise') ?? 0;
    if (opponent.bot) return replyEphemeral(i, 'Les bots ne jouent pas.');
    if (opponent.id === i.user.id) return replyEphemeral(i, 'Tu ne peux pas jouer contre toi-même.');
    const busy = (id: string) =>
      [...this.matches.values()].some(
        (m) => m.guildId === i.guildId && (m.challengerId === id || (m.state !== null && m.opponentId === id)),
      );
    if (busy(i.user.id)) return replyEphemeral(i, 'Tu as déjà une partie ou un défi en cours.');
    if (busy(opponent.id)) return replyEphemeral(i, `${opponent} est déjà en pleine partie.`);

    const { gambling, eco } = this.getServices();
    if (stake > 0) {
      const own = gambling.checkStake(i.guildId, i.user.id, stake);
      if (!own.ok) return replyEphemeral(i, errorText(own.error));
      const theirs = gambling.checkStake(i.guildId, opponent.id, stake);
      if (!theirs.ok) {
        return replyEphemeral(
          i,
          theirs.error.code === 'INSUFFICIENT_FUNDS' ? `${opponent} n’a pas assez d’argent pour cette mise.` : errorText(theirs.error),
        );
      }
    }

    const match: Match = {
      id: randomUUID().slice(0, 8),
      game,
      guildId: i.guildId,
      challengerId: i.user.id,
      opponentId: opponent.id,
      stake,
      players: null,
      wagerId: null,
      state: null,
      last: i,
      timer: undefined,
    };
    this.matches.set(match.id, match);
    this.arm(match, BOARD_ACCEPT_MS);

    const { currencyName } = eco.getSettings(i.guildId);
    const bet = stake > 0 ? ` pour **${formatAmount(stake, currencyName)}** chacun` : '';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${BOARD_PREFIX}:accept:${match.id}`).setLabel('Accepter').setEmoji('🎮').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${BOARD_PREFIX}:decline:${match.id}`).setLabel('Refuser').setStyle(ButtonStyle.Secondary),
    );
    await i.reply({
      content:
        `🎮 ${i.user} défie ${opponent} au **${NAMES[game]}**${bet} !\n` +
        `Réponse attendue ${relativeTime(Date.now() + BOARD_ACCEPT_MS)}.`,
      components: [row],
      allowedMentions: { users: [opponent.id] },
    });
  }

  async handle(interaction: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
    if (!interaction.isButton()) return;
    const [, action, id, arg] = interaction.customId.split(':');
    const match = id ? this.matches.get(id) : undefined;
    if (!match) {
      await interaction.update({ components: [] }).catch(() => undefined);
      return replyEphemeral(interaction, 'Cette partie est terminée (ou le bot a redémarré : les mises ont été remboursées).');
    }
    const user = interaction.user.id;
    const involved = user === match.challengerId || user === match.opponentId;

    if (action === 'decline') {
      if (!involved || match.state) return replyEphemeral(interaction, 'Ce défi ne te concerne pas.');
      this.remove(match);
      const text = user === match.opponentId ? `🙅 <@${match.opponentId}> a refusé la partie.` : `↩️ <@${match.challengerId}> a annulé son défi.`;
      await interaction.update({ content: text, components: [], allowedMentions: { parse: [] } });
      return;
    }
    if (action === 'accept') {
      if (match.state) return replyEphemeral(interaction, 'La partie a déjà commencé.');
      if (user !== match.opponentId) {
        return replyEphemeral(interaction, user === match.challengerId ? 'C’est à ton adversaire d’accepter.' : 'Ce défi ne te concerne pas.');
      }
      return this.begin(interaction, match);
    }
    if (!match.state || !match.players) return replyEphemeral(interaction, 'La partie n’a pas encore commencé.');
    if (!involved) return replyEphemeral(interaction, 'Tu ne joues pas dans cette partie.');

    if (action === 'forfeit') {
      const winner = match.players[0] === user ? 2 : 1;
      return this.end(interaction, match, winner, `🏳️ <@${user}> abandonne.`);
    }
    if (action !== 'play') return;
    if (match.players[match.state.turn - 1] !== user) return replyEphemeral(interaction, 'Ce n’est pas ton tour.');
    const moved = play(match.state, Number(arg));
    if (!moved.ok) return replyEphemeral(interaction, moved.reason);
    match.state = moved.state;
    match.last = interaction;
    if (isOver(match.state)) return this.end(interaction, match, match.state.winner, null);
    this.arm(match, BOARD_TURN_MS);
    await interaction.update(this.view(match));
  }

  dispose(): void {
    for (const m of this.matches.values()) clearTimeout(m.timer);
    this.matches.clear();
  }

  private async begin(interaction: ButtonInteraction, match: Match): Promise<void> {
    if (match.stake > 0) {
      const opened = this.getServices().wagers.open(match.guildId, match.game, [
        { userId: match.challengerId, stake: match.stake, who: 'Le lanceur du défi' },
        { userId: match.opponentId, stake: match.stake, who: 'Ton adversaire' },
      ]);
      // Les soldes ont pu changer depuis le défi : il reste ouvert.
      if (!opened.ok) return replyEphemeral(interaction, errorText(opened.error));
      match.wagerId = opened.value;
    }
    const first = this.rng() < 0.5;
    match.players = first ? [match.challengerId, match.opponentId] : [match.opponentId, match.challengerId];
    match.state = newBoard(match.game);
    match.last = interaction;
    this.arm(match, BOARD_TURN_MS);
    await interaction.update(this.view(match));
  }

  /** Fin de partie : `winner` 1 ou 2, 0 pour une égalité. */
  private async end(target: ButtonInteraction | null, match: Match, winner: 0 | 1 | 2, reason: string | null): Promise<void> {
    this.remove(match);
    const players = match.players ?? [match.challengerId, match.opponentId];
    const winnerId = winner ? players[winner - 1]! : null;
    const lines = [reason, winnerId ? `🏆 **<@${winnerId}> remporte la partie !**` : '🤝 **Match nul.**'];

    if (match.wagerId) {
      const { wagers, eco } = this.getServices();
      const { currencyName: cur } = eco.getSettings(match.guildId);
      const payouts = new Map(
        winnerId ? [[winnerId, match.stake * 2]] : players.map((p) => [p, match.stake] as const),
      );
      const settled = wagers.settle(match.wagerId, payouts);
      if (!settled.ok) {
        this.logger().error(`${NAMES[match.game]} ${match.id} : règlement impossible`, settled.error);
        lines.push(`⚠️ ${settled.error.message}`);
      } else if (winnerId) {
        const r = settled.value.get(winnerId);
        lines.push(`💰 +${formatAmount(match.stake, cur)} (solde : ${formatAmount(r?.balance ?? 0, cur)})`);
        lines.push(...[...settled.value.values()].flatMap((x) => achievementLines(x.unlocked, cur)));
      } else {
        lines.push('Mises rendues.');
      }
    }

    const view = this.view(match, lines.filter((l): l is string => l !== null));
    try {
      if (target) await target.update(view);
      else await match.last.editReply(view);
    } catch (err) {
      this.logger().debug(`${NAMES[match.game]} ${match.id} : affichage final impossible`, err);
    }
  }

  private view(match: Match, result?: readonly string[]) {
    const state = match.state!;
    const players = match.players!;
    const marks = MARKS[match.game];
    const over = result !== undefined;
    const { currencyName } = this.getServices().eco.getSettings(match.guildId);
    const header =
      `🎮 **${NAMES[match.game]}** · ${marks[1]} <@${players[0]}> contre ${marks[2]} <@${players[1]}>` +
      (match.stake > 0 ? ` · mise ${formatAmount(match.stake, currencyName)} chacun` : '');
    const status = over
      ? result.join('\n')
      : `Au tour de <@${players[state.turn - 1]}> ${marks[state.turn]} (avant ${relativeTime(Date.now() + BOARD_TURN_MS)}, sinon abandon).`;
    const gravity = BOARD_SPECS[match.game].gravity;
    const content = [header, gravity ? boardText(state) : null, status].filter(Boolean).join('\n\n');
    return {
      content,
      components: gravity ? this.columnButtons(match, over) : this.cellButtons(match, over),
      allowedMentions: { parse: [] as never[] },
    };
  }

  private cellButtons(match: Match, over: boolean): ActionRowBuilder<ButtonBuilder>[] {
    const state = match.state!;
    const marks = MARKS[match.game];
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let r = 0; r < 3; r++) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          [0, 1, 2].map((c) => {
            const idx = r * 3 + c;
            const mark = state.cells[idx]!;
            return new ButtonBuilder()
              .setCustomId(`${BOARD_PREFIX}:play:${match.id}:${idx}`)
              .setEmoji(marks[mark])
              .setStyle(state.line.includes(idx) ? ButtonStyle.Success : ButtonStyle.Secondary)
              .setDisabled(over || mark !== 0);
          }),
        ),
      );
    }
    if (!over) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(this.forfeitButton(match)));
    return rows;
  }

  private columnButtons(match: Match, over: boolean): ActionRowBuilder<ButtonBuilder>[] {
    if (over) return [];
    const legal = new Set(legalMoves(match.state!));
    const buttons = COLUMN_EMOJIS.map((emoji, col) =>
      new ButtonBuilder()
        .setCustomId(`${BOARD_PREFIX}:play:${match.id}:${col}`)
        .setEmoji(emoji)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!legal.has(col)),
    );
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(0, 4)),
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(4), this.forfeitButton(match)),
    ];
  }

  private forfeitButton(match: Match): ButtonBuilder {
    return new ButtonBuilder().setCustomId(`${BOARD_PREFIX}:forfeit:${match.id}`).setLabel('Abandonner').setStyle(ButtonStyle.Danger);
  }

  private remove(match: Match): void {
    clearTimeout(match.timer);
    this.matches.delete(match.id);
  }

  private arm(match: Match, ms: number): void {
    clearTimeout(match.timer);
    match.timer = setTimeout(() => void this.expire(match.id), ms);
    match.timer.unref();
  }

  private async expire(id: string): Promise<void> {
    const match = this.matches.get(id);
    if (!match) return;
    if (!match.state || !match.players) {
      this.remove(match);
      await match.last
        .editReply({
          content: `⌛ Le défi de <@${match.challengerId}> à <@${match.opponentId}> a expiré.`,
          components: [],
          allowedMentions: { parse: [] },
        })
        .catch(() => undefined);
      return;
    }
    const late = match.players[match.state.turn - 1]!;
    await this.end(null, match, match.state.turn === 1 ? 2 : 1, `⌛ <@${late}> n’a pas joué à temps.`);
  }
}
