import { MessageFlags, SlashCommandSubcommandBuilder } from 'discord.js';
import type { Subcommand } from '../../../core/commands/types.js';
import { replyEphemeral } from '../../../core/replies.js';
import { guessLine, MAX_GUESSES, scoreGuess, squares } from './wordle.js';
import type { WordGame, WordleService, WordStats } from './WordleService.js';

const statsLine = (s: WordStats) =>
  `🔥 Série : **${s.current}** (record ${s.best}) · ${s.won}/${s.played} réussi${s.won > 1 ? 's' : ''}`;

/** Lettres déjà écartées : aide à ne pas les reproposer. */
function absentLetters(game: WordGame, answer: string): string {
  const absent = new Set<string>();
  for (const g of game.guesses) {
    const scores = scoreGuess(g, answer);
    g.split('').forEach((letter, i) => {
      if (scores[i] === 'absent' && !answer.includes(letter)) absent.add(letter.toUpperCase());
    });
  }
  return [...absent].sort().join(' ');
}

/** Grille privée (avec les lettres). */
export function privateView(game: WordGame, answer: string, stats: WordStats): string {
  const lines = [`📝 **Mot du jour** · ${game.guesses.length}/${MAX_GUESSES}`, ''];
  lines.push(...game.guesses.map((g) => guessLine(g, answer)));
  if (game.finished) {
    lines.push('', game.solved ? '🎉 Bravo, tu as trouvé !' : `😔 Raté ! Le mot était **${answer.toUpperCase()}**.`, statsLine(stats));
    lines.push('Nouveau mot à minuit (heure de Paris).');
  } else {
    const absent = absentLetters(game, answer);
    if (absent) lines.push('', `Lettres absentes : ${absent}`);
    lines.push('', `Encore ${MAX_GUESSES - game.guesses.length} essai(s) : \`/jeu mot-du-jour mot:…\``);
  }
  return lines.join('\n');
}

/** Résultat public (sans les lettres, pour ne pas gâcher le mot aux autres). */
export function publicSummary(userId: string, game: WordGame, answer: string, stats: WordStats): string {
  const score = game.solved ? `${game.guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  return [
    game.solved ? `🟩 <@${userId}> a trouvé le mot du jour en **${score}** !` : `⬛ <@${userId}> n’a pas trouvé le mot du jour (${score}).`,
    ...game.guesses.map((g) => squares(scoreGuess(g, answer))),
    statsLine(stats),
  ].join('\n');
}

/**
 * `/jeu mot-du-jour [mot]` : un mot de 5 lettres par jour, le même pour tout le
 * serveur, 6 essais. Les essais restent privés ; le résultat final est publié
 * sans les lettres. Une victoire rapporte la récompense habituelle des parties
 * (via `game:finished`) et compte dans les statistiques.
 */
export function createWordleCommand(getService: () => WordleService): Subcommand {
  return {
    parent: 'jeu',
    data: new SlashCommandSubcommandBuilder()
      .setName('mot-du-jour')
      .setDescription('Devine le mot du jour en 6 essais (le même pour tout le serveur)')
      .addStringOption((o) => o.setName('mot').setDescription('Ta proposition : 5 lettres').setMinLength(5).setMaxLength(12)),
    async execute(i, ctx) {
      if (!i.inGuild()) return replyEphemeral(i, 'Cette commande s’utilise sur un serveur.');
      const service = getService();
      const input = i.options.getString('mot');

      if (input === null) {
        const game = service.game(i.guildId, i.user.id);
        if (game.guesses.length === 0) {
          return replyEphemeral(
            i,
            [
              '📝 **Mot du jour** : trouve le mot de 5 lettres en 6 essais avec `/jeu mot-du-jour mot:…`.',
              '🟩 bonne lettre bien placée · 🟨 lettre présente ailleurs · ⬛ lettre absente',
              'Accents ignorés. Le mot change à minuit (heure de Paris) ; tes essais restent privés.',
              '',
              statsLine(service.stats(i.guildId, i.user.id)),
            ].join('\n'),
          );
        }
        return replyEphemeral(i, privateView(game, service.answer(i.guildId), service.stats(i.guildId, i.user.id)));
      }

      const r = service.guess(i.guildId, i.user.id, input);
      if (!r.ok) return replyEphemeral(i, r.reason);
      const stats = service.stats(i.guildId, i.user.id);
      await i.reply({ content: privateView(r.game, r.answer, stats), flags: MessageFlags.Ephemeral });
      if (!r.justFinished) return;

      await i.followUp({ content: publicSummary(i.user.id, r.game, r.answer, stats), allowedMentions: { parse: [] } });
      // Récompense et statistiques : une « partie » par membre et par jour (idempotent côté économie).
      await ctx.bus.emit('game:finished', {
        sessionId: `wordle:${i.guildId}:${r.game.date}:${i.user.id}`,
        guildId: i.guildId,
        channelId: i.channelId,
        game: 'wordle',
        winnerIds: r.game.solved ? [i.user.id] : [],
        loserIds: r.game.solved ? [] : [i.user.id],
        finishedAt: Date.now(),
      });
    },
  };
}
