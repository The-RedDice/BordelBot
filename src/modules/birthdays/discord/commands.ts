import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import { replyEphemeral } from '../../../core/replies.js';
import { daysUntil, formatBirthday, isValidBirthday, localTime, MONTHS } from '../dates.js';
import type { BirthdayDeps } from './runner.js';

export const BIRTHDAY_COLOR = 0xeb459e;
export const UPCOMING_SHOWN = 10;

export function inDaysText(days: number): string {
  if (days === 0) return '**aujourd’hui** 🎉';
  if (days === 1) return 'demain';
  return `dans ${days} jours`;
}

/**
 * `/anniversaire` : chaque membre enregistre (ou retire) sa date, sans l'année.
 * L'annonce, le rôle du jour et le bonus se règlent dans `/config` → Anniversaires.
 */
export function createBirthdayCommand(deps: BirthdayDeps): SlashCommand {
  const service = () => deps.getService();
  return {
    data: new SlashCommandBuilder()
      .setName('anniversaire')
      .setDescription('Anniversaires des membres du serveur')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) =>
        s
          .setName('definir')
          .setDescription('Enregistre ta date d’anniversaire (sans l’année)')
          .addIntegerOption((o) => o.setName('jour').setDescription('Jour (1 à 31)').setRequired(true).setMinValue(1).setMaxValue(31))
          .addIntegerOption((o) =>
            o
              .setName('mois')
              .setDescription('Mois')
              .setRequired(true)
              .addChoices(...MONTHS.map((name, i) => ({ name, value: i + 1 }))),
          ),
      )
      .addSubcommand((s) => s.setName('supprimer').setDescription('Retire ta date d’anniversaire'))
      .addSubcommand((s) =>
        s
          .setName('voir')
          .setDescription('Date d’anniversaire d’un membre')
          .addUserOption((o) => o.setName('membre').setDescription('Membre (toi par défaut)')),
      )
      .addSubcommand((s) => s.setName('prochains').setDescription('Les prochains anniversaires du serveur')),
    async execute(i) {
      if (!i.inCachedGuild()) return replyEphemeral(i, 'Cette commande s’utilise sur un serveur où je suis présent.');
      const sub = i.options.getSubcommand();

      if (sub === 'definir') {
        const day = i.options.getInteger('jour', true);
        const month = i.options.getInteger('mois', true);
        if (!isValidBirthday(month, day)) return replyEphemeral(i, `Le ${day} ${MONTHS[month - 1]} n’existe pas.`);
        service().setBirthday(i.guildId, i.user.id, month, day);
        const leap = month === 2 && day === 29 ? ' Les années non bissextiles, il sera fêté le 28 février.' : '';
        return replyEphemeral(i, `🎂 Anniversaire enregistré : **${formatBirthday(month, day)}**.${leap}`);
      }

      if (sub === 'supprimer') {
        const removed = service().removeBirthday(i.guildId, i.user.id);
        return replyEphemeral(i, removed ? '🗑️ Ta date d’anniversaire a été retirée.' : 'Tu n’avais pas enregistré de date.');
      }

      const settings = service().getSettings(i.guildId);
      const today = localTime(Date.now(), settings.timezone);

      if (sub === 'voir') {
        const user = i.options.getUser('membre') ?? i.user;
        const b = service().getBirthday(i.guildId, user.id);
        if (!b) {
          return replyEphemeral(
            i,
            user.id === i.user.id ? 'Tu n’as pas enregistré de date : `/anniversaire definir`.' : `${user} n’a pas enregistré de date.`,
          );
        }
        const who = user.id === i.user.id ? 'Ton anniversaire' : `L’anniversaire de ${user}`;
        return replyEphemeral(
          i,
          `🎂 ${who} : **${formatBirthday(b.month, b.day)}** (${inDaysText(daysUntil(b.month, b.day, today))}).`,
        );
      }

      const list = service().upcoming(i.guildId, today, UPCOMING_SHOWN);
      const embed = new EmbedBuilder()
        .setColor(BIRTHDAY_COLOR)
        .setTitle('🎂 Prochains anniversaires')
        .setDescription(
          list.length
            ? list.map((b) => `**${formatBirthday(b.month, b.day)}** · <@${b.userId}> · ${inDaysText(b.inDays)}`).join('\n')
            : '*Aucun anniversaire enregistré. `/anniversaire definir` pour ajouter le tien.*',
        );
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    },
  };
}
