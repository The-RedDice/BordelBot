import type { Migration } from '../migrator.js';

export const gamesMigration: Migration = {
  version: 8,
  name: 'blackjack_roulette_boards_word',
  up(db) {
    db.exec(`
      -- ===== Mises en dépôt (blackjack, roulette, morpion, puissance 4) =====
      -- Une mise est prélevée à l'ouverture et reste ici jusqu'au règlement. Une partie
      -- interrompue par un redémarrage (settled_at NULL) est remboursée au démarrage.
      CREATE TABLE wagers (
        id          TEXT    PRIMARY KEY,
        guild_id    TEXT    NOT NULL,
        game        TEXT    NOT NULL CHECK (game IN ('blackjack', 'roulette', 'morpion', 'puissance4')),
        created_at  INTEGER NOT NULL,
        settled_at  INTEGER
      ) STRICT;
      CREATE INDEX idx_wagers_open ON wagers (created_at) WHERE settled_at IS NULL;

      CREATE TABLE wager_entries (
        id        INTEGER PRIMARY KEY,
        wager_id  TEXT    NOT NULL REFERENCES wagers (id) ON DELETE CASCADE,
        user_id   TEXT    NOT NULL,
        stake     INTEGER NOT NULL CHECK (stake > 0),
        -- Pari de roulette (JSON), NULL pour les autres jeux.
        bet       TEXT
      ) STRICT;
      CREATE INDEX idx_wager_entries ON wager_entries (wager_id);

      -- ===== Mot du jour =====
      CREATE TABLE word_games (
        guild_id  TEXT    NOT NULL,
        user_id   TEXT    NOT NULL,
        -- Jour local (AAAA-MM-JJ) : un mot par serveur et par jour.
        date      TEXT    NOT NULL,
        guesses   TEXT    NOT NULL DEFAULT '[]',
        solved    INTEGER NOT NULL DEFAULT 0 CHECK (solved IN (0, 1)),
        finished  INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
        PRIMARY KEY (guild_id, user_id, date)
      ) STRICT;
    `);
  },
};
