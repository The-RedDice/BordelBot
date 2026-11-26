import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type InteractionEditReplyOptions,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { replyEphemeral } from '../../../core/replies.js';
import { cryptoRng, type Rng } from '../../../core/rng.js';
import { formatAmount } from '../EconomyService.js';
import {
  blackjackPayout,
  canDouble,
  cardText,
  deal,
  double,
  handValue,
  hit,
  newShoe,
  stand,
  type BlackjackOutcome,
  type BlackjackState,
  type Card,
} from '../gambling/blackjack.js';
import type { GetServices } from '../services.js';
import { achievementLines, errorText } from './format.js';
import type { GuildCommand } from './helpers.js';

export const BJ_PREFIX = 'bj';
/** Sans action du joueur pendant ce délai, il reste automatiquement. */
export const BJ_TURN_MS = 120_000;

/** Ce qu'il faut pour éditer le message de la partie (dernière interaction reçue, jeton valable 15 min). */
interface Editable {
  editReply(options: InteractionEditReplyOptions): Promise<unknown>;
}

interface Hand {
  readonly id: string;
  readonly guildId: string;
  readonly userId: string;
  readonly wagerId: string;
  readonly stake: number;
  state: BlackjackState;
  last: Editable;
  timer: NodeJS.Timeout | undefined;
}

const OUTCOME_TEXT: Record<BlackjackOutcome, string> = {
  blackjack: '🃏 **Blackjack !** Payé 3 pour 2.',
  win: '🎉 **Gagné !**',
  push: '🤝 **Égalité** : mise rendue.',
  lose: '💸 **Perdu.**',
};

function handLine(cards: readonly Card[], hideSecond = false): string {
  if (hideSecond) return `${cardText(cards[0]!)} 🂠 · **?**`;
  const { total, soft } = handValue(cards);
  return `${cards.map(cardText).join(' ')} · **${total}**${soft && total < 21 ? ' (souple)' : ''}`;
}

