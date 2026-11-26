import {
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type SlashCommandIntegerOption,
} from 'discord.js';
import type { Subcommand } from '../../../core/commands/types.js';
import { formatDuration, parseDuration } from '../../../core/duration.js';
import { replyEphemeral } from '../../../core/replies.js';
import { transactionsCsv } from '../csv.js';
import { formatAmount, MAX_AMOUNT, MAX_EXPORT_ROWS, type EconomyService } from '../EconomyService.js';
import { errorText } from './format.js';

/**
 * `/admin solde|boutique|export` : réservé par défaut aux membres ayant « Gérer le serveur »
 * (permission de la parente `/admin`, vérifiée à nouveau à l'exécution).
 */
export function createEconomyAdminCommands(getService: () => EconomyService): Subcommand[] {
  const amountOption = (min: number) => (o: SlashCommandIntegerOption) =>
    o.setName('montant').setDescription('Montant').setRequired(true).setMinValue(min).setMaxValue(MAX_AMOUNT);

  const solde = new SlashCommandSubcommandGroupBuilder()
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
    );

  const boutique = new SlashCommandSubcommandGroupBuilder()
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
        .setName('role')
        .setDescription('Met un rôle en vente, temporaire ou permanent (modifie l’article de même clé)')
        .addStringOption((o) =>
          o.setName('cle').setDescription('Identifiant : minuscules, chiffres, tirets').setRequired(true).setMaxLength(32),
        )
        .addStringOption((o) => o.setName('nom').setDescription('Nom affiché').setRequired(true).setMaxLength(64))
        .addIntegerOption((o) =>
          o.setName('prix').setDescription('Prix').setRequired(true).setMinValue(0).setMaxValue(MAX_AMOUNT),
        )
        .addRoleOption((o) => o.setName('role').setDescription('Rôle attribué à l’achat').setRequired(true))
        .addStringOption((o) =>
          o.setName('duree').setDescription('Durée : 7j, 12h, 2sem… ; vide = permanent').setMaxLength(32),
        )
        .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retire un article de la vente (les inventaires sont conservés)')
        .addStringOption((o) => o.setName('cle').setDescription('Clé de l’article').setRequired(true).setMaxLength(32)),
    );

  const exportData = new SlashCommandSubcommandBuilder()
    .setName('export')
    .setDescription(`Exporte le journal des opérations en CSV (${MAX_EXPORT_ROWS} dernières au plus)`)
    .addUserOption((o) => o.setName('membre').setDescription('Uniquement les opérations de ce membre'));

  async function execute(i: ChatInputCommandInteraction): Promise<void> {
    if (!i.inGuild()) return replyEphemeral(i, 'Cette commande s’utilise sur un serveur.');
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return replyEphemeral(i, 'Il te faut la permission « Gérer le serveur ».');
    }
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
      if (sub === 'role') {
        const role = i.options.getRole('role', true);
        if (role.id === i.guildId || ('managed' in role && role.managed)) {
          return replyEphemeral(i, 'Ce rôle ne peut pas être vendu (rôle géré par une intégration, ou @everyone).');
        }
        const cached = i.guild?.roles.cache.get(role.id);
        if (cached && !cached.editable) {
          return replyEphemeral(i, `Je ne peux pas attribuer ${role} : il me faut « Gérer les rôles » et un rôle placé au-dessus de lui.`);
        }
        const rawDuration = i.options.getString('duree');
        const roleDurationMs = rawDuration === null || !rawDuration.trim() ? null : parseDuration(rawDuration);
        if (rawDuration !== null && rawDuration.trim() && roleDurationMs === null) {
          return replyEphemeral(i, 'Durée invalide. Exemples : `12h`, `7j`, `2sem` ; laisse vide pour un rôle permanent.');
        }
        const r = eco.upsertItem(guildId, {
          key,
          name: i.options.getString('nom', true),
          description: i.options.getString('description') ?? '',
          price: i.options.getInteger('prix', true),
          roleId: role.id,
          roleDurationMs,
        });
        if (!r.ok) return replyEphemeral(i, errorText(r.error));
        const { currencyName } = eco.getSettings(guildId);
        return replyEphemeral(
          i,
          `✅ Rôle ${role} en vente sous \`${r.value.key}\` : ${formatAmount(r.value.price, currencyName)}, ` +
            `${roleDurationMs === null ? 'permanent' : `pour ${formatDuration(roleDurationMs)} (un rachat prolonge)`}.`,
        );
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

    // export
    const member = i.options.getUser('membre');
    const rows = eco.exportTransactions(guildId, member?.id ?? null);
    if (rows.length === 0) return replyEphemeral(i, 'Aucune opération à exporter.');
    const date = new Date().toISOString().slice(0, 10);
    const file = new AttachmentBuilder(Buffer.from(transactionsCsv(rows), 'utf8'), {
      name: `transactions-${member ? member.username : 'serveur'}-${date}.csv`,
    });
    const truncated = rows.length >= MAX_EXPORT_ROWS ? ` (limité aux ${MAX_EXPORT_ROWS} plus récentes)` : '';
    await i.reply({
      content: `📄 ${rows.length} opération(s)${member ? ` de ${member}` : ''}${truncated}.`,
      files: [file],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  return [
    { parent: 'admin', data: solde, execute },
    { parent: 'admin', data: boutique, execute },
    { parent: 'admin', data: exportData, execute },
  ];
}
