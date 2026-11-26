import type { Migration } from '../migrator.js';

/** Dividendes : le type d'opération existe depuis la migration 009 ; on ajoute la garantie d'un versement par jour. */
export const dividendsMigration: Migration = {
  version: 11,
  name: 'dividends',
  up(db) {
    db.exec(`
      -- Un seul dividende par membre, par actif et par jour (reference = « CRS:2026-11-26 »).
      CREATE UNIQUE INDEX uq_tx_dividend
        ON economy_transactions (guild_id, user_id, reference)
        WHERE kind = 'dividend';
      CREATE INDEX idx_market_holdings_symbol ON market_holdings (symbol);
    `);
  },
};
