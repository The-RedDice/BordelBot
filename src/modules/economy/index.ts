import type { Client } from 'discord.js';
import type { BotModule } from '../../core/commands/types.js';
import type { Logger } from '../../core/logger.js';
import { createEconomyAdminCommands } from './discord/adminCommand.js';
import { createEconomyCommands } from './discord/commands.js';
import { achievementLines } from './discord/format.js';
import { BlackjackTables } from './discord/blackjack.js';
import { BoardMatches } from './discord/boards.js';
import { createGamblingCommands, DuelManager, type Tables } from './discord/gambling.js';
import { RouletteTables } from './discord/roulette.js';
import { createMarketCommand } from './discord/market.js';
import { createProfileCommands } from './discord/profile.js';
import { createEconomySettings } from './discord/settings.js';
import { createEconomyTopCommands } from './discord/top.js';
import { EconomyService } from './EconomyService.js';
import { GamblingService } from './gambling/GamblingService.js';
import { WagerService } from './gambling/WagerService.js';
import { MARKET_TICK_MS, MarketService } from './market/MarketService.js';
import { ProgressService, type UnlockedAchievement } from './progress/ProgressService.js';
import type { EconomyServices } from './services.js';
import { createExtrasSettings } from './discord/extrasSettings.js';
import { roleExpiryHandler, updateRichest } from './discord/roles.js';
import { EconomyExtrasStore } from './extras.js';
import { HeistService } from './heist/HeistService.js';
import { RoleShop } from './shop/RoleShop.js';

/**
 * Module Économie : soldes, daily, virements, boutique, jeux d'argent, bourse,
 * statistiques et succès. Crédite les gagnants à la réception de `game:finished`,
 * sans dépendre du module de jeux. Le crédit est idempotent
 * (vérification + index unique uq_tx_game_reward).
 */
let services: EconomyServices | undefined;
let duels: DuelManager | undefined;
let tables: Tables | undefined;
let logger: Logger | undefined;
let client: Client<true> | undefined;
let unsubscribe: (() => void) | undefined;
let marketTimer: NodeJS.Timeout | undefined;
let unregisterJobs: (() => void)[] = [];

export const RICHEST_TICK_KEY = 'economy:richest';

/** Début de l'heure suivante, plus quelques secondes. */
const nextHour = (at: number) => (Math.floor(at / 3_600_000) + 1) * 3_600_000 + 5_000;
/** Parties déjà comptées dans les statistiques (les plus récentes). */
const countedSessions = new Set<string>();

function getServices(): EconomyServices {
  if (!services) throw new Error('Module économie non initialisé');
  return services;
}

export function getEconomyService(): EconomyService {
  return getServices().eco;
}

export function getEconomyServices(): EconomyServices {
  return getServices();
}

function getTables(): Tables {
  if (!tables) throw new Error('Module économie non initialisé');
  return tables;
}

function getDuels(): DuelManager {
  if (!duels) throw new Error('Module économie non initialisé');
  return duels;
}

function getLogger(): Logger {
  if (!logger) throw new Error('Module économie non initialisé');
  return logger;
}

/** Avance la bourse au prochain multiple de 5 minutes, puis à chaque tick. */
function scheduleMarket(market: MarketService, log: Logger): void {
  const tick = () => {
    try {
      market.advance();
    } catch (err) {
      log.error('Échec de la mise à jour des cours', err);
    }
  };
  const delay = MARKET_TICK_MS - (Date.now() % MARKET_TICK_MS) + 1_000;
  marketTimer = setTimeout(() => {
    tick();
    marketTimer = setInterval(tick, MARKET_TICK_MS);
    marketTimer.unref();
  }, delay);
  marketTimer.unref();
}

/** Annonce dans le salon de la partie les succès débloqués par les joueurs. */
async function announceUnlocks(channelId: string, guildId: string, unlocked: Map<string, UnlockedAchievement[]>): Promise<void> {
  if (!client || unlocked.size === 0) return;
  const { currencyName } = getServices().eco.getSettings(guildId);
  const lines = [...unlocked].flatMap(([userId, list]) => achievementLines(list, currencyName, `<@${userId}>`));
  try {
    const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
    if (channel?.isSendable()) await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
  } catch (err) {
    getLogger().warn(`Impossible d'annoncer des succès dans le salon ${channelId}`, err);
  }
}

const gambling = createGamblingCommands(getServices, getDuels, getTables);

