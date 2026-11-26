import { EmbedBuilder, MessageFlags, escapeMarkdown, type AutocompleteInteraction } from 'discord.js';
import type { Subcommand } from '../../../core/commands/types.js';
import { relativeTime, replyEphemeral } from '../../../core/replies.js';
import { formatAmount, MAX_AMOUNT, MAX_PURCHASE_QUANTITY } from '../EconomyService.js';
import type { GetServices } from '../services.js';
import { achievementLines, ECONOMY_COLOR, errorText, transactionLine } from './format.js';
import { guildOnly, rejectBot, subcommand } from './helpers.js';
import { HEIST_COOLDOWN_MS, HEIST_TARGET_PROTECTION_MS } from '../heist/HeistService.js';
import { buyRoleItem, grantLine, roleDurationText } from './roles.js';

export function createEconomyCommands(getService: GetServices): Subcommand[] {
  const solde: Subcommand = {
    parent: 'eco',
    data: subcommand('solde', 'Affiche ton solde ou celui d’un membre').addUserOption((o) =>
      o.setName('membre').setDescription('Membre à consulter'),
    ),
    execute: guildOnly(async (i, { eco }) => {
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

  const daily: Subcommand = {
    parent: 'eco',
    data: subcommand('daily', 'Récupère ta récompense quotidienne'),
    execute: guildOnly(async (i, { eco, progress }) => {
      const r = eco.claimDaily(i.guildId, i.user.id);
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName } = eco.getSettings(i.guildId);
      const { amount, bonus, streak, nextAt } = r.value;
      const unlocked = progress.record(i.guildId, i.user.id, [{ stat: 'daily_best_streak', max: streak }]);
      // Relu après `record` : un succès débloqué a pu verser une récompense.
      const balance = eco.getBalance(i.guildId, i.user.id);
      const lines = [
        `🎁 Tu reçois **${formatAmount(amount, currencyName)}** !`,
        streak > 1 ? `🔥 Série de ${streak} jours (bonus : ${formatAmount(bonus, currencyName)})` : null,
        `Nouveau solde : ${formatAmount(balance, currencyName)} · prochaine récompense ${relativeTime(nextAt)}`,
        ...achievementLines(unlocked, currencyName),
      ];
      await i.reply({ content: lines.filter(Boolean).join('\n') });
    }, getService),
  };

  const virer: Subcommand = {
    parent: 'eco',
    data: subcommand('virer', 'Envoie de l’argent à un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Destinataire').setRequired(true))
      .addIntegerOption((o) =>
        o.setName('montant').setDescription('Montant à envoyer').setRequired(true).setMinValue(1).setMaxValue(MAX_AMOUNT),
      ),
    execute: guildOnly(async (i, { eco, progress }) => {
      const target = i.options.getUser('membre', true);
      if (await rejectBot(i, target)) return;
      const r = eco.transfer(i.guildId, i.user.id, target.id, i.options.getInteger('montant', true));
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName } = eco.getSettings(i.guildId);
      const unlocked = progress.record(i.guildId, i.user.id, [{ stat: 'transferred_total', add: r.value.amount }]);
      await i.reply({
        content: [
          `💸 ${i.user} a envoyé **${formatAmount(r.value.amount, currencyName)}** à ${target}.`,
          `Ton nouveau solde : ${formatAmount(eco.getBalance(i.guildId, i.user.id), currencyName)}`,
          ...achievementLines(unlocked, currencyName),
        ].join('\n'),
        allowedMentions: { users: [target.id] },
      });
    }, getService),
  };

  const historique: Subcommand = {
    parent: 'eco',
    data: subcommand('historique', 'Tes dernières opérations'),
    execute: guildOnly(async (i, { eco }) => {
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

  const boutique: Subcommand = {
    parent: 'boutique',
    data: subcommand('voir', 'Les articles en vente sur ce serveur'),
    execute: guildOnly(async (i, { eco }) => {
      const { currencyName } = eco.getSettings(i.guildId);
      const items = eco.listItems(i.guildId);
      const embed = new EmbedBuilder().setColor(ECONOMY_COLOR).setTitle('🛒 Boutique');
      if (items.length === 0) embed.setDescription('*La boutique est vide pour le moment.*');
      for (const item of items.slice(0, 25)) {
        embed.addFields({
          name: `${item.name} — ${formatAmount(item.price, currencyName)}`,
          value: [
            item.description ? escapeMarkdown(item.description) : null,
            item.roleId
              ? `🎭 Rôle <@&${item.roleId}> · ${roleDurationText(item)} · \`/boutique acheter article:${item.key}\``
              : `\`/boutique acheter article:${item.key}\`${item.stackable ? '' : ' · exemplaire unique'}`,
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }
      await i.reply({ embeds: [embed] });
    }, getService),
  };

  const acheter: Subcommand = {
    parent: 'boutique',
    data: subcommand('acheter', 'Achète un article de la boutique')
      .addStringOption((o) =>
        o.setName('article').setDescription('Article à acheter').setRequired(true).setAutocomplete(true),
      )
      .addIntegerOption((o) =>
        o.setName('quantite').setDescription('Quantité (1 par défaut)').setMinValue(1).setMaxValue(MAX_PURCHASE_QUANTITY),
      ),
    execute: guildOnly(async (i, { eco }) => {
      const key = i.options.getString('article', true);
      const roleItem = eco.getItem(i.guildId, key.trim().toLowerCase());
      if (roleItem?.roleId && roleItem.enabled) {
        if (!i.inCachedGuild()) return replyEphemeral(i, 'Je dois être présent sur ce serveur pour attribuer un rôle.');
        return replyEphemeral(i, await buyRoleItem(i.guild, i.member, roleItem, getService));
      }
      const r = eco.buy(i.guildId, i.user.id, key, i.options.getInteger('quantite') ?? 1);
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
      const { eco } = getService();
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

  const inventaire: Subcommand = {
    parent: 'boutique',
    data: subcommand('inventaire', 'Affiche ton inventaire ou celui d’un membre').addUserOption((o) =>
      o.setName('membre').setDescription('Membre à consulter'),
    ),
    execute: guildOnly(async (i, { eco, roleShop }) => {
      const user = i.options.getUser('membre') ?? i.user;
      if (await rejectBot(i, user)) return;
      const items = eco.inventory(i.guildId, user.id);
      const roles = roleShop.grants(i.guildId, user.id);
      const lines = [
        ...items.map((it) => `• **${escapeMarkdown(it.name)}** × ${it.quantity}`),
        ...(roles.length ? [...(items.length ? [''] : []), '**Rôles achetés**', ...roles.map(grantLine)] : []),
      ];
      const embed = new EmbedBuilder()
        .setColor(ECONOMY_COLOR)
        .setAuthor({ name: `Inventaire de ${user.displayName}`, iconURL: user.displayAvatarURL() })
        .setDescription(lines.length ? lines.join('\n') : '*Inventaire vide.*');
      await i.reply({ embeds: [embed] });
    }, getService),
  };

  const braquer: Subcommand = {
    parent: 'eco',
    data: subcommand(
      'braquer',
      `Tente de voler un membre (30 à 60 % de réussite) ; raté, tu paies une amende`,
    ).addUserOption((o) => o.setName('membre').setDescription('Ta cible').setRequired(true)),
    execute: guildOnly(async (i, { heists, eco }) => {
      const target = i.options.getUser('membre', true);
      if (await rejectBot(i, target)) return;
      const r = heists.attempt(i.guildId, i.user.id, target.id);
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName: cur } = eco.getSettings(i.guildId);
      const { success, amount, chance, robberBalance } = r.value;
      const odds = `${Math.round(chance * 100)} % de chances`;
      const content = success
        ? `🦹 ${i.user} a braqué ${target} et repart avec **${formatAmount(amount, cur)}** ! (${odds})\n` +
          `Solde : ${formatAmount(robberBalance, cur)}`
        : `🚨 ${i.user} s’est fait prendre en braquant ${target} : amende de **${formatAmount(amount, cur)}**, versée à la victime. (${odds})`;
      const footer =
        `-# Prochain braquage dans ${HEIST_COOLDOWN_MS / 3_600_000} h ; ` +
        `${target.displayName} est à l’abri pendant ${HEIST_TARGET_PROTECTION_MS / 3_600_000} h.`;
      await i.reply({ content: `${content}\n${footer}`, allowedMentions: { users: [target.id] } });
    }, getService),
  };

  return [solde, daily, virer, historique, boutique, acheter, inventaire, braquer];
}
