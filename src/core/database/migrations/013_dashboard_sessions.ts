import type { Migration } from '../migrator.js';

export const dashboardSessionsMigration: Migration = {
  version: 13,
  name: 'dashboard_sessions',
  up(db) {
    db.exec(`
      -- Sessions du tableau de bord. Seule l'empreinte (SHA-256) du jeton est stockée :
      -- une copie de la base ne permet pas de se faire passer pour quelqu'un.
      CREATE TABLE dashboard_sessions (
        token_hash  TEXT    PRIMARY KEY,
        user_id     TEXT    NOT NULL,
        username    TEXT    NOT NULL,
        avatar      TEXT,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX idx_dashboard_sessions_expiry ON dashboard_sessions (expires_at);
    `);
  },
};
