import type { BotJobs } from '../../core/jobs.js';
import type { JobScheduler } from '../../core/scheduler/JobScheduler.js';
import type { EconomyService } from './EconomyService.js';
import type { EconomyExtrasStore } from './extras.js';
import type { GamblingService } from './gambling/GamblingService.js';
import type { WagerService } from './gambling/WagerService.js';
import type { HeistService } from './heist/HeistService.js';
import type { MarketService } from './market/MarketService.js';
import type { ProgressService } from './progress/ProgressService.js';
import type { RoleShop } from './shop/RoleShop.js';
import type { EventSettingsStore } from './eventsSettings.js';
import type { LotteryService } from './lottery/LotteryService.js';
import type { SeasonService } from './seasons/SeasonService.js';

/** Services du module, créés à l'init et résolus à l'appel par les commandes. */
export interface EconomyServices {
  readonly eco: EconomyService;
  readonly progress: ProgressService;
  readonly gambling: GamblingService;
  /** Mises en dépôt des jeux en plusieurs coups (blackjack, roulette, morpion, puissance 4). */
  readonly wagers: WagerService;
  readonly market: MarketService;
  /** Rôles vendus en boutique (temporaires ou permanents). */
  readonly roleShop: RoleShop;
  readonly heists: HeistService;
  /** Réglages du rôle du plus riche et des braquages. */
  readonly extras: EconomyExtrasStore;
  readonly lottery: LotteryService;
  readonly seasons: SeasonService;
  /** Réglages de la loterie et des saisons. */
  readonly events: EventSettingsStore;
  /** Planificateur partagé (fin des rôles achetés, tirages). */
  readonly scheduler: JobScheduler<BotJobs>;
}

export type GetServices = () => EconomyServices;
