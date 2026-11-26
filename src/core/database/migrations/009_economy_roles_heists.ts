import type { Migration } from '../migrator.js';

/**
 * Rôles en boutique, rôle du plus riche et braquages. Le journal économique est
 * reconstruit (comme en 003 et 007) avec les types d'opérations des trois lots
 * de l'économie : braquage, loterie, récompense de saison et dividende.
 */
export const economyRolesHeistsMigration: Migration = {
  version: 9,
  name: 'economy_roles_heists',
  up(db) {
    db.exec(`
      -- ===== Rôles en boutique =====
      ALTER TABLE shop_items ADD COLUMN role_id TEXT;
      -- Durée du rôle acheté ; NULL = permanent.
      ALTER TABLE shop_items ADD COLUMN role_duration_ms INTEGER
        CHECK (role_duration_ms IS NULL OR role_duration_ms > 0);

      CREATE TABLE role_grants (
        guild_id    TEXT    NOT NULL,
        user_id     TEXT    NOT NULL,
        role_id     TEXT    NOT NULL,
        item_key    TEXT    NOT NULL,
        -- NULL = permanent.
        expires_at  INTEGER,
        granted_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, role_id)
      ) STRICT;

      -- ===== Rôle du plus riche et braquages : réglages =====
      CREATE TABLE economy_extras (
        guild_id            TEXT    PRIMARY KEY,
        richest_role_id     TEXT,
        -- Détenteur actuel du rôle du plus riche.
        richest_user_id     TEXT,
        -- Salon où annoncer le changement de détenteur (NULL = pas d'annonce).
        richest_channel_id  TEXT,
        heist_enabled       INTEGER NOT NULL DEFAULT 1 CHECK (heist_enabled IN (0, 1)),
        -- Butin maximal d'un braquage.
        heist_cap           INTEGER NOT NULL DEFAULT 5000 CHECK (heist_cap BETWEEN 1 AND 1000000000000)
      ) STRICT;

      CREATE TABLE heists (
        id         INTEGER PRIMARY KEY,
        guild_id   TEXT    NOT NULL,
        robber_id  TEXT    NOT NULL,
        target_id  TEXT    NOT NULL,
        success    INTEGER NOT NULL CHECK (success IN (0, 1)),
        -- Butin (réussite) ou amende (échec).
        amount     INTEGER NOT NULL CHECK (amount >= 0),
        at         INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX idx_heists_robber ON heists (guild_id, robber_id, at DESC);
      CREATE INDEX idx_heists_target ON heists (guild_id, target_id, at DESC);

      -- ===== Journal économique : braquage, loterie, saisons, dividendes =====
      CREATE TABLE economy_transactions_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT    NOT NULL,
        user_id          TEXT    NOT NULL,
        amount           INTEGER NOT NULL,
        balance_after    INTEGER NOT NULL,
        kind             TEXT    NOT NULL CHECK (kind IN
                           ('daily','transfer_in','transfer_out','game_reward','purchase','admin_adjust',
                            'gamble','duel','market_buy','market_sell','achievement','birthday',
                            'heist','lottery','season_reward','dividend')),
        counterparty_id  TEXT,
        reference        TEXT,
        created_at       INTEGER NOT NULL,
        note             TEXT,
        FOREIGN KEY (guild_id, user_id) REFERENCES economy_accounts (guild_id, user_id)
      ) STRICT;
      INSERT INTO economy_transactions_new
        (id, guild_id, user_id, amount, balance_after, kind, counterparty_id, reference, created_at, note)
        SELECT id, guild_id, user_id, amount, balance_after, kind, counterparty_id, reference, created_at, note
        FROM economy_transactions;
      DROP TABLE economy_transactions;
      ALTER TABLE economy_transactions_new RENAME TO economy_transactions;
      CREATE INDEX idx_tx_user ON economy_transactions (guild_id, user_id, created_at DESC);
      CREATE INDEX idx_tx_guild ON economy_transactions (guild_id, id);
      CREATE UNIQUE INDEX uq_tx_game_reward
        ON economy_transactions (guild_id, user_id, reference)
        WHERE kind = 'game_reward';
      CREATE UNIQUE INDEX uq_tx_birthday
        ON economy_transactions (guild_id, user_id, reference)
        WHERE kind = 'birthday';
    `);
  },
};
