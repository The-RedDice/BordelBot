import { loadDatabaseConfig } from '../config/env.js';
import { openDatabase } from '../core/database/connection.js';
import { migrations } from '../core/database/migrations/index.js';
import { runMigrations } from '../core/database/migrator.js';
import { createLogger } from '../core/logger.js';

const config = loadDatabaseConfig();
const logger = createLogger(config.logLevel, 'migrate', config.logFormat);
const db = openDatabase(config.databasePath);
try {
  const { applied, currentVersion } = runMigrations(db, migrations, logger);
  logger.info(
    applied.length ? `${applied.length} migration(s) appliquée(s)` : 'Schéma déjà à jour',
    { currentVersion, path: config.databasePath },
  );
} finally {
  db.close();
}
