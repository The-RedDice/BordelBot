import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { privateView, publicSummary } from '../src/modules/games/wordle/command.js';
import {
  computeStreaks,
  dailyWord,
  normalizeGuess,
  scoreGuess,
  squares,
  wordDate,
} from '../src/modules/games/wordle/wordle.js';
import { WordleService } from '../src/modules/games/wordle/WordleService.js';
import { ANSWERS } from '../src/modules/games/wordle/words.js';

const G = 'g';
// 26 novembre 2026, 12 h à Paris.
const NOON = Date.UTC(2026, 10, 26, 11, 0);

describe('règles', () => {
  it('la liste de mots est propre : 5 lettres a-z, sans doublon', () => {
    for (const w of ANSWERS) expect(w, w).toMatch(/^[a-z]{5}$/);
    expect(new Set(ANSWERS).size).toBe(ANSWERS.length);
    expect(ANSWERS.length).toBeGreaterThan(300);
  });

  it('normalise les propositions', () => {
    expect(normalizeGuess(' Cœur ')).toBe('coeur');
    expect(normalizeGuess('ÉCOLE')).toBe('ecole');
    expect(normalizeGuess('zèbre')).toBe('zebre');
    for (const bad of ['chat', 'chiens', 'ab-cd', 'a b c']) expect(normalizeGuess(bad), bad).toBeNull();
  });

  it('colore comme Wordle, lettres doubles comprises', () => {
    expect(squares(scoreGuess('coeur', 'coeur'))).toBe('🟩🟩🟩🟩🟩');
    expect(scoreGuess('route', 'outre')).toEqual(['present', 'present', 'present', 'present', 'correct']);
    // « lever » contre « pelle » : L présent, 1er E bien placé, 2e E présent (pelle en a deux), V et R absents.
    expect(scoreGuess('lever', 'pelle')).toEqual(['present', 'correct', 'absent', 'present', 'absent']);
    // Deux A proposés, un seul dans le mot : le second est absent.
    expect(scoreGuess('maman', 'magie')).toEqual(['correct', 'correct', 'absent', 'absent', 'absent']);
  });

  it('même mot pour tout un serveur un jour donné, différent le lendemain ou ailleurs', () => {
    const a = dailyWord(G, '2026-11-26');
    expect(dailyWord(G, '2026-11-26')).toBe(a);
    expect(ANSWERS).toContain(a);
    const others = new Set(['2026-11-27', '2026-11-28', '2026-11-29'].map((d) => dailyWord(G, d)));
    others.add(dailyWord('autre', '2026-11-26'));
    expect(others.size).toBeGreaterThan(1);
  });

  it('change de jour à minuit, heure de Paris', () => {
    expect(wordDate(Date.UTC(2026, 10, 26, 22, 59))).toBe('2026-11-26');
    expect(wordDate(Date.UTC(2026, 10, 26, 23, 0))).toBe('2026-11-27');
  });

  it('calcule les séries', () => {
    expect(computeStreaks([], '2026-11-26')).toEqual({ current: 0, best: 0 });
    expect(computeStreaks(['2026-11-24', '2026-11-25'], '2026-11-26')).toEqual({ current: 2, best: 2 });
    expect(computeStreaks(['2026-11-24', '2026-11-25', '2026-11-26'], '2026-11-26')).toEqual({ current: 3, best: 3 });
    expect(computeStreaks(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-24'], '2026-11-26')).toEqual({ current: 0, best: 3 });
    expect(computeStreaks(['2026-12-31', '2027-01-01'], '2027-01-02').current).toBe(2);
  });
});

describe('WordleService', () => {
  let db: Db;
  let now: number;
  let svc: WordleService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    now = NOON;
    svc = new WordleService(db, () => now);
  });

  afterEach(() => db.close());

  const wrong = (answer: string) => ANSWERS.find((w) => w !== answer && ![...w].some((l) => answer.includes(l))) ?? 'xxxxx';

  it('enregistre les essais et termine quand le mot est trouvé', () => {
    const answer = svc.answer(G);
    const r1 = svc.guess(G, 'u', 'zzzzz');
    expect(r1.ok && r1.justFinished).toBe(false);
    expect(svc.guess(G, 'u', 'ZZZZZ')).toEqual({ ok: false, reason: 'Tu as déjà proposé « ZZZZZ ».' });
    const r2 = svc.guess(G, 'u', answer.toUpperCase());
    expect(r2.ok && r2.justFinished && r2.game.solved).toBe(true);
    expect(svc.guess(G, 'u', 'aaaaa')).toEqual({ ok: false, reason: 'Tu as déjà trouvé le mot du jour !' });
    expect(svc.stats(G, 'u')).toEqual({ played: 1, won: 1, current: 1, best: 1 });
  });

  it('termine après 6 essais ratés, et la série repart de zéro', () => {
    const answer = svc.answer(G);
    svc.guess(G, 'u', answer);
    now += 86_400_000;
    const tomorrow = svc.answer(G);
    let last;
    for (const w of ['aaaaa', 'bbbbb', 'ccccc', 'ddddd', 'eeeee', wrong(tomorrow)]) last = svc.guess(G, 'u', w);
    expect(last?.ok && last.justFinished && !last.game.solved).toBe(true);
    expect(svc.guess(G, 'u', tomorrow)).toEqual({ ok: false, reason: 'Tu as utilisé tous tes essais pour aujourd’hui.' });
    expect(svc.stats(G, 'u')).toEqual({ played: 2, won: 1, current: 1, best: 1 });
    now += 2 * 86_400_000;
    expect(svc.stats(G, 'u').current).toBe(0);
  });

  it('refuse ce qui n’est pas un mot de 5 lettres', () => {
    expect(svc.guess(G, 'u', 'chat').ok).toBe(false);
    expect(svc.game(G, 'u').guesses).toEqual([]);
  });

  it('montre les lettres en privé, seulement les couleurs en public', () => {
    const answer = svc.answer(G);
    svc.guess(G, 'u', 'zzzzz');
    const r = svc.guess(G, 'u', answer);
    if (!r.ok) throw new Error(r.reason);
    const stats = svc.stats(G, 'u');
    expect(privateView(r.game, answer, stats)).toContain(answer.toUpperCase().split('').join(' '));
    const pub = publicSummary('u', r.game, answer, stats);
    expect(pub).toContain('**2/6**');
    expect(pub.toLowerCase()).not.toContain(answer);
  });
});
