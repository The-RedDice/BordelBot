import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type SlashCommandIntegerOption,
} from 'discord.js';
import type { ComponentHandler, SlashCommand } from '../../../core/commands/types.js';
import type { Logger } from '../../../core/logger.js';
import { replyEphemeral } from '../../../core/replies.js';
import { formatAmount, MAX_AMOUNT } from '../EconomyService.js';
import { COIN_MULTIPLIER, type CoinSide } from '../gambling/games.js';
import type { GetServices } from '../services.js';
import { achievementLines, errorText } from './format.js';
import { guildCommand, guildOnly } from './helpers.js';

export const DUEL_PREFIX = 'duel';
/** Délai pour accepter un défi. */
export const DUEL_TIMEOUT_MS = 60_000;

const stakeOption = (o: SlashCommandIntegerOption) =>
  o.setName('mise').setDescription('Montant misé').setRequired(true).setMinValue(1).setMaxValue(MAX_AMOUNT);

interface PendingDuel {
  readonly id: string;
  readonly guildId: string;
  readonly challengerId: string;
  readonly opponentId: string;
  readonly stake: number;
  /** Interaction d'origine : permet d'éditer le message à l'expiration (jeton valable 15 min). */
  readonly interaction: ChatInputCommandInteraction;
  readonly timer: NodeJS.Timeout;
}

/**
 * Défis en attente, en mémoire : un redémarrage les annule (les boutons
 * répondent alors « défi expiré »), ce qui est sans conséquence car aucune
 * mise n'est prélevée avant l'acceptation.
 */
export class DuelManager {
  private readonly pending = new Map<string, PendingDuel>();

  constructor(
    private readonly getServices: GetServices,
    private readonly logger: () => Logger,
  ) {}

