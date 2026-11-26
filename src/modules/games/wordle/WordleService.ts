import type { Db } from '../../../core/database/connection.js';
import { computeStreaks, dailyWord, MAX_GUESSES, normalizeGuess, wordDate, type Streaks } from './wordle.js';

export interface WordGame {
  readonly date: string;
  readonly guesses: readonly string[];
  readonly solved: boolean;
  readonly finished: boolean;
}

export type GuessResult =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly game: WordGame;
      readonly answer: string;
      /** Cette proposition termine la partie (trouvé ou dernier essai). */
      readonly justFinished: boolean;
    };

export interface WordStats extends Streaks {
  readonly played: number;
  readonly won: number;
}

/** Parties du mot du jour, une par membre et par jour. Ne parle pas à Discord. */
export class WordleService {
  private readonly stmts;

  constructor(
    db: Db,
    private readonly clock: () => number = Date.now,
  ) {
    this.stmts = {
      get: db.prepare<[string, string, string], { guesses: string; solved: number; finished: number }>(
        'SELECT guesses, solved, finished FROM word_games WHERE guild_id = ? AND user_id = ? AND date = ?',
      ),
      save: db.prepare(
        `INSERT INTO word_games (guild_id, user_id, date, guesses, solved, finished)
         VALUES (@guildId, @userId, @date, @guesses, @solved, @finished)
         ON CONFLICT (guild_id, user_id, date) DO UPDATE SET
           guesses = excluded.guesses, solved = excluded.solved, finished = excluded.finished`,
      ),
      stats: db.prepare<[string, string], { played: number; won: number }>(
        `SELECT COUNT(*) AS played, COALESCE(SUM(solved), 0) AS won FROM word_games
         WHERE guild_id = ? AND user_id = ? AND finished = 1`,
      ),
      solvedDates: db
        .prepare<[string, string], string>('SELECT date FROM word_games WHERE guild_id = ? AND user_id = ? AND solved = 1')
        .pluck(),
    };
  }

  today(): string {
    return wordDate(this.clock());
  }

  answer(guildId: string, date = this.today()): string {
    return dailyWord(guildId, date);
  }

  game(guildId: string, userId: string, date = this.today()): WordGame {
    const row = this.stmts.get.get(guildId, userId, date);
    return row
      ? { date, guesses: JSON.parse(row.guesses) as string[], solved: row.solved === 1, finished: row.finished === 1 }
      : { date, guesses: [], solved: false, finished: false };
  }

  guess(guildId: string, userId: string, input: string): GuessResult {
    const word = normalizeGuess(input);
    if (!word) return { ok: false, reason: 'Propose un mot de 5 lettres (les accents sont ignorés).' };
    const date = this.today();
    const current = this.game(guildId, userId, date);
    if (current.finished) {
      return { ok: false, reason: current.solved ? 'Tu as déjà trouvé le mot du jour !' : 'Tu as utilisé tous tes essais pour aujourd’hui.' };
    }
    if (current.guesses.includes(word)) return { ok: false, reason: `Tu as déjà proposé « ${word.toUpperCase()} ».` };

    const answer = this.answer(guildId, date);
    const guesses = [...current.guesses, word];
    const solved = word === answer;
    const finished = solved || guesses.length >= MAX_GUESSES;
    this.stmts.save.run({
      guildId,
      userId,
      date,
      guesses: JSON.stringify(guesses),
      solved: solved ? 1 : 0,
      finished: finished ? 1 : 0,
    });
    return { ok: true, game: { date, guesses, solved, finished }, answer, justFinished: finished };
  }

  stats(guildId: string, userId: string): WordStats {
    const { played, won } = this.stmts.stats.get(guildId, userId) ?? { played: 0, won: 0 };
    return { played, won, ...computeStreaks(this.stmts.solvedDates.all(guildId, userId), this.today()) };
  }
}
