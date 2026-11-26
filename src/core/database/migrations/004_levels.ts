import type { Migration } from '../migrator.js';

export const levelsMigration: Migration = {
  version: 4,
  name: 'levels',
  up(db) {
    db.exec(`
      -- ===== XP et niveaux =====
      CREATE TABLE level_members (
        guild_id            TEXT    NOT NULL,
        user_id             TEXT    NOT NULL,
        xp                  INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
        messages            INTEGER NOT NULL DEFAULT 0,
        voice_seconds       INTEGER NOT NULL DEFAULT 0,
        -- Dernier message qui a rapporté de l'XP (délai entre deux gains).
        last_message_xp_at  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      ) STRICT;
      CREATE INDEX idx_level_members_xp ON level_members (guild_id, xp DESC);

      CREATE TABLE level_settings (
        guild_id             TEXT    PRIMARY KEY,
        message_xp_min       INTEGER NOT NULL DEFAULT 15 CHECK (message_xp_min BETWEEN 0 AND 1000),
        message_xp_max       INTEGER NOT NULL DEFAULT 25 CHECK (message_xp_max BETWEEN message_xp_min AND 1000),
        cooldown_seconds     INTEGER NOT NULL DEFAULT 60 CHECK (cooldown_seconds BETWEEN 0 AND 3600),
        voice_xp_per_minute  INTEGER NOT NULL DEFAULT 5 CHECK (voice_xp_per_minute BETWEEN 0 AND 1000),
        -- here : salon du message ; channel : salon dédié ; off : pas d'annonce.
        announce             TEXT    NOT NULL DEFAULT 'here' CHECK (announce IN ('here', 'channel', 'off')),
        announce_channel_id  TEXT,
        -- 1 : on garde les rôles des paliers précédents ; 0 : seul le plus haut reste.
        stack_roles          INTEGER NOT NULL DEFAULT 1 CHECK (stack_roles IN (0, 1))
      ) STRICT;

      CREATE TABLE level_roles (
        guild_id  TEXT    NOT NULL,
        level     INTEGER NOT NULL CHECK (level BETWEEN 1 AND 1000),
        role_id   TEXT    NOT NULL,
        PRIMARY KEY (guild_id, level)
      ) STRICT;

      -- Classements /top par statistique.
      CREATE INDEX idx_user_stats_rank ON user_stats (guild_id, stat, value DESC);
    `);
  },
};
