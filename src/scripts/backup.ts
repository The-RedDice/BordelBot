import { loadDatabaseConfig } from '../config/env.js';
import { backupDatabase } from '../core/database/backup.js';
import { openDatabase } from '../core/database/connection.js';
import { createLogger } from '../core/logger.js';

/**
 * Sauvegarde manuelle (`npm run backup`), utilisable bot allumé : la copie se fait
 * à chaud. Rangée à part (`manual`), elle n'écarte pas les sauvegardes quotidiennes.
 */
const config = loadDatabaseConfig();
const logger = createLogger(config.logLevel, 'backup', config.logFormat);
const db = openDatabase(config.databasePath);
try {
  const path = await backupDatabase(db, 'manual', { dir: config.backupDir, keep: Math.max(config.backupKeep, 1), logger });
  console.log(path);
} finally {
  db.close();
}
