import type { Migration } from '../migrator.js';

export const schedulerMigration: Migration = {
  version: 5,
  name: 'scheduler',
  up(db) {
    db.exec(`
      -- ===== Tâches planifiées (rappels, sondages, loterie…) =====
      CREATE TABLE scheduled_jobs (
        id          INTEGER PRIMARY KEY,
        -- Type de tâche : choisit le gestionnaire (ex. 'reminder').
        kind        TEXT    NOT NULL,
        -- Clé facultative et unique : replanifier avec la même clé remplace la tâche.
        key         TEXT    UNIQUE,
        guild_id    TEXT,
        run_at      INTEGER NOT NULL,
        payload     TEXT    NOT NULL DEFAULT '{}',
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        -- Renseigné quand la tâche a épuisé ses essais : elle n'est plus exécutée.
        failed_at   INTEGER,
        created_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX idx_scheduled_jobs_due ON scheduled_jobs (run_at) WHERE failed_at IS NULL;
      CREATE INDEX idx_scheduled_jobs_guild ON scheduled_jobs (guild_id, kind);
    `);
  },
};