export function blackjackEmbed(state: BlackjackState, stake: number, currency: string, footer?: string): EmbedBuilder {
  const playing = state.outcome === null;
  const embed = new EmbedBuilder()
    .setColor(playing ? 0x2b2d31 : state.outcome === 'lose' ? 0xed4245 : state.outcome === 'push' ? 0x99aab5 : 0x57f287)
    .setTitle(`🃏 Blackjack · mise ${formatAmount(stake * (state.doubled ? 2 : 1), currency)}${state.doubled ? ' (doublée)' : ''}`)
    .addFields(
      { name: 'Croupier', value: handLine(state.dealer, playing) },
      { name: 'Ta main', value: handLine(state.player) },
    );
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

/**
 * Parties de blackjack en cours, en mémoire. La mise est en dépôt (WagerService) :
 * si le bot redémarre pendant une partie, elle est remboursée au démarrage.
 */
export class BlackjackTables {
  private readonly hands = new Map<string, Hand>();

  constructor(
    private readonly getServices: GetServices,
    private readonly logger: () => Logger,
    private readonly rng: Rng = cryptoRng,
  ) {}

  async start(i: GuildCommand): Promise<void> {
    if ([...this.hands.values()].some((h) => h.guildId === i.guildId && h.userId === i.user.id)) {
      return replyEphemeral(i, 'Tu as déjà une partie de blackjack en cours : termine-la d’abord.');
    }
    const stake = i.options.getInteger('mise', true);
    const { wagers, eco } = this.getServices();
    const opened = wagers.open(i.guildId, 'blackjack', [{ userId: i.user.id, stake }]);
    if (!opened.ok) return replyEphemeral(i, errorText(opened.error));

    const hand: Hand = {
      id: opened.value,
      guildId: i.guildId,
      userId: i.user.id,
      wagerId: opened.value,
      stake,
      state: deal(newShoe(this.rng)),
      last: i,
      timer: undefined,
    };
    const { currencyName } = eco.getSettings(i.guildId);
    if (hand.state.outcome !== null) {
      // Blackjack d'entrée (joueur ou croupier) : la main est déjà jouée.
      await i.reply({ embeds: [this.finish(hand, currencyName)] });
      return;
    }
    this.hands.set(hand.id, hand);
    this.arm(hand);
    await i.reply({ embeds: [blackjackEmbed(hand.state, stake, currencyName, this.turnFooter())], components: [this.buttons(hand)] });
  }

  async handle(interaction: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
    if (!interaction.isButton()) return;
    const [, action, id] = interaction.customId.split(':');
    const hand = id ? this.hands.get(id) : undefined;
    if (!hand) {
      await interaction.update({ components: [] }).catch(() => undefined);
      return replyEphemeral(interaction, 'Cette partie est terminée (ou le bot a redémarré : la mise a été remboursée).');
    }
    if (interaction.user.id !== hand.userId) return replyEphemeral(interaction, 'Ce n’est pas ta partie.');

    if (action === 'double') {
      if (!canDouble(hand.state)) return replyEphemeral(interaction, 'Tu ne peux doubler que sur tes deux premières cartes.');
      const r = this.getServices().wagers.add(hand.wagerId, { userId: hand.userId, stake: hand.stake });
      if (!r.ok) return replyEphemeral(interaction, errorText(r.error));
      hand.state = double(hand.state);
    } else if (action === 'hit') {
      hand.state = hit(hand.state);
    } else if (action === 'stand') {
      hand.state = stand(hand.state);
    } else {
      return;
    }

    hand.last = interaction;
    const { currencyName } = this.getServices().eco.getSettings(hand.guildId);
    if (hand.state.outcome !== null) {
      await interaction.update({ embeds: [this.finish(hand, currencyName)], components: [] });
      return;
    }
    this.arm(hand);
    await interaction.update({
      embeds: [blackjackEmbed(hand.state, hand.stake, currencyName, this.turnFooter())],
      components: [this.buttons(hand)],
    });
  }

  dispose(): void {
    for (const hand of this.hands.values()) clearTimeout(hand.timer);
    this.hands.clear();
  }

  /** Règle la mise et renvoie l'embed final. */
  private finish(hand: Hand, currency: string): EmbedBuilder {
    clearTimeout(hand.timer);
    this.hands.delete(hand.id);
    const outcome = hand.state.outcome ?? 'lose';
    const total = hand.stake * (hand.state.doubled ? 2 : 1);
    const payout = blackjackPayout(outcome, total);
    const r = this.getServices().wagers.settle(hand.wagerId, new Map([[hand.userId, payout]]));
    if (!r.ok) {
      this.logger().error(`Blackjack ${hand.id} : règlement impossible`, r.error);
      return blackjackEmbed(hand.state, hand.stake, currency).setDescription(`⚠️ ${r.error.message}`);
    }
    const result = r.value.get(hand.userId);
    const net = payout - total;
    const lines = [
      OUTCOME_TEXT[outcome],
      net > 0 ? `+${formatAmount(net, currency)}` : net < 0 ? `−${formatAmount(-net, currency)}` : null,
      result ? `Solde : ${formatAmount(result.balance, currency)}` : null,
      ...achievementLines(result?.unlocked ?? [], currency),
    ];
    return blackjackEmbed(hand.state, hand.stake, currency).setDescription(lines.filter(Boolean).join('\n'));
  }

  private buttons(hand: Hand): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${BJ_PREFIX}:hit:${hand.id}`).setLabel('Tirer').setEmoji('➕').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${BJ_PREFIX}:stand:${hand.id}`).setLabel('Rester').setEmoji('✋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${BJ_PREFIX}:double:${hand.id}`)
        .setLabel('Doubler')
        .setEmoji('✖️')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canDouble(hand.state)),
    );
  }

  private turnFooter(): string {
    return `Sans action dans ${BJ_TURN_MS / 60_000} min, tu restes automatiquement.`;
  }

  private arm(hand: Hand): void {
    clearTimeout(hand.timer);
    hand.timer = setTimeout(() => void this.timeout(hand.id), BJ_TURN_MS);
    hand.timer.unref();
  }

  private async timeout(id: string): Promise<void> {
    const hand = this.hands.get(id);
    if (!hand) return;
    hand.state = stand(hand.state);
    const { currencyName } = this.getServices().eco.getSettings(hand.guildId);
    const embed = this.finish(hand, currencyName);
    try {
      await hand.last.editReply({ embeds: [embed], components: [] });
    } catch (err) {
      this.logger().debug(`Blackjack ${id} : message final impossible à afficher`, err);
    }
  }
}
