import type { Migration } from '../migrator.js';

export const economyMigration: Migration = {
  version: 2,
  name: 'economy_notes_and_leaderboard',
  up(db) {
    db.exec(`
      -- Texte libre : motif d'un ajustement admin, détail d'un achat, jeu d'une récompense.
      ALTER TABLE economy_transactions ADD COLUMN note TEXT;
      -- Classement par serveur.
      CREATE INDEX idx_accounts_balance ON economy_accounts (guild_id, balance DESC);
    `);
  },
};
