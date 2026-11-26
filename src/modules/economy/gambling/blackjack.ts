import { shuffle, type Rng } from '../../../core/rng.js';

export const SUITS = ['♠', '♥', '♦', '♣'] as const;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

/** Sabot de 6 jeux, mélangé à chaque partie. */
export const SHOE_DECKS = 6;

export function newShoe(rng: Rng, decks = SHOE_DECKS): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit });
  return shuffle(rng, cards);
}

const rankValue = (r: Rank): number => (r === 'A' ? 1 : r === 'J' || r === 'Q' || r === 'K' ? 10 : Number(r));

export interface HandValue {
  readonly total: number;
  /** Un as compte pour 11 (la main peut encore « redescendre »). */
  readonly soft: boolean;
}

export function handValue(cards: readonly Card[]): HandValue {
  const hard = cards.reduce((sum, c) => sum + rankValue(c.rank), 0);
  const hasAce = cards.some((c) => c.rank === 'A');
  return hasAce && hard + 10 <= 21 ? { total: hard + 10, soft: true } : { total: hard, soft: false };
}

export const isBlackjack = (cards: readonly Card[]): boolean => cards.length === 2 && handValue(cards).total === 21;

export type BlackjackOutcome = 'blackjack' | 'win' | 'push' | 'lose';

export interface BlackjackState {
  /** Cartes restantes ; la prochaine carte tirée est la première. */
  readonly shoe: readonly Card[];
  readonly player: readonly Card[];
  readonly dealer: readonly Card[];
  readonly doubled: boolean;
  /** null tant que la main est en cours. */
  readonly outcome: BlackjackOutcome | null;
}

function draw(shoe: readonly Card[]): [Card, Card[]] {
  const [card, ...rest] = shoe;
  if (!card) throw new Error('Sabot vide');
  return [card, rest];
}

/** Donne deux cartes à chacun (joueur, croupier, joueur, croupier) ; un blackjack se règle aussitôt. */
export function deal(shoe: readonly Card[]): BlackjackState {
  const [p1, s1] = draw(shoe);
  const [d1, s2] = draw(s1);
  const [p2, s3] = draw(s2);
  const [d2, s4] = draw(s3);
  const state: BlackjackState = { shoe: s4, player: [p1, p2], dealer: [d1, d2], doubled: false, outcome: null };
  if (isBlackjack(state.player) || isBlackjack(state.dealer)) return settle(state);
  return state;
}

export function canDouble(state: BlackjackState): boolean {
  return state.outcome === null && state.player.length === 2 && !state.doubled;
}

/** Tire une carte. Au-delà de 21, la main est perdue ; à 21, le joueur reste automatiquement. */
export function hit(state: BlackjackState): BlackjackState {
  if (state.outcome !== null) return state;
  const [card, shoe] = draw(state.shoe);
  const next = { ...state, shoe, player: [...state.player, card] };
  const { total } = handValue(next.player);
  if (total > 21) return { ...next, outcome: 'lose' };
  if (total === 21) return stand(next);
  return next;
}

/** Double la mise : une seule carte de plus, puis le joueur reste. */
export function double(state: BlackjackState): BlackjackState {
  if (!canDouble(state)) return state;
  const drawn = hit({ ...state, doubled: true });
  return drawn.outcome === null ? stand(drawn) : drawn;
}

/** Le croupier tire jusqu'à 17 ou plus (il reste sur un 17 « soft »), puis la main est réglée. */
export function stand(state: BlackjackState): BlackjackState {
  if (state.outcome !== null) return state;
  let shoe = state.shoe;
  let dealer = state.dealer;
  while (handValue(dealer).total < 17) {
    const [card, rest] = draw(shoe);
    dealer = [...dealer, card];
    shoe = rest;
  }
  return settle({ ...state, shoe, dealer });
}

function settle(state: BlackjackState): BlackjackState {
  const player = handValue(state.player).total;
  const dealer = handValue(state.dealer).total;
  const playerBj = isBlackjack(state.player) && !state.doubled;
  const dealerBj = isBlackjack(state.dealer);
  let outcome: BlackjackOutcome;
  if (playerBj && dealerBj) outcome = 'push';
  else if (playerBj) outcome = 'blackjack';
  else if (dealerBj) outcome = 'lose';
  else if (player > 21) outcome = 'lose';
  else if (dealer > 21 || player > dealer) outcome = 'win';
  else if (player === dealer) outcome = 'push';
  else outcome = 'lose';
  return { ...state, outcome };
}

/** Gain total (mise comprise) pour une mise totale `stake` : blackjack 3:2, victoire 1:1, égalité remboursée. */
export function blackjackPayout(outcome: BlackjackOutcome, stake: number): number {
  switch (outcome) {
    case 'blackjack':
      return Math.floor(stake * 2.5);
    case 'win':
      return stake * 2;
    case 'push':
      return stake;
    case 'lose':
      return 0;
  }
}

export const cardText = (c: Card): string => `${c.rank}${c.suit}`;
