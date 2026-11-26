import type { Migration } from '../migrator.js';

/**
 * Schéma initial. Conventions :
 * - IDs Discord (snowflakes) en TEXT : ils dépassent Number.MAX_SAFE_INTEGER.
 * - Dates en INTEGER (epoch millisecondes).
 * - Montants en INTEGER (pas de flottants pour la monnaie).
 * - Tables STRICT pour que SQLite refuse les types incohérents.
 */
export const initialMigration: Migration = {
  version: 1,
  name: 'initial_schema',
  up(db) {
    db.exec(`
      -- ===== Configuration par serveur =====
      CREATE TABLE guild_settings (
        guild_id            TEXT    PRIMARY KEY,
        mod_log_channel_id  TEXT,
        currency_name       TEXT    NOT NULL DEFAULT 'pièces',
        daily_amount        INTEGER NOT NULL DEFAULT 100 CHECK (daily_amount >= 0),
        game_win_reward     INTEGER NOT NULL DEFAULT 50  CHECK (game_win_reward >= 0),
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      ) STRICT;

      -- ===== Économie =====
      CREATE TABLE economy_accounts (
        guild_id       TEXT    NOT NULL,
        user_id        TEXT    NOT NULL,
        balance        INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        last_daily_at  INTEGER,
        daily_streak   INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      ) STRICT;

      -- Journal append-only : toute variation de solde y laisse une trace.
      CREATE TABLE economy_transactions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT    NOT NULL,
        user_id          TEXT    NOT NULL,
        amount           INTEGER NOT NULL,           -- signé : + crédit, - débit
        balance_after    INTEGER NOT NULL,
        kind             TEXT    NOT NULL CHECK (kind IN
                           ('daily','transfer_in','transfer_out','game_reward','purchase','admin_adjust')),
        counterparty_id  TEXT,
        reference        TEXT,                       -- ex. id de session de jeu
        created_at       INTEGER NOT NULL,
        FOREIGN KEY (guild_id, user_id) REFERENCES economy_accounts (guild_id, user_id)
      ) STRICT;
      CREATE INDEX idx_tx_user ON economy_transactions (guild_id, user_id, created_at DESC);
      -- Idempotence : une seule récompense par joueur et par partie.
      CREATE UNIQUE INDEX uq_tx_game_reward
        ON economy_transactions (guild_id, user_id, reference)
        WHERE kind = 'game_reward';

      CREATE TABLE shop_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT    NOT NULL,
        key          TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        description  TEXT    NOT NULL DEFAULT '',
        price        INTEGER NOT NULL CHECK (price >= 0),
        stackable    INTEGER NOT NULL DEFAULT 1 CHECK (stackable IN (0, 1)),
        enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at   INTEGER NOT NULL,
        UNIQUE (guild_id, key)
      ) STRICT;

      CREATE TABLE inventory_items (
        guild_id     TEXT    NOT NULL,
        user_id      TEXT    NOT NULL,
        item_id      INTEGER NOT NULL REFERENCES shop_items (id) ON DELETE CASCADE,
        quantity     INTEGER NOT NULL CHECK (quantity > 0),
        acquired_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, item_id)
      ) STRICT;

      -- ===== Modération =====
      CREATE TABLE moderation_cases (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT    NOT NULL,
        case_number   INTEGER NOT NULL,              -- numérotation lisible par serveur
        action        TEXT    NOT NULL CHECK (action IN
                        ('warn','timeout','untimeout','kick','ban','unban','purge')),
        target_id     TEXT    NOT NULL,              -- utilisateur, ou salon pour une purge
        moderator_id  TEXT    NOT NULL,
        reason        TEXT,
        duration_ms   INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
        expires_at    INTEGER,
        metadata      TEXT,                          -- JSON (ex. nombre de messages purgés)
        revoked       INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
        created_at    INTEGER NOT NULL,
        UNIQUE (guild_id, case_number)
      ) STRICT;
      CREATE INDEX idx_cases_target ON moderation_cases (guild_id, target_id, created_at DESC);

      -- ===== Jeux =====
      CREATE TABLE game_sessions (
        id          TEXT    PRIMARY KEY,             -- UUID
        guild_id    TEXT    NOT NULL,
        channel_id  TEXT    NOT NULL,
        game        TEXT    NOT NULL CHECK (game IN ('mole','one-vs-all')),
        host_id     TEXT    NOT NULL,
        status      TEXT    NOT NULL CHECK (status IN ('lobby','running','finished','cancelled')),
        state_json  TEXT,                            -- snapshot sérialisé de la FSM
        created_at  INTEGER NOT NULL,
        ended_at    INTEGER
      ) STRICT;
      -- Une seule partie active par salon.
      CREATE UNIQUE INDEX uq_game_active_channel
        ON game_sessions (channel_id)
        WHERE status IN ('lobby','running');

      CREATE TABLE game_participants (
        session_id  TEXT    NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
        user_id     TEXT    NOT NULL,
        role        TEXT,
        result      TEXT    CHECK (result IS NULL OR result IN ('win','loss','draw')),
        PRIMARY KEY (session_id, user_id)
      ) STRICT;
      CREATE INDEX idx_participants_user ON game_participants (user_id);
    `);
  },
};
