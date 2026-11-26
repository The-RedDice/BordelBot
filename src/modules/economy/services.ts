import type { EconomyService } from './EconomyService.js';
import type { GamblingService } from './gambling/GamblingService.js';
import type { WagerService } from './gambling/WagerService.js';
import type { MarketService } from './market/MarketService.js';
import type { ProgressService } from './progress/ProgressService.js';

/** Services du module, créés à l'init et résolus à l'appel par les commandes. */
export interface EconomyServices {
  readonly eco: EconomyService;
  readonly progress: ProgressService;
  readonly gambling: GamblingService;
  /** Mises en dépôt des jeux en plusieurs coups (blackjack, roulette, morpion, puissance 4). */
  readonly wagers: WagerService;
  readonly market: MarketService;
}

export type GetServices = () => EconomyServices;
