import { Events } from 'discord.js';
import { loadConfig } from './config/env.js';
import { createDiscordClient } from './core/client.js';
import { CommandRegistry } from './core/commands/registry.js';
import type { BotContext } from './core/context.js';
import { BackupScheduler, migrateWithBackup } from './core/database/backup.js';
import { openDatabase } from './core/database/connection.js';
import { migrations } from './core/database/migrations/index.js';
import { EventBus } from './core/EventBus.js';
import type { BotEvents } from './core/events.js';
import type { BotJobs } from './core/jobs.js';
import { JobScheduler } from './core/scheduler/JobScheduler.js';
import { createInteractionRouter } from './core/interactionRouter.js';
import { startDashboard, type RunningDashboard } from './dashboard/index.js';
import { createLogger } from './core/logger.js';
import { modules } from './modules/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, 'bot', config.logFormat);

  const db = openDatabase(config.databasePath);
  const backupOptions = { dir: config.backupDir, keep: config.backupKeep, logger: logger.child('backup') };
  const { applied, currentVersion } = await migrateWithBackup(db, migrations, {
    ...backupOptions,
    enabled: config.backupKeep > 0,
  });
  logger.info(`Base prête (schéma v${currentVersion}, ${applied.length} migration(s) appliquée(s))`);
  const backups = config.backupKeep > 0 ? new BackupScheduler(db, backupOptions) : undefined;
  if (backups) backups.start();
  else logger.warn('Sauvegardes désactivées (BACKUP_KEEP=0)');

  const scheduler = new JobScheduler<BotJobs>(db, { logger: logger.child('scheduler') });
  const ctx: BotContext = { db, bus: new EventBus<BotEvents>(logger.child('bus')), logger, scheduler };

  const registry = new CommandRegistry(modules);
  for (const mod of modules) {
    await mod.init?.(ctx);
    logger.debug(`Module initialisé : ${mod.name}`);
  }

  let dashboard: RunningDashboard | undefined;
  if (!config.dashboard) logger.info('Tableau de bord désactivé (DASHBOARD_PORT, DASHBOARD_URL et DISCORD_CLIENT_SECRET non renseignés)');

  const client = createDiscordClient(
    modules.flatMap((m) => m.intents ?? []),
    modules.flatMap((m) => m.partials ?? []),
  );
  client.once(Events.ClientReady, async (c) => {
    logger.info(`Connecté en tant que ${c.user.tag} (${registry.allCommands().length} commande(s))`);
    for (const mod of modules) {
      try {
        await mod.ready?.(c);
      } catch (err) {
        logger.error(`Échec du démarrage des tâches du module ${mod.name}`, err);
      }
    }
    // Après les `ready` : les gestionnaires peuvent compter sur des modules prêts.
    scheduler.start(c);
    if (config.dashboard && !dashboard) {
      try {
        dashboard = await startDashboard(config.dashboard, config.discordClientId, db, c, logger.child('dashboard'));
      } catch (err) {
        // Le bot continue sans tableau de bord (port déjà pris, par exemple).
        logger.error('Impossible de démarrer le tableau de bord', err);
      }
    }
  });
  client.on(Events.InteractionCreate, createInteractionRouter(registry, ctx));
  client.on(Events.Error, (err) => logger.error('Erreur du client Discord', err));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} reçu, arrêt en cours…`);
    // Avant les modules : aucune tâche ni page ne doit s'exécuter sur un module déjà libéré.
    await dashboard?.close();
    await scheduler.stop();
    for (const mod of [...modules].reverse()) {
      try {
        await mod.dispose?.();
      } catch (err) {
        logger.error(`Échec du dispose du module ${mod.name}`, err);
      }
    }
    backups?.stop();
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
