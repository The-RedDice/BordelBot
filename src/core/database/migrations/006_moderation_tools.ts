import type { Migration } from '../migrator.js';

export const moderationToolsMigration: Migration = {
  version: 6,
  name: 'moderation_tools',
  up(db) {
    db.exec(`
      -- ===== Logs des messages modifiés et supprimés =====
      ALTER TABLE guild_settings ADD COLUMN message_log_channel_id TEXT;

      -- ===== Notes de modération (internes, ne comptent pas comme avertissements) =====
      CREATE TABLE moderation_notes (
        id          INTEGER PRIMARY KEY,
        guild_id    TEXT    NOT NULL,
        target_id   TEXT    NOT NULL,
        author_id   TEXT    NOT NULL,
        content     TEXT    NOT NULL CHECK (length(content) BETWEEN 1 AND 1000),
        created_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX idx_moderation_notes_target ON moderation_notes (guild_id, target_id, created_at DESC);

      -- ===== Automod du bot (flood, messages répétés) =====
      CREATE TABLE automod_settings (
        guild_id         TEXT    PRIMARY KEY,
        -- Flood : plus de flood_messages messages en flood_seconds secondes (0 = désactivé).
        flood_messages   INTEGER NOT NULL DEFAULT 0 CHECK (flood_messages = 0 OR flood_messages BETWEEN 3 AND 50),
        flood_seconds    INTEGER NOT NULL DEFAULT 5 CHECK (flood_seconds BETWEEN 1 AND 60),
        -- Messages identiques répétés (0 = désactivé).
        duplicate_count  INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count = 0 OR duplicate_count BETWEEN 2 AND 20),
        -- Exclusion immédiate à chaque infraction (0 = aucune).
        timeout_ms       INTEGER NOT NULL DEFAULT 300000 CHECK (timeout_ms BETWEEN 0 AND 2419200000),
        -- 1 : une infraction à l'AutoMod de Discord vaut un avertissement.
        discord_warns    INTEGER NOT NULL DEFAULT 0 CHECK (discord_warns IN (0, 1))
      ) STRICT;
    `);
  },
};
