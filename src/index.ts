import { Events } from 'discord.js';
import { loadConfig } from './config/env.js';
import { createDiscordClient } from './core/client.js';
import { CommandRegistry } from './core/commands/registry.js';
import type { BotContext } from './core/context.js';
import { openDatabase } from './core/database/connection.js';
import { migrations } from './core/database/migrations/index.js';
import { runMigrations } from './core/database/migrator.js';
import { EventBus } from './core/EventBus.js';
import type { BotEvents } from './core/events.js';
import { createInteractionRouter } from './core/interactionRouter.js';
import { createLogger } from './core/logger.js';
import { modules } from './modules/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const db = openDatabase(config.databasePath);
  const { applied, currentVersion } = runMigrations(db, migrations, logger.child('db'));
  logger.info(`Base prête (schéma v${currentVersion}, ${applied.length} migration(s) appliquée(s))`);

  const ctx: BotContext = { db, bus: new EventBus<BotEvents>(logger.child('bus')), logger };

  const registry = new CommandRegistry(modules);
  for (const mod of modules) {
    await mod.init?.(ctx);
    logger.debug(`Module initialisé : ${mod.name}`);
  }

  const client = createDiscordClient();
  client.once(Events.ClientReady, (c) => {
    logger.info(`Connecté en tant que ${c.user.tag} (${registry.allCommands().length} commande(s))`);
  });
  client.on(Events.InteractionCreate, createInteractionRouter(registry, ctx));
  client.on(Events.Error, (err) => logger.error('Erreur du client Discord', err));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} reçu, arrêt en cours…`);
    for (const mod of [...modules].reverse()) {
      try {
        await mod.dispose?.();
      } catch (err) {
        logger.error(`Échec du dispose du module ${mod.name}`, err);
      }
    }
    ctx.bus.clear();
    await client.destroy();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Promise rejetée non gérée', reason));

  await client.login(config.discordToken);
}

main().catch((err: unknown) => {
  console.error('Échec du démarrage :', err);
  process.exit(1);
});
