import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import { nullLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/rng.js';
import { boardText } from '../src/modules/economy/discord/boards.js';
import { roulettePayouts } from '../src/modules/economy/discord/roulette.js';
import { EconomyService } from '../src/modules/economy/EconomyService.js';
import {
  blackjackPayout,
  canDouble,
  deal,
  double,
  handValue,
  hit,
  newShoe,
  stand,
  type Card,
  type Rank,
} from '../src/modules/economy/gambling/blackjack.js';
import { isOver, legalMoves, newBoard, play, type BoardState } from '../src/modules/economy/gambling/boards.js';
import {
  parseBet,
  ROULETTE_NUMBERS,
  rouletteMultiplier,
  type RouletteBet,
} from '../src/modules/economy/gambling/roulette.js';
import { WagerService } from '../src/modules/economy/gambling/WagerService.js';
import { ProgressService } from '../src/modules/economy/progress/ProgressService.js';

const G = 'g';
const cards = (...ranks: Rank[]): Card[] => ranks.map((rank) => ({ rank, suit: '♠' }));

describe('blackjack', () => {
  it('compte les as pour 1 ou 11', () => {
    expect(handValue(cards('A', '6'))).toEqual({ total: 17, soft: true });
    expect(handValue(cards('A', '6', '9'))).toEqual({ total: 16, soft: false });
    expect(handValue(cards('A', 'A', '9'))).toEqual({ total: 21, soft: true });
    expect(handValue(cards('K', 'Q', '5'))).toEqual({ total: 25, soft: false });
  });

  it('règle un blackjack d’entrée, et l’égalité si le croupier en a un aussi', () => {
    // Ordre de distribution : joueur, croupier, joueur, croupier.
    expect(deal(cards('A', '9', 'K', '8')).outcome).toBe('blackjack');
    expect(deal(cards('A', 'A', 'K', 'Q')).outcome).toBe('push');
    expect(deal(cards('9', 'A', '9', 'K')).outcome).toBe('lose');
    expect(deal(cards('9', '9', '9', '8')).outcome).toBeNull();
  });

  it('perd au-delà de 21 et reste automatiquement à 21', () => {
    const s = deal(cards('10', '9', '5', '8', 'K'));
    expect(hit(s).outcome).toBe('lose');
    const auto = hit(deal(cards('10', '9', '5', '8', '6')));
    expect(handValue(auto.player).total).toBe(21);
    expect(auto.outcome).toBe('win'); // croupier à 17, reste
  });

  it('le croupier tire jusqu’à 17 et reste sur un 17 souple', () => {
    const bust = stand(deal(cards('10', '10', '8', '6', 'K')));
    expect(handValue(bust.dealer).total).toBe(26);
    expect(bust.outcome).toBe('win');
    const soft = stand(deal(cards('10', 'A', '7', '6', 'K')));
    expect(soft.dealer).toHaveLength(2);
    expect(soft.outcome).toBe('push');
  });

  it('double : une seule carte, puis le croupier joue', () => {
    const s = deal(cards('5', '10', '6', '7', 'K'));
    expect(canDouble(s)).toBe(true);
    const d = double(s);
    expect(d.player).toHaveLength(3);
    expect(d.doubled).toBe(true);
    expect(d.outcome).toBe('win'); // 21 contre 17
    expect(canDouble(hit(s))).toBe(false);
  });

  it('paie 3:2, 1:1, rembourse l’égalité', () => {
    expect(blackjackPayout('blackjack', 100)).toBe(250);
    expect(blackjackPayout('win', 100)).toBe(200);
    expect(blackjackPayout('push', 100)).toBe(100);
    expect(blackjackPayout('lose', 100)).toBe(0);
  });

  it('mélange un sabot de 6 jeux complet', () => {
    const shoe = newShoe(seededRng(1));
    expect(shoe).toHaveLength(312);
    expect(shoe.filter((c) => c.rank === 'A' && c.suit === '♥')).toHaveLength(6);
  });
});

describe('roulette', () => {
  it('lit les paris', () => {
    expect(parseBet('rouge', null)).toEqual({ kind: 'rouge' });
    expect(parseBet('d2', null)).toEqual({ kind: 'douzaine', n: 2 });
    expect(parseBet('numero', 17)).toEqual({ kind: 'numero', n: 17 });
    expect(parseBet('numero', null)).toBeNull();
    expect(parseBet('numero', 37)).toBeNull();
    expect(parseBet('tout', null)).toBeNull();
  });

  it('paie selon le pari, le zéro fait perdre les chances simples', () => {
    expect(rouletteMultiplier({ kind: 'rouge' }, 1)).toBe(2);
    expect(rouletteMultiplier({ kind: 'noir' }, 1)).toBe(0);
    expect(rouletteMultiplier({ kind: 'pair' }, 0)).toBe(0);
    expect(rouletteMultiplier({ kind: 'manque' }, 18)).toBe(2);
    expect(rouletteMultiplier({ kind: 'passe' }, 18)).toBe(0);
    expect(rouletteMultiplier({ kind: 'douzaine', n: 3 }, 36)).toBe(3);
    expect(rouletteMultiplier({ kind: 'numero', n: 0 }, 0)).toBe(36);
  });

  it('rend 36/37 des mises en moyenne, quel que soit le pari', () => {
    const bets: RouletteBet[] = [
      ...(['rouge', 'noir', 'pair', 'impair', 'manque', 'passe'] as const).map((kind) => ({ kind })),
      { kind: 'douzaine', n: 1 },
      { kind: 'numero', n: 7 },
    ];
    for (const bet of bets) {
      let total = 0;
      for (let n = 0; n < ROULETTE_NUMBERS; n++) total += rouletteMultiplier(bet, n);
      expect(total / ROULETTE_NUMBERS, JSON.stringify(bet)).toBeCloseTo(36 / 37, 10);
    }
  });

  it('additionne les gains de chaque joueur', () => {
    const p = roulettePayouts(
      [
        { userId: 'a', bet: { kind: 'rouge' }, stake: 10 },
        { userId: 'a', bet: { kind: 'numero', n: 3 }, stake: 5 },
        { userId: 'b', bet: { kind: 'noir' }, stake: 20 },
      ],
      3,
    );
    expect([...p]).toEqual([
      ['a', 20 + 180],
      ['b', 0],
    ]);
  });
});

describe('morpion et puissance 4', () => {
  const moves = (state: BoardState, ...list: number[]) =>
    list.reduce((s, m) => {
      const r = play(s, m);
      if (!r.ok) throw new Error(r.reason);
      return r.state;
    }, state);

  it('morpion : alignement, case prise, match nul', () => {
    const won = moves(newBoard('morpion'), 0, 3, 1, 4, 2);
    expect(won.winner).toBe(1);
    expect(won.line).toEqual([0, 1, 2]);
    expect(play(won, 5).ok).toBe(false);
    expect(play(moves(newBoard('morpion'), 4), 4)).toEqual({ ok: false, reason: 'Cette case est déjà prise.' });
    const draw = moves(newBoard('morpion'), 0, 1, 2, 4, 3, 5, 7, 6, 8);
    expect(draw.draw).toBe(true);
    expect(draw.winner).toBe(0);
    expect(isOver(draw)).toBe(true);
  });

  it('puissance 4 : les pions tombent, diagonale gagnante, colonne pleine', () => {
    let s = moves(newBoard('puissance4'), 3);
    expect(s.cells[5 * 7 + 3]).toBe(1);
    // Diagonale montante du joueur 1 : (5,0) (4,1) (3,2) (2,3).
    s = moves(newBoard('puissance4'), 0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3);
    expect(s.winner).toBe(1);
    expect(s.line).toHaveLength(4);
    const full = moves(newBoard('puissance4'), 0, 0, 0, 0, 0, 0);
    expect(play(full, 0)).toEqual({ ok: false, reason: 'Cette colonne est pleine.' });
    expect(legalMoves(full)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('affiche le plateau du puissance 4 avec les colonnes numérotées', () => {
    const text = boardText(moves(newBoard('puissance4'), 0, 6)).split('\n');
    expect(text).toHaveLength(7);
    expect(text[6]).toBe('🔴⚫⚫⚫⚫⚫🟡');
  });
});

describe('mises en dépôt', () => {
  let db: Db;
  let eco: EconomyService;
  let wagers: WagerService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    eco = new EconomyService({ db, bus: new EventBus<BotEvents>(), logger: nullLogger });
    const progress = new ProgressService(db, eco);
    wagers = new WagerService(db, eco, progress);
    for (const u of ['a', 'b']) eco.adjustBalance(G, u, 1_000, 'admin', null);
  });

  afterEach(() => db.close());

  it('prélève à l’ouverture et paie le gagnant au règlement', () => {
    const opened = wagers.open(G, 'morpion', [
      { userId: 'a', stake: 100 },
      { userId: 'b', stake: 100 },
    ]);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(eco.getBalance(G, 'a')).toBe(900);
    expect(eco.getBalance(G, 'b')).toBe(900);

    const settled = wagers.settle(opened.value, new Map([['a', 200]]));
    if (!settled.ok) throw new Error(settled.error.message);
    expect(settled.value.get('a')).toMatchObject({ stake: 100, payout: 200, net: 100, balance: 1_100 });
    expect(settled.value.get('b')).toMatchObject({ net: -100, balance: 900 });
    expect(wagers.settle(opened.value, new Map()).ok).toBe(false);
  });

  it('est tout ou rien : un joueur sans les fonds annule l’ouverture', () => {
    const r = wagers.open(G, 'puissance4', [
      { userId: 'a', stake: 100 },
      { userId: 'pauvre', stake: 100, who: 'Ton adversaire' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/^Ton adversaire n’a que/);
    expect(eco.getBalance(G, 'a')).toBe(1_000);
  });

  it('ajoute des mises (double, nouveaux paris) et garde les paris de roulette', () => {
    const opened = wagers.open(G, 'roulette', [{ userId: 'a', stake: 50, bet: { kind: 'rouge' } }]);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(wagers.add(opened.value, { userId: 'b', stake: 30, bet: { kind: 'numero', n: 7 } })).toEqual({ ok: true, value: 970 });
    expect(wagers.entries(opened.value)).toEqual([
      { userId: 'a', stake: 50, bet: { kind: 'rouge' } },
      { userId: 'b', stake: 30, bet: { kind: 'numero', n: 7 } },
    ]);
    wagers.settle(opened.value, new Map([['b', 1_080]]));
    const late = wagers.add(opened.value, { userId: 'a', stake: 10 });
    expect(late.ok).toBe(false);
    // 970 + 1 080 de gain, + 500 pour le succès « Jackpot » (×36 ≥ ×20).
    expect(eco.getBalance(G, 'b')).toBe(2_550);
  });

  it('respecte la mise maximale du serveur', () => {
    eco.updateSettings(G, { maxBet: 10 });
    const r = wagers.open(G, 'blackjack', [{ userId: 'a', stake: 11 }]);
    expect(r.ok).toBe(false);
  });

  it('rembourse au démarrage les parties jamais réglées', () => {
    const open = wagers.open(G, 'blackjack', [{ userId: 'a', stake: 100 }]);
    if (!open.ok) throw new Error(open.error.message);
    wagers.add(open.value, { userId: 'a', stake: 100 });
    const done = wagers.open(G, 'blackjack', [{ userId: 'b', stake: 100 }]);
    if (!done.ok) throw new Error(done.error.message);
    wagers.settle(done.value, new Map());

    expect(eco.getBalance(G, 'a')).toBe(800);
    expect(wagers.refundOpen()).toBe(1);
    expect(eco.getBalance(G, 'a')).toBe(1_000);
    expect(eco.getBalance(G, 'b')).toBe(900);
    expect(wagers.refundOpen()).toBe(0);
    expect(eco.history(G, 'a', 1)[0]?.note).toMatch(/remboursement blackjack/);
  });
});
