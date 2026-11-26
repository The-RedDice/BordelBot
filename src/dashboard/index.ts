import type { Server } from 'node:http';
import type { Client } from 'discord.js';
import type { DashboardConfig } from '../config/env.js';
import type { Db } from '../core/database/connection.js';
import type { Logger } from '../core/logger.js';
import { getEconomyServices } from '../modules/economy/index.js';
import { getLevelService } from '../modules/levels/index.js';
import { SessionStore } from './auth.js';
import { DashboardData } from './data.js';
import { DiscordDirectory } from './directory.js';
import { createDashboardServer } from './server.js';

/** Nettoyage des sessions expirées. */
const PURGE_INTERVAL_MS = 6 * 3_600_000;

export interface RunningDashboard {
  close(): Promise<void>;
}

/**
 * Démarre le tableau de bord web, une fois le client Discord prêt. Il lit les
 * services des modules économie et niveaux, sans jamais rien modifier : c'est
 * une couche d'affichage, comme les commandes, mais sur le web.
 */
export async function startDashboard(
  config: DashboardConfig,
  clientId: string,
  db: Db,
  client: Client<true>,
  logger: Logger,
): Promise<RunningDashboard> {
  const sessions = new SessionStore(db);
  sessions.purge();
  const data = new DashboardData({
    db,
    economy: getEconomyServices,
    levels: (guildId, limit) => getLevelService().leaderboard(guildId, limit),
    memberXp: (guildId, userId) => getLevelService().member(guildId, userId).xp,
  });
  const server: Server = createDashboardServer({
    oauth: { clientId, clientSecret: config.clientSecret, publicUrl: config.publicUrl },
    sessions,
    data,
    directory: new DiscordDirectory(client),
    logger,
  });
  const purge = setInterval(() => sessions.purge(), PURGE_INTERVAL_MS);
  purge.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info(`Tableau de bord sur http://${config.host}:${config.port} (public : ${config.publicUrl})`);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(purge);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
