import type { Migration } from '../migrator.js';

/**
 * Anniversaires. Le journal économique est reconstruit (même méthode que la
 * migration 003) pour autoriser le type d'opération `birthday`.
 */
export const birthdaysMigration: Migration = {
  version: 7,
  name: 'birthdays',
  up(db) {
    db.exec(`
      -- ===== Anniversaires =====
      CREATE TABLE birthdays (
        guild_id  TEXT    NOT NULL,
        user_id   TEXT    NOT NULL,
        month     INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        day       INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
        PRIMARY KEY (guild_id, user_id)
      ) STRICT;
      CREATE INDEX idx_birthdays_date ON birthdays (guild_id, month, day);

      CREATE TABLE birthday_settings (
        guild_id    TEXT    PRIMARY KEY,
        channel_id  TEXT,
        -- Rôle porté le jour de l'anniversaire, retiré le lendemain.
        role_id     TEXT,
        bonus       INTEGER NOT NULL DEFAULT 0 CHECK (bonus BETWEEN 0 AND 1000000),
        -- Heure locale de l'annonce.
        hour        INTEGER NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
        timezone    TEXT    NOT NULL DEFAULT 'Europe/Paris',
        -- Dernier jour local (AAAA-MM-JJ) où les anniversaires ont été fêtés.
        last_run    TEXT
      ) STRICT;

      -- Un anniversaire fêté par an au plus : protège le bonus d'un changement de date.
      CREATE TABLE birthday_celebrations (
        guild_id      TEXT    NOT NULL,
        user_id       TEXT    NOT NULL,
        year          INTEGER NOT NULL,
        date          TEXT    NOT NULL,
        role_id       TEXT,
        role_removed  INTEGER NOT NULL DEFAULT 0 CHECK (role_removed IN (0, 1)),
        PRIMARY KEY (guild_id, user_id, year)
      ) STRICT;
      CREATE INDEX idx_birthday_roles_pending ON birthday_celebrations (guild_id, date)
        WHERE role_id IS NOT NULL AND role_removed = 0;

      -- ===== Journal économique : type « birthday » =====
      CREATE TABLE economy_transactions_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT    NOT NULL,
        user_id          TEXT    NOT NULL,
        amount           INTEGER NOT NULL,
        balance_after    INTEGER NOT NULL,
        kind             TEXT    NOT NULL CHECK (kind IN
                           ('daily','transfer_in','transfer_out','game_reward','purchase','admin_adjust',
                            'gamble','duel','market_buy','market_sell','achievement','birthday')),
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
      -- Idempotence : un seul bonus d'anniversaire par membre et par an (reference = année).
      CREATE UNIQUE INDEX uq_tx_birthday
        ON economy_transactions (guild_id, user_id, reference)
        WHERE kind = 'birthday';
    `);
  },
};