  async challenge(i: ChatInputCommandInteraction<'cached' | 'raw'>): Promise<void> {
    const opponent = i.options.getUser('membre', true);
    const stake = i.options.getInteger('mise', true);
    if (opponent.bot) return replyEphemeral(i, 'Les bots ne relèvent pas les défis.');
    if (opponent.id === i.user.id) return replyEphemeral(i, 'Tu ne peux pas te défier toi-même.');
    if ([...this.pending.values()].some((d) => d.guildId === i.guildId && d.challengerId === i.user.id)) {
      return replyEphemeral(i, 'Tu as déjà un défi en attente : attends sa réponse ou annule-le.');
    }
    const { gambling, eco } = this.getServices();
    const own = gambling.checkStake(i.guildId, i.user.id, stake);
    if (!own.ok) return replyEphemeral(i, errorText(own.error));
    const theirs = gambling.checkStake(i.guildId, opponent.id, stake);
    if (!theirs.ok) {
      return replyEphemeral(i, theirs.error.code === 'INSUFFICIENT_FUNDS' ? `${opponent} n’a pas assez d’argent pour cette mise.` : errorText(theirs.error));
    }

    const id = randomUUID().slice(0, 8);
    const { currencyName } = eco.getSettings(i.guildId);
    const timer = setTimeout(() => void this.expire(id), DUEL_TIMEOUT_MS);
    timer.unref();
    this.pending.set(id, { id, guildId: i.guildId, challengerId: i.user.id, opponentId: opponent.id, stake, interaction: i, timer });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DUEL_PREFIX}:accept:${id}`).setLabel('Accepter').setEmoji('⚔️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DUEL_PREFIX}:decline:${id}`).setLabel('Refuser').setStyle(ButtonStyle.Secondary),
    );
    await i.reply({
      content:
        `⚔️ ${i.user} défie ${opponent} en duel pour **${formatAmount(stake, currencyName)}** !\n` +
        `Pile ou face : le gagnant rafle la mise de l’autre. Réponse attendue <t:${Math.ceil((Date.now() + DUEL_TIMEOUT_MS) / 1000)}:R>.`,
      components: [row],
      allowedMentions: { users: [opponent.id] },
    });
  }

  async handle(interaction: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
    if (!interaction.isButton()) return;
    const [, action, id] = interaction.customId.split(':');
    const duel = id ? this.pending.get(id) : undefined;
    if (!duel) {
      await interaction.update({ components: [] }).catch(() => undefined);
      return replyEphemeral(interaction, 'Ce défi a expiré.');
    }
    const isOpponent = interaction.user.id === duel.opponentId;
    const isChallenger = interaction.user.id === duel.challengerId;

    if (action === 'decline') {
      if (!isOpponent && !isChallenger) return replyEphemeral(interaction, 'Ce défi ne te concerne pas.');
      this.remove(duel);
      const text = isOpponent ? `🙅 <@${duel.opponentId}> a refusé le duel.` : `↩️ <@${duel.challengerId}> a annulé son défi.`;
      await interaction.update({ content: text, components: [], allowedMentions: { parse: [] } });
      return;
    }
    if (action !== 'accept') return;
    if (!isOpponent) {
      return replyEphemeral(interaction, isChallenger ? 'C’est à ton adversaire d’accepter.' : 'Ce défi ne te concerne pas.');
    }
    await this.fight(interaction, duel);
  }

  dispose(): void {
    for (const duel of this.pending.values()) clearTimeout(duel.timer);
    this.pending.clear();
  }

  private async fight(interaction: ButtonInteraction, duel: PendingDuel): Promise<void> {
    const { gambling, eco } = this.getServices();
    const r = gambling.duel(duel.guildId, duel.challengerId, duel.opponentId, duel.stake);
    if (!r.ok) {
      // Les soldes ont pu changer depuis le défi : on laisse le défi ouvert si l'erreur vient de l'adversaire.
      return replyEphemeral(interaction, errorText(r.error));
    }
    this.remove(duel);
    const { currencyName } = eco.getSettings(duel.guildId);
    const { winnerId, loserId, winnerBalance, unlocked } = r.value;
    const lines = [
      `🪙 La pièce tourne… **<@${winnerId}> remporte le duel** contre <@${loserId}> !`,
      `💰 +${formatAmount(duel.stake, currencyName)} (solde : ${formatAmount(winnerBalance, currencyName)})`,
      ...[...unlocked].flatMap(([userId, list]) => achievementLines(list, currencyName, `<@${userId}>`)),
    ];
    await interaction.update({ content: lines.join('\n'), components: [], allowedMentions: { parse: [] } });
  }

  private remove(duel: PendingDuel): void {
    clearTimeout(duel.timer);
    this.pending.delete(duel.id);
  }

  private async expire(id: string): Promise<void> {
    const duel = this.pending.get(id);
    if (!duel) return;
    this.pending.delete(id);
    try {
      await duel.interaction.editReply({
        content: `⌛ Le défi de <@${duel.challengerId}> à <@${duel.opponentId}> a expiré.`,
        components: [],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      this.logger().debug(`Impossible de marquer le duel ${id} comme expiré`, err);
    }
  }
}

export function createGamblingCommands(
  getServices: GetServices,
  getDuels: () => DuelManager,
): { commands: SlashCommand[]; components: ComponentHandler[] } {
  const pileOuFace: SlashCommand = {
    data: guildCommand('pile-ou-face', `Quitte ou double : mise sur pile ou face (gain ×${COIN_MULTIPLIER})`)
      .addIntegerOption(stakeOption)
      .addStringOption((o) =>
        o
          .setName('choix')
          .setDescription('Ton pari')
          .setRequired(true)
          .addChoices({ name: 'Pile', value: 'pile' }, { name: 'Face', value: 'face' }),
      ),
    execute: guildOnly(async (i, { gambling, eco }) => {
      const call = i.options.getString('choix', true) as CoinSide;
      const r = gambling.coinFlip(i.guildId, i.user.id, i.options.getInteger('mise', true), call);
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName: cur } = eco.getSettings(i.guildId);
      const { side, won, stake, net, balance, unlocked } = r.value;
      const lines = [
        `🪙 La pièce retombe sur **${side}** !`,
        won
          ? `🎉 Gagné : **+${formatAmount(net, cur)}**`
          : `💸 Perdu : −${formatAmount(stake, cur)}`,
        `Solde : ${formatAmount(balance, cur)}`,
        ...achievementLines(unlocked, cur),
      ];
      await i.reply({ content: lines.join('\n') });
    }, getServices),
  };

  const slots: SlashCommand = {
    data: guildCommand('machine-a-sous', 'Tente le jackpot (💎💎💎 = ×200)').addIntegerOption(stakeOption),
    execute: guildOnly(async (i, { gambling, eco }) => {
      const r = gambling.slots(i.guildId, i.user.id, i.options.getInteger('mise', true));
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName: cur } = eco.getSettings(i.guildId);
      const { spin, payout, net, stake, balance, unlocked } = r.value;
      const reels = spin.reels.map((s) => s.emoji).join(' │ ');
      const result =
        spin.multiplier >= 20
          ? `💥 **JACKPOT ×${spin.multiplier}** : +${formatAmount(net, cur)} !`
          : payout > 0
            ? `🎉 ×${spin.multiplier} : **+${formatAmount(net, cur)}**`
            : `💸 Perdu : −${formatAmount(stake, cur)}`;
      await i.reply({
        content: [`🎰 **[ ${reels} ]**`, result, `Solde : ${formatAmount(balance, cur)}`, ...achievementLines(unlocked, cur)].join(
          '\n',
        ),
      });
    }, getServices),
  };

  const duel: SlashCommand = {
    data: guildCommand('duel', 'Défie un membre à pile ou face : le gagnant prend la mise de l’autre')
      .addUserOption((o) => o.setName('membre').setDescription('Adversaire').setRequired(true))
      .addIntegerOption(stakeOption),
    execute: guildOnly((i) => getDuels().challenge(i), getServices),
  };

  const duelButtons: ComponentHandler = {
    prefix: DUEL_PREFIX,
    handle: (interaction) => getDuels().handle(interaction),
  };

  return { commands: [pileOuFace, slots, duel], components: [duelButtons] };
}
