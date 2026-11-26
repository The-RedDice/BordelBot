import { createHash } from 'node:crypto';
import { ANSWERS } from './words.js';

export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;
/** Fuseau du changement de mot (minuit). */
export const WORD_TIMEZONE = 'Europe/Paris';

export type LetterScore = 'correct' | 'present' | 'absent';

const SQUARES: Record<LetterScore, string> = { correct: '🟩', present: '🟨', absent: '⬛' };

/** Minuscules sans accents ni espaces (« Cœur » → « coeur ») ; null si ce ne sont pas 5 lettres. */
export function normalizeGuess(input: string): string | null {
  const word = input
    .trim()
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  return new RegExp(`^[a-z]{${WORD_LENGTH}}$`).test(word) ? word : null;
}

/**
 * Couleur de chaque lettre, comme Wordle : une lettre en double n'est signalée
 * « présente » qu'autant de fois qu'elle figure dans le mot.
 */
export function scoreGuess(guess: string, answer: string): LetterScore[] {
  const result: LetterScore[] = Array<LetterScore>(guess.length).fill('absent');
  const remaining = new Map<string, number>();
  for (let i = 0; i < answer.length; i++) {
    if (guess[i] === answer[i]) result[i] = 'correct';
    else remaining.set(answer[i]!, (remaining.get(answer[i]!) ?? 0) + 1);
  }
  for (let i = 0; i < guess.length; i++) {
    if (result[i] === 'correct') continue;
    const left = remaining.get(guess[i]!) ?? 0;
    if (left > 0) {
      result[i] = 'present';
      remaining.set(guess[i]!, left - 1);
    }
  }
  return result;
}

export const squares = (scores: readonly LetterScore[]): string => scores.map((s) => SQUARES[s]).join('');

/** Ligne avec les lettres, pour le joueur seulement : `🟩🟨⬛⬛🟩 · C O E U R`. */
export const guessLine = (guess: string, answer: string): string =>
  `${squares(scoreGuess(guess, answer))} · ${guess.toUpperCase().split('').join(' ')}`;

/** Mot du jour d'un serveur : le même pour tous ses membres, différent d'un serveur à l'autre. */
export function dailyWord(guildId: string, date: string, answers: readonly string[] = ANSWERS): string {
  const digest = createHash('sha256').update(`${guildId}:${date}`).digest();
  return answers[digest.readUInt32BE(0) % answers.length]!;
}

/** Jour local (AAAA-MM-JJ) dans le fuseau du mot du jour. */
export function wordDate(at: number, timeZone = WORD_TIMEZONE): string {
  // en-CA formate directement en AAAA-MM-JJ.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

export interface Streaks {
  /** Jours consécutifs réussis jusqu'à aujourd'hui (ou hier, si le mot du jour n'est pas encore trouvé). */
  readonly current: number;
  readonly best: number;
}

/** Séries à partir des jours réussis (AAAA-MM-JJ, dans n'importe quel ordre). */
export function computeStreaks(solvedDates: readonly string[], today: string): Streaks {
  const days = [...new Set(solvedDates.map(dayNumber))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1]! + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const t = dayNumber(today);
  const last = days[days.length - 1];
  const current = last !== undefined && (last === t || last === t - 1) ? run : 0;
  return { current, best };
}
