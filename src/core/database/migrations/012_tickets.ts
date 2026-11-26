import type { Migration } from '../migrator.js';

export const ticketsMigration: Migration = {
  version: 12,
  name: 'tickets',
  up(db) {
    db.exec(`
      CREATE TABLE ticket_settings (
        guild_id               TEXT PRIMARY KEY,
        -- Catégorie où créer les salons de tickets (NULL = à la racine du serveur).
        category_id            TEXT,
        -- Rôle du staff : voit tous les tickets et peut les prendre en charge.
        staff_role_id          TEXT,
        -- Salon où archiver les transcriptions (NULL = pas d'archive).
        transcript_channel_id  TEXT,
        -- Message d'accueil posté à l'ouverture (NULL = message par défaut).
        welcome_message        TEXT CHECK (welcome_message IS NULL OR length(welcome_message) <= 1000)
      ) STRICT;

      CREATE TABLE tickets (
        id            INTEGER PRIMARY KEY,
        guild_id      TEXT    NOT NULL,
        -- Numéro lisible, propre à chaque serveur (#1, #2…).
        number        INTEGER NOT NULL,
        channel_id    TEXT    NOT NULL UNIQUE,
        opener_id     TEXT    NOT NULL,
        subject       TEXT    NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
        status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
        claimed_by    TEXT,
        created_at    INTEGER NOT NULL,
        closed_at     INTEGER,
        closed_by     TEXT,
        close_reason  TEXT,
        UNIQUE (guild_id, number)
      ) STRICT;
      -- Un seul ticket ouvert par membre et par serveur.
      CREATE UNIQUE INDEX uq_tickets_open_member ON tickets (guild_id, opener_id) WHERE status = 'open';
    `);
  },
};
