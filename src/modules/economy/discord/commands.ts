import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type User,
} from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import { relativeTime, replyEphemeral } from '../../../core/replies.js';
import { formatAmount, MAX_AMOUNT, MAX_PURCHASE_QUANTITY, type EconomyService } from '../EconomyService.js';
import { ECONOMY_COLOR, errorText, MEDALS, transactionLine } from './format.js';

type GetService = () => EconomyService;
type GuildCommand = ChatInputCommandInteraction<'cached' | 'raw'>;

/** Toutes les commandes d'économie sont réservées aux serveurs. */
function guildOnly(
  handler: (i: GuildCommand, eco: EconomyService) => Promise<void>,
  getService: GetService,
): SlashCommand['execute'] {
  return async (interaction) => {
    if (!interaction.inGuild()) return replyEphemeral(interaction, 'Cette commande s’utilise sur un serveur.');
    return handler(interaction, getService());
  };
}

/** Les bots n'ont pas de compte : on le signale plutôt que d'afficher un solde vide. */
async function rejectBot(interaction: GuildCommand, user: User): Promise<boolean> {
  if (!user.bot) return false;
  await replyEphemeral(interaction, 'Les bots n’ont pas de compte.');
  return true;
}

const base = (name: string, description: string) =>
  new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);

export function createEconomyCommands(getService: GetService): SlashCommand[] {
  const solde: SlashCommand = {
    data: base('solde', 'Affiche ton solde ou celui d’un membre').addUserOption((o) =>
      o.setName('membre').setDescription('Membre à consulter'),
    ),
    execute: guildOnly(async (i, eco) => {
      const user = i.options.getUser('membre') ?? i.user;
      if (await rejectBot(i, user)) return;
      const { currencyName } = eco.getSettings(i.guildId);
      const rank = eco.getRank(i.guildId, user.id);
      const embed = new EmbedBuilder()
        .setColor(ECONOMY_COLOR)
        .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
        .setDescription(
          `💰 **${formatAmount(eco.getBalance(i.guildId, user.id), currencyName)}**` +
            (rank ? `\n🏅 ${rank}ᵉ du classement` : ''),
        );
      await i.reply({ embeds: [embed] });
    }, getService),
  };

  const daily: SlashCommand = {
    data: base('daily', 'Récupère ta récompense quotidienne'),
    execute: guildOnly(async (i, eco) => {
      const r = eco.claimDaily(i.guildId, i.user.id);
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName } = eco.getSettings(i.guildId);
      const { amount, bonus, streak, balance, nextAt } = r.value;
      const lines = [
        `🎁 Tu reçois **${formatAmount(amount, currencyName)}** !`,
        streak > 1 ? `🔥 Série de ${streak} jours (bonus : ${formatAmount(bonus, currencyName)})` : null,
        `Nouveau solde : ${formatAmount(balance, currencyName)} · prochaine récompense ${relativeTime(nextAt)}`,
      ];
      await i.reply({ content: lines.filter(Boolean).join('\n') });
    }, getService),
  };

  const virer: SlashCommand = {
    data: base('virer', 'Envoie de l’argent à un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Destinataire').setRequired(true))
      .addIntegerOption((o) =>
        o.setName('montant').setDescription('Montant à envoyer').setRequired(true).setMinValue(1).setMaxValue(MAX_AMOUNT),
      ),
    execute: guildOnly(async (i, eco) => {
      const target = i.options.getUser('membre', true);
      if (await rejectBot(i, target)) return;
      const r = eco.transfer(i.guildId, i.user.id, target.id, i.options.getInteger('montant', true));
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName } = eco.getSettings(i.guildId);
      await i.reply({
        content:
          `💸 ${i.user} a envoyé **${formatAmount(r.value.amount, currencyName)}** à ${target}.\n` +
          `Ton nouveau solde : ${formatAmount(r.value.fromBalance, currencyName)}`,
        allowedMentions: { users: [target.id] },
      });
    }, getService),
  };

  const classement: SlashCommand = {
    data: base('classement', 'Les membres les plus riches du serveur'),
    execute: guildOnly(async (i, eco) => {
      const { currencyName } = eco.getSettings(i.guildId);
      const top = eco.leaderboard(i.guildId, 10);
      const lines = top.map(
        (r, idx) => `${MEDALS[idx] ?? `**${idx + 1}.**`} <@${r.userId}> — ${formatAmount(r.balance, currencyName)}`,
      );
      const rank = eco.getRank(i.guildId, i.user.id);
      const embed = new EmbedBuilder()
        .setColor(ECONOMY_COLOR)
        .setTitle('🏆 Classement')
        .setDescription(lines.length ? lines.join('\n') : '*Personne n’a encore d’argent sur ce serveur.*');
      if (rank && rank > 10) embed.setFooter({ text: `Ta position : ${rank}ᵉ` });
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }, getService),
  };

  const historique: SlashCommand = {
    data: base('historique', 'Tes dernières opérations'),
    execute: guildOnly(async (i, eco) => {
      const { currencyName } = eco.getSettings(i.guildId);
      const txs = eco.history(i.guildId, i.user.id, 10);
      const embed = new EmbedBuilder()
        .setColor(ECONOMY_COLOR)
        .setTitle('📜 Tes dernières opérations')
        .setDescription(
          txs.length ? txs.map((t) => transactionLine(t, currencyName)).join('\n') : '*Aucune opération pour l’instant.*',
        );
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }, getService),
  };

  const boutique: SlashCommand = {
    data: base('boutique', 'Les articles en vente sur ce serveur'),
    execute: guildOnly(async (i, eco) => {
      const { currencyName } = eco.getSettings(i.guildId);
      const items = eco.listItems(i.guildId);
      const embed = new EmbedBuilder().setColor(ECONOMY_COLOR).setTitle('🛒 Boutique');
      if (items.length === 0) embed.setDescription('*La boutique est vide pour le moment.*');
      for (const item of items.slice(0, 25)) {
        embed.addFields({
          name: `${item.name} — ${formatAmount(item.price, currencyName)}`,
          value: [
            item.description ? escapeMarkdown(item.description) : null,
            `\`/acheter article:${item.key}\`${item.stackable ? '' : ' · exemplaire unique'}`,
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }
      await i.reply({ embeds: [embed] });
    }, getService),
  };

  const acheter: SlashCommand = {
    data: base('acheter', 'Achète un article de la boutique')
      .addStringOption((o) =>
        o.setName('article').setDescription('Article à acheter').setRequired(true).setAutocomplete(true),
      )
      .addIntegerOption((o) =>
        o.setName('quantite').setDescription('Quantité (1 par défaut)').setMinValue(1).setMaxValue(MAX_PURCHASE_QUANTITY),
      ),
    execute: guildOnly(async (i, eco) => {
      const r = eco.buy(i.guildId, i.user.id, i.options.getString('article', true), i.options.getInteger('quantite') ?? 1);
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName } = eco.getSettings(i.guildId);
      const { item, quantity, total, balance } = r.value;
      await replyEphemeral(
        i,
        `🛒 Tu as acheté **${quantity} × ${escapeMarkdown(item.name)}** pour ${formatAmount(total, currencyName)}.\n` +
          `Nouveau solde : ${formatAmount(balance, currencyName)}`,
      );
    }, getService),
    async autocomplete(interaction: AutocompleteInteraction) {
      if (!interaction.guildId) return interaction.respond([]);
      const eco = getService();
      const query = interaction.options.getFocused().toLowerCase();
      const { currencyName } = eco.getSettings(interaction.guildId);
      const choices = eco
        .listItems(interaction.guildId)
        .filter((it) => it.key.includes(query) || it.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((it) => ({ name: `${it.name} — ${formatAmount(it.price, currencyName)}`.slice(0, 100), value: it.key }));
      await interaction.respond(choices);
    },
  };

  const inventaire: SlashCommand = {
    data: base('inventaire', 'Affiche ton inventaire ou celui d’un membre').addUserOption((o) =>
      o.setName('membre').setDescription('Membre à consulter'),
    ),
    execute: guildOnly(async (i, eco) => {
      const user = i.options.getUser('membre') ?? i.user;
      if (await rejectBot(i, user)) return;
      const items = eco.inventory(i.guildId, user.id);
      const embed = new EmbedBuilder()
        .setColor(ECONOMY_COLOR)
        .setAuthor({ name: `Inventaire de ${user.displayName}`, iconURL: user.displayAvatarURL() })
        .setDescription(
          items.length
            ? items.map((it) => `• **${escapeMarkdown(it.name)}** × ${it.quantity}`).join('\n')
            : '*Inventaire vide.*',
        );
      await i.reply({ embeds: [embed] });
    }, getService),
  };

  return [solde, daily, virer, classement, historique, boutique, acheter, inventaire];
}
