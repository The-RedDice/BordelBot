import type { Migration } from '../migrator.js';

/**
 * Jeux d'argent, succès, bourse, paliers de sanctions, bans temporaires,
 * verrouillage et mode lent des salons.
 *
 * SQLite ne sait pas modifier une contrainte CHECK : les tables dont la liste
 * de valeurs autorisées s'allonge (economy_transactions.kind,
 * moderation_cases.action) sont reconstruites à l'identique, données comprises.
 */
export const featuresMigration: Migration = {
  version: 3,
  name: 'gambling_achievements_market_automod',
  up(db) {
    db.exec(`
      -- ===== Journal économique : nouveaux types d'opérations =====
      CREATE TABLE economy_transactions_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT    NOT NULL,
        user_id          TEXT    NOT NULL,
        amount           INTEGER NOT NULL,
        balance_after    INTEGER NOT NULL,
        kind             TEXT    NOT NULL CHECK (kind IN
                           ('daily','transfer_in','transfer_out','game_reward','purchase','admin_adjust',
                            'gamble','duel','market_buy','market_sell','achievement')),
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

      -- ===== Réglages =====
      -- Mise maximale aux jeux d'argent (0 = jeux d'argent désactivés).
      ALTER TABLE guild_settings ADD COLUMN max_bet INTEGER NOT NULL DEFAULT 10000 CHECK (max_bet >= 0);
      -- Durée de validité d'un avertissement, en jours (0 = permanent).
      ALTER TABLE guild_settings ADD COLUMN warn_expiry_days INTEGER NOT NULL DEFAULT 0
        CHECK (warn_expiry_days BETWEEN 0 AND 3650);

      -- ===== Statistiques et succès =====
      CREATE TABLE user_stats (
        guild_id  TEXT    NOT NULL,
        user_id   TEXT    NOT NULL,
        stat      TEXT    NOT NULL,
        value     INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, stat)
      ) STRICT;

      CREATE TABLE achievements (
        guild_id     TEXT    NOT NULL,
        user_id      TEXT    NOT NULL,
        achievement  TEXT    NOT NULL,
        unlocked_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, achievement)
      ) STRICT;

      -- Les parties déjà jouées comptent dans les statistiques.
      INSERT INTO user_stats (guild_id, user_id, stat, value)
        SELECT s.guild_id, p.user_id, 'games_played', COUNT(*)
        FROM game_participants p JOIN game_sessions s ON s.id = p.session_id
        WHERE s.status = 'finished' AND p.result IS NOT NULL
        GROUP BY s.guild_id, p.user_id;
      INSERT INTO user_stats (guild_id, user_id, stat, value)
        SELECT s.guild_id, p.user_id, 'games_won', COUNT(*)
        FROM game_participants p JOIN game_sessions s ON s.id = p.session_id
        WHERE s.status = 'finished' AND p.result = 'win'
        GROUP BY s.guild_id, p.user_id;
      INSERT INTO user_stats (guild_id, user_id, stat, value)
        SELECT guild_id, user_id, 'daily_best_streak', daily_streak
        FROM economy_accounts WHERE daily_streak > 0;

      -- ===== Bourse =====
      -- Cours communs à tous les serveurs ; chaque serveur a ses propres portefeuilles.
      CREATE TABLE market_prices (
        symbol  TEXT    NOT NULL,
        at      INTEGER NOT NULL,
        price   REAL    NOT NULL CHECK (price > 0),
        PRIMARY KEY (symbol, at)
      ) STRICT;

      CREATE TABLE market_holdings (
        guild_id    TEXT    NOT NULL,
        user_id     TEXT    NOT NULL,
        symbol      TEXT    NOT NULL,
        quantity    INTEGER NOT NULL CHECK (quantity > 0),
        cost_basis  INTEGER NOT NULL CHECK (cost_basis >= 0),  -- total payé (frais compris) pour les parts détenues
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, symbol)
      ) STRICT;

      CREATE TABLE market_news (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol    TEXT    NOT NULL,
        at        INTEGER NOT NULL,
        change    REAL    NOT NULL,
        headline  TEXT    NOT NULL
      ) STRICT;
      CREATE INDEX idx_news_at ON market_news (at DESC);

      -- ===== Modération =====
      CREATE TABLE moderation_cases_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT    NOT NULL,
        case_number   INTEGER NOT NULL,
        action        TEXT    NOT NULL CHECK (action IN
                        ('warn','timeout','untimeout','kick','ban','unban','purge','lock','unlock','slowmode')),
        target_id     TEXT    NOT NULL,
        moderator_id  TEXT    NOT NULL,
        reason        TEXT,
        duration_ms   INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
        expires_at    INTEGER,
        metadata      TEXT,
        revoked       INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
        created_at    INTEGER NOT NULL,
        -- Ban temporaire levé, ou verrouillage annulé : la tâche n'est plus à traiter.
        resolved_at   INTEGER,
        UNIQUE (guild_id, case_number)
      ) STRICT;
      INSERT INTO moderation_cases_new
        (id, guild_id, case_number, action, target_id, moderator_id, reason, duration_ms, expires_at, metadata,
         revoked, created_at)
        SELECT id, guild_id, case_number, action, target_id, moderator_id, reason, duration_ms, expires_at, metadata,
               revoked, created_at
        FROM moderation_cases;
      DROP TABLE moderation_cases;
      ALTER TABLE moderation_cases_new RENAME TO moderation_cases;
      CREATE INDEX idx_cases_target ON moderation_cases (guild_id, target_id, created_at DESC);
      CREATE INDEX idx_cases_pending_unban ON moderation_cases (expires_at)
        WHERE action = 'ban' AND expires_at IS NOT NULL AND resolved_at IS NULL;

      CREATE TABLE moderation_thresholds (
        guild_id     TEXT    NOT NULL,
        warn_count   INTEGER NOT NULL CHECK (warn_count BETWEEN 1 AND 50),
        action       TEXT    NOT NULL CHECK (action IN ('timeout','kick','ban')),
        duration_ms  INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
        PRIMARY KEY (guild_id, warn_count)
      ) STRICT;
    `);
  },
};
