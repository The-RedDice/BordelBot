import { pick, type Rng } from '../../../core/rng.js';
import { BAD_NEWS, GOOD_NEWS, type MarketAsset } from './assets.js';

/** Bornes d'un cours, relatives au prix de référence. */
export const MIN_PRICE_RATIO = 1 / 50;
export const MAX_PRICE_RATIO = 50;
/** Amplitude d'une actualité, en rendement logarithmique (≈ ±8 % à ±35 %). */
const NEWS_MIN = 0.08;
const NEWS_MAX = 0.3;

export interface MarketNews {
  /** Variation relative due à l'actualité (ex. 0.15 = +15 %). */
  readonly change: number;
  readonly headline: string;
}

export interface PriceStep {
  readonly price: number;
  readonly news: MarketNews | null;
}

/** Loi normale centrée réduite (Box-Muller). */
export function gaussian(rng: Rng): number {
  const u1 = 1 - rng(); // ]0, 1] : évite log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Un tick de cours : marche aléatoire log-normale avec rappel vers le prix de
 * référence (Ornstein-Uhlenbeck sur le log du prix), plus des sauts rares
 * accompagnés d'une actualité. Fonction pure : le hasard est injecté.
 */
export function nextPrice(asset: MarketAsset, price: number, rng: Rng): PriceStep {
  const logPrice = Math.log(price);
  const pull = asset.reversion * (Math.log(asset.basePrice) - logPrice);
  let logReturn = pull + asset.volatility * gaussian(rng);

  let news: MarketNews | null = null;
  if (rng() < asset.newsChance) {
    const good = rng() < 0.5;
    const jump = (NEWS_MIN + (NEWS_MAX - NEWS_MIN) * rng()) * (good ? 1 : -1);
    logReturn += jump;
    news = {
      change: Math.exp(jump) - 1,
      headline: pick(rng, good ? GOOD_NEWS : BAD_NEWS).replaceAll('{name}', asset.name),
    };
  }

  const min = asset.basePrice * MIN_PRICE_RATIO;
  const max = asset.basePrice * MAX_PRICE_RATIO;
  const next = Math.min(max, Math.max(min, Math.exp(logPrice + logReturn)));
  return { price: roundPrice(next), news };
}

/** Deux décimales : assez pour les petits cours, sans bruit flottant dans la base. */
export function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}
