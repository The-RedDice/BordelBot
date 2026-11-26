import type { Migration } from '../migrator.js';

export const lotterySeasonsMigration: Migration = {
  version: 10,
  name: 'lottery_seasons',
  up(db) {
    db.exec(`
      -- ===== Réglages : loterie et saisons =====
      CREATE TABLE economy_events (
        guild_id             TEXT    PRIMARY KEY,
        -- Prix du ticket ; 0 = loterie désactivée.
        ticket_price         INTEGER NOT NULL DEFAULT 100 CHECK (ticket_price BETWEEN 0 AND 1000000000),
        -- Salon des annonces (tirage, podium de la saison).
        channel_id           TEXT,
        -- Rôle « Champion du mois », gardé jusqu'à la saison suivante.
        champion_role_id     TEXT,
        champion_user_id     TEXT,
        reward1              INTEGER NOT NULL DEFAULT 1000 CHECK (reward1 BETWEEN 0 AND 1000000000),
        reward2              INTEGER NOT NULL DEFAULT 500  CHECK (reward2 BETWEEN 0 AND 1000000000),
        reward3              INTEGER NOT NULL DEFAULT 250  CHECK (reward3 BETWEEN 0 AND 1000000000)
      ) STRICT;

      -- ===== Loterie hebdomadaire =====
      CREATE TABLE lottery_draws (
        id         INTEGER PRIMARY KEY,
        guild_id   TEXT    NOT NULL,
        draws_at   INTEGER NOT NULL,
        -- Cagnotte : 90 % du prix des tickets vendus.
        pot        INTEGER NOT NULL DEFAULT 0 CHECK (pot >= 0),
        status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'drawn')),
        winner_id  TEXT,
        drawn_at   INTEGER
      ) STRICT;
      -- Un seul tirage ouvert par serveur.
      CREATE UNIQUE INDEX uq_lottery_open ON lottery_draws (guild_id) WHERE status = 'open';

      CREATE TABLE lottery_tickets (
        draw_id  INTEGER NOT NULL REFERENCES lottery_draws (id) ON DELETE CASCADE,
        user_id  TEXT    NOT NULL,
        count    INTEGER NOT NULL CHECK (count > 0),
        PRIMARY KEY (draw_id, user_id)
      ) STRICT;

      -- ===== Saisons mensuelles =====
      -- Compteurs du mois (les gains, eux, se calculent à partir du journal économique).
      CREATE TABLE season_stats (
        guild_id  TEXT    NOT NULL,
        season    TEXT    NOT NULL,
        user_id   TEXT    NOT NULL,
        wins      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, season, user_id)
      ) STRICT;

      -- Podium archivé de chaque saison terminée.
      CREATE TABLE season_results (
        guild_id  TEXT    NOT NULL,
        season    TEXT    NOT NULL,
        rank      INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
        user_id   TEXT    NOT NULL,
        score     INTEGER NOT NULL,
        reward    INTEGER NOT NULL,
        PRIMARY KEY (guild_id, season, rank)
      ) STRICT;
    `);
  },
};
