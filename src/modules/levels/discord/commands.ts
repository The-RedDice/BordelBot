import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandBuilder as SubBuilder,
} from 'discord.js';
import type { Subcommand } from '../../../core/commands/types.js';
import { leaderboardEmbed } from '../../../core/leaderboard.js';
import { replyEphemeral } from '../../../core/replies.js';
import { levelInfo, MAX_XP, progressBar } from '../curve.js';
import { applyLevelChange, type LevelDeps } from './effects.js';

export const LEVEL_COLOR = 0x9b59b6;
const TOP_SIZE = 10;

const int = (n: number) => new Intl.NumberFormat('fr-FR').format(n);

/** « 3 h 25 min », « 12 min ». */
export function formatVoiceTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${int(h)} h ${m} min` : `${m} min`;
}

type GuildInteraction = ChatInputCommandInteraction<'cached' | 'raw'>;

function guildOnly(handler: (i: GuildInteraction) => Promise<void>) {
  return async (i: ChatInputCommandInteraction): Promise<void> => {
    if (!i.inGuild()) return replyEphemeral(i, 'Cette commande s’utilise sur un serveur.');
    return handler(i);
  };
}

export function createLevelCommands(deps: LevelDeps): Subcommand[] {
  const service = () => deps.getService();

  const niveau: Subcommand = {
    parent: 'profil',
    data: new SlashCommandSubcommandBuilder()
      .setName('niveau')
      .setDescription('Niveau, XP et activité d’un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Membre à consulter')),
    execute: guildOnly(async (i) => {
      const user = i.options.getUser('membre') ?? i.user;
      if (user.bot) return replyEphemeral(i, 'Les bots ne gagnent pas d’XP.');
      const m = service().member(i.guildId, user.id);
      const info = levelInfo(m.xp);
      const next = service()
        .getRoleRewards(i.guildId)
        .find((r) => r.level > info.level);
      const embed = new EmbedBuilder()
        .setColor(LEVEL_COLOR)
        .setAuthor({ name: `Niveau de ${user.displayName}`, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL({ size: 128 }))
        .setDescription(
          [
            `## Niveau ${info.level}`,
            `${progressBar(info.into / info.needed)} ${Math.floor((info.into / info.needed) * 100)} %`,
            `**${int(info.into)}** / ${int(info.needed)} XP vers le niveau ${info.level + 1}`,
          ].join('\n'),
        )
        .addFields(
          { name: '✨ XP total', value: int(m.xp), inline: true },
          { name: '🏅 Rang', value: m.rank ? `${m.rank}ᵉ` : '—', inline: true },
          { name: '💬 Messages', value: int(m.messages), inline: true },
          { name: '🎙️ Vocal', value: formatVoiceTime(m.voiceSeconds), inline: true },
        );
      if (next) embed.addFields({ name: '🎯 Prochaine récompense', value: `<@&${next.roleId}> au niveau ${next.level}`, inline: true });
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }),
  };

  const top: Subcommand = {
    parent: 'top',
    data: new SlashCommandSubcommandBuilder().setName('niveaux').setDescription('Les membres les plus actifs (XP)'),
    execute: guildOnly(async (i) => {
      const fmt = (xp: number) => `niveau ${levelInfo(xp).level} · ${int(xp)} XP`;
      const own = service().member(i.guildId, i.user.id);
      const embed = leaderboardEmbed({
        title: '✨ Classement des niveaux',
        color: LEVEL_COLOR,
        rows: service()
          .leaderboard(i.guildId, TOP_SIZE)
          .map((r) => ({ userId: r.userId, value: fmt(r.xp) })),
        empty: 'Personne n’a encore gagné d’XP : discutez !',
        viewerRank: own.rank,
        viewerValue: fmt(own.xp),
      });
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }),
  };

  const amount = (sub: SubBuilder, description: string, min: number) =>
    sub
      .setDescription(description)
      .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
      .addIntegerOption((o) => o.setName('montant').setDescription('Quantité d’XP').setRequired(true).setMinValue(min).setMaxValue(MAX_XP));

  const admin: Subcommand = {
    parent: 'admin',
    data: new SlashCommandSubcommandGroupBuilder()
      .setName('xp')
      .setDescription('Modifier l’XP d’un membre (rôles de niveau mis à jour)')
      .addSubcommand((s) => amount(s.setName('ajouter'), 'Ajoute de l’XP à un membre', 1))
      .addSubcommand((s) => amount(s.setName('retirer'), 'Retire de l’XP à un membre', 1))
      .addSubcommand((s) => amount(s.setName('definir'), 'Fixe l’XP total d’un membre (0 pour le remettre à zéro)', 0)),
    execute: guildOnly(async (i) => {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return replyEphemeral(i, 'Il te faut la permission « Gérer le serveur ».');
      }
      const user = i.options.getUser('membre', true);
      if (user.bot) return replyEphemeral(i, 'Les bots ne gagnent pas d’XP.');
      const n = i.options.getInteger('montant', true);
      const sub = i.options.getSubcommand();
      const change =
        sub === 'definir'
          ? service().setXp(i.guildId, user.id, n)
          : service().adjustXp(i.guildId, user.id, sub === 'retirer' ? -n : n);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (i.inCachedGuild()) await applyLevelChange(deps, i.guild, change, { announce: false });
      const levelText =
        change.levelAfter === change.levelBefore
          ? `niveau ${change.levelAfter}`
          : `niveau ${change.levelBefore} → **${change.levelAfter}**`;
      await i.editReply({
        content: `✅ ${user} : ${int(change.xpBefore)} → **${int(change.xpAfter)} XP** (${levelText}).`,
        allowedMentions: { parse: [] },
      });
    }),
  };

  return [niveau, top, admin];
}