export const economyModule: BotModule = {
  name: 'economy',
  commands: [createMarketCommand(getServices)],
  subcommands: [
    ...createEconomyCommands(getServices),
    ...createProfileCommands(getServices),
    ...gambling.subcommands,
    ...createEconomyTopCommands(getServices),
    ...createEconomyAdminCommands(getEconomyService),
  ],
  components: gambling.components,
  settings: [createEconomySettings(getEconomyService), createExtrasSettings(getServices)],
  init(ctx) {
    const log = ctx.logger.child('economy');
    logger = log;
    const eco = new EconomyService(ctx);
    const progress = new ProgressService(ctx.db, eco);
    const market = new MarketService(ctx.db, eco, progress, { logger: log.child('market') });
    const wagers = new WagerService(ctx.db, eco, progress);
    // Parties interrompues par un arrêt du bot : leurs mises sont rendues.
    const refunded = wagers.refundOpen();
    if (refunded > 0) log.warn(`${refunded} partie(s) interrompue(s) : mises remboursées`);
    const extras = new EconomyExtrasStore(ctx.db);
    services = {
      eco,
      progress,
      gambling: new GamblingService(eco, progress),
      market,
      wagers,
      roleShop: new RoleShop(ctx.db, eco),
      heists: new HeistService(ctx.db, eco, extras),
      extras,
      scheduler: ctx.scheduler,
    };

    // Fin des rôles achetés, et rôle du plus riche vérifié toutes les heures (tâche unique à clé fixe).
    unregisterJobs = [
      ctx.scheduler.register('shop:roleExpiry', roleExpiryHandler(getServices)),
      ctx.scheduler.register('economy:richest', async (_job, c) => {
        await updateRichest(c, getServices, log);
        return { rescheduleAt: nextHour(Date.now()) };
      }),
    ];
    if (!ctx.scheduler.getByKey(RICHEST_TICK_KEY)) {
      ctx.scheduler.schedule('economy:richest', Date.now(), {}, { key: RICHEST_TICK_KEY });
    }
    duels = new DuelManager(getServices, getLogger);
    tables = {
      blackjack: new BlackjackTables(getServices, getLogger),
      roulette: new RouletteTables(getServices, getLogger),
      boards: new BoardMatches(getServices, getLogger),
    };

    market.advance();
    scheduleMarket(market, log);

    const offBirthday = ctx.bus.on('birthday:celebrated', (event) => {
      if (event.bonus <= 0) return;
      const r = eco.rewardBirthday(event.guildId, event.userId, event.year, event.bonus);
      if (!r.ok) log.warn(`Bonus d'anniversaire non versé à ${event.userId} sur ${event.guildId}`, r.error);
    });

    const offGame = ctx.bus.on('game:finished', async (event) => {
      const r = eco.rewardGame(event);
      if (!r.ok) log.warn(`Récompense non versée pour la partie ${event.sessionId}`, r.error);
      else if (r.value.credited.length > 0) {
        log.info(`Partie ${event.sessionId} : ${r.value.amountPerWinner} versé(s) à ${r.value.credited.length} gagnant(s)`);
      }
      // Un événement rejoué ne doit pas recompter la partie (même quand aucune récompense n'est versée).
      if (r.ok && r.value.skipped.length > 0 && r.value.credited.length === 0) return;
      if (countedSessions.has(event.sessionId)) return;
      countedSessions.add(event.sessionId);
      if (countedSessions.size > 1_000) countedSessions.delete(countedSessions.values().next().value as string);

      const winners = new Set(event.winnerIds);
      const unlocked = new Map<string, UnlockedAchievement[]>();
      for (const userId of new Set([...event.winnerIds, ...event.loserIds])) {
        const list = progress.record(event.guildId, userId, [
          { stat: 'games_played', add: 1 },
          ...(winners.has(userId) ? [{ stat: 'games_won' as const, add: 1 }] : []),
        ]);
        if (list.length) unlocked.set(userId, list);
      }
      await announceUnlocks(event.channelId, event.guildId, unlocked);
    });
    unsubscribe = () => {
      offBirthday();
      offGame();
    };
  },
  ready(c) {
    client = c;
  },
  dispose() {
    unsubscribe?.();
    unsubscribe = undefined;
    clearTimeout(marketTimer);
    clearInterval(marketTimer);
    marketTimer = undefined;
    for (const off of unregisterJobs) off();
    unregisterJobs = [];
    duels?.dispose();
    duels = undefined;
    // Parties en cours abandonnées : leurs mises restent en dépôt et seront remboursées au prochain démarrage.
    tables?.blackjack.dispose();
    tables?.roulette.dispose();
    tables?.boards.dispose();
    tables = undefined;
    services = undefined;
    logger = undefined;
    client = undefined;
  },
};
