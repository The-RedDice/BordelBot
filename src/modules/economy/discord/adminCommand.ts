import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type SlashCommandIntegerOption,
} from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import { replyEphemeral } from '../../../core/replies.js';
import { formatAmount, MAX_AMOUNT, type EconomyService, type GuildEconomySettings } from '../EconomyService.js';
import { errorText } from './format.js';

/**
 * `/eco-admin` : réservé par défaut aux membres ayant « Gérer le serveur ».
 * Les admins du serveur peuvent ajuster cet accès dans Intégrations > Commandes.
 */
export function createEconomyAdminCommand(getService: () => EconomyService): SlashCommand {
  const amountOption = (min: number) => (o: SlashCommandIntegerOption) =>
    o.setName('montant').setDescription('Montant').setRequired(true).setMinValue(min).setMaxValue(MAX_AMOUNT);

  const data = new SlashCommandBuilder()
    .setName('eco-admin')
    .setDescription('Administration de l’économie')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup((g) =>
      g
        .setName('solde')
        .setDescription('Modifier le solde d’un membre')
        .addSubcommand((s) =>
          s
            .setName('ajouter')
            .setDescription('Ajoute de l’argent à un membre')
            .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
            .addIntegerOption(amountOption(1))
            .addStringOption((o) => o.setName('raison').setDescription('Motif (visible dans son historique)').setMaxLength(200)),
        )
        .addSubcommand((s) =>
          s
            .setName('retirer')
            .setDescription('Retire de l’argent à un membre (sans passer sous zéro)')
            .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
            .addIntegerOption(amountOption(1))
            .addStringOption((o) => o.setName('raison').setDescription('Motif (visible dans son historique)').setMaxLength(200)),
        )
        .addSubcommand((s) =>
          s
            .setName('definir')
            .setDescription('Fixe le solde exact d’un membre')
            .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
            .addIntegerOption(amountOption(0))
            .addStringOption((o) => o.setName('raison').setDescription('Motif (visible dans son historique)').setMaxLength(200)),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('boutique')
        .setDescription('Gérer les articles en vente')
        .addSubcommand((s) =>
          s
            .setName('ajouter')
            .setDescription('Crée un article, ou modifie celui qui a la même clé')
            .addStringOption((o) =>
              o.setName('cle').setDescription('Identifiant : minuscules, chiffres, tirets').setRequired(true).setMaxLength(32),
            )
            .addStringOption((o) => o.setName('nom').setDescription('Nom affiché').setRequired(true).setMaxLength(64))
            .addIntegerOption((o) =>
              o.setName('prix').setDescription('Prix').setRequired(true).setMinValue(0).setMaxValue(MAX_AMOUNT),
            )
            .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(200))
            .addBooleanOption((o) =>
              o.setName('cumulable').setDescription('Peut-on en posséder plusieurs ? (oui par défaut)'),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('retirer')
            .setDescription('Retire un article de la vente (les inventaires sont conservés)')
            .addStringOption((o) => o.setName('cle').setDescription('Clé de l’article').setRequired(true).setMaxLength(32)),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('config')
        .setDescription('Affiche ou modifie les réglages (sans option : affiche)')
        .addStringOption((o) => o.setName('monnaie').setDescription('Nom de la monnaie').setMaxLength(32))
        .addIntegerOption((o) =>
          o.setName('daily').setDescription('Montant du daily (0 = désactivé)').setMinValue(0).setMaxValue(MAX_AMOUNT),
        )
        .addIntegerOption((o) =>
          o
            .setName('recompense')
            .setDescription('Récompense de base par victoire (0 = désactivée)')
            .setMinValue(0)
            .setMaxValue(MAX_AMOUNT),
        ),
    );

  const describeSettings = (s: GuildEconomySettings) =>
    [
      `**Monnaie :** ${escapeMarkdown(s.currencyName)}`,
      `**Daily :** ${s.dailyAmount ? formatAmount(s.dailyAmount, s.currencyName) : 'désactivé'}`,
      `**Récompense de victoire :** ${s.gameWinReward ? formatAmount(s.gameWinReward, s.currencyName) : 'désactivée'}` +
        ' (×3 max pour un camp minoritaire)',
    ].join('\n');

  async function execute(i: ChatInputCommandInteraction): Promise<void> {
    if (!i.inGuild()) return replyEphemeral(i, 'Cette commande s’utilise sur un serveur.');
    const eco = getService();
    const guildId = i.guildId;
    const group = i.options.getSubcommandGroup();
    const sub = i.options.getSubcommand();

    if (group === 'solde') {
      const user = i.options.getUser('membre', true);
      if (user.bot) return replyEphemeral(i, 'Les bots n’ont pas de compte.');
      const amount = i.options.getInteger('montant', true);
      const reason = i.options.getString('raison');
      const r =
        sub === 'definir'
          ? eco.setBalance(guildId, user.id, amount, i.user.id, reason)
          : eco.adjustBalance(guildId, user.id, sub === 'retirer' ? -amount : amount, i.user.id, reason);
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName } = eco.getSettings(guildId);
      return replyEphemeral(i, `✅ Nouveau solde de ${user} : **${formatAmount(r.value, currencyName)}**.`);
    }

    if (group === 'boutique') {
      const key = i.options.getString('cle', true);
      if (sub === 'retirer') {
        const r = eco.disableItem(guildId, key);
        return replyEphemeral(i, r.ok ? `✅ Article \`${key}\` retiré de la vente.` : errorText(r.error));
      }
      const r = eco.upsertItem(guildId, {
        key,
        name: i.options.getString('nom', true),
        description: i.options.getString('description') ?? '',
        price: i.options.getInteger('prix', true),
        stackable: i.options.getBoolean('cumulable') ?? true,
      });
      if (!r.ok) return replyEphemeral(i, errorText(r.error));
      const { currencyName } = eco.getSettings(guildId);
      return replyEphemeral(
        i,
        `✅ Article \`${r.value.key}\` en vente : **${escapeMarkdown(r.value.name)}** à ${formatAmount(r.value.price, currencyName)}.`,
      );
    }

    // config
    const patch: { currencyName?: string; dailyAmount?: number; gameWinReward?: number } = {};
    const monnaie = i.options.getString('monnaie');
    const daily = i.options.getInteger('daily');
    const recompense = i.options.getInteger('recompense');
    if (monnaie !== null) patch.currencyName = monnaie;
    if (daily !== null) patch.dailyAmount = daily;
    if (recompense !== null) patch.gameWinReward = recompense;
    if (Object.keys(patch).length === 0) return replyEphemeral(i, describeSettings(eco.getSettings(guildId)));
    const r = eco.updateSettings(guildId, patch);
    return replyEphemeral(i, r.ok ? `✅ Réglages mis à jour.\n${describeSettings(r.value)}` : errorText(r.error));
  }

  return { data, execute };
}
