import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';

describe('migrations', () => {
  it('applique le schéma puis est idempotent', () => {
    const db = openDatabase(':memory:');
    const first = runMigrations(db, migrations);
    expect(first.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const second = runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(10);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual([
      'achievements',
      'automod_settings',
      'birthday_celebrations',
      'birthday_settings',
      'birthdays',
      'economy_accounts',
      'economy_events',
      'economy_extras',
      'economy_transactions',
      'game_participants',
      'game_sessions',
      'guild_settings',
      'heists',
      'inventory_items',
      'level_members',
      'level_roles',
      'level_settings',
      'lottery_draws',
      'lottery_tickets',
      'market_holdings',
      'market_news',
      'market_prices',
      'moderation_cases',
      'moderation_notes',
      'moderation_thresholds',
      'role_grants',
      'scheduled_jobs',
      'schema_migrations',
      'season_results',
      'season_stats',
      'shop_items',
      'user_stats',
      'wager_entries',
      'wagers',
      'word_games',
    ]);
    db.close();
  });

  it('refuse un solde négatif et une double récompense pour la même partie', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, migrations);
    const now = Date.now();
    db.prepare('INSERT INTO economy_accounts (guild_id, user_id, balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('g', 'u', 0, now, now);
    expect(() => db.prepare("UPDATE economy_accounts SET balance = -1 WHERE user_id = 'u'").run()).toThrow(/CHECK/);

    const reward = db.prepare(
      `INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, kind, reference, created_at)
       VALUES ('g', 'u', 50, 50, 'game_reward', 'session-1', ?)`,
    );
    reward.run(now);
    expect(() => reward.run(now)).toThrow(/UNIQUE/);
    db.close();
  });

  it('la migration 3 conserve les données des tables reconstruites et reprend les statistiques', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, migrations.filter((m) => m.version < 3));
    const now = 1_700_000_000_000;
    db.prepare(
      `INSERT INTO economy_accounts (guild_id, user_id, balance, daily_streak, created_at, updated_at)
       VALUES ('g', 'u', 70, 4, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, kind, reference, created_at, note)
       VALUES ('g', 'u', 70, 70, 'game_reward', 's1', ?, 'mole')`,
    ).run(now);
    db.prepare(
      `INSERT INTO moderation_cases (guild_id, case_number, action, target_id, moderator_id, reason, created_at)
       VALUES ('g', 1, 'warn', 'u', 'mod', 'spam', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO game_sessions (id, guild_id, channel_id, game, host_id, status, created_at)
       VALUES ('s1', 'g', 'c', 'mole', 'u', 'finished', ?), ('s2', 'g', 'c', 'mole', 'u', 'cancelled', ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO game_participants (session_id, user_id, role, result)
       VALUES ('s1', 'u', 'mole', 'win'), ('s1', 'v', 'agent', 'loss'), ('s2', 'u', NULL, NULL)`,
    ).run();

    expect(runMigrations(db, migrations.filter((m) => m.version <= 3)).applied).toEqual([3]);

    expect(db.prepare('SELECT amount, note, kind FROM economy_transactions').get()).toEqual({
      amount: 70,
      note: 'mole',
      kind: 'game_reward',
    });
    expect(db.prepare('SELECT reason, resolved_at FROM moderation_cases').get()).toEqual({ reason: 'spam', resolved_at: null });
    const stats = db.prepare('SELECT user_id, stat, value FROM user_stats ORDER BY user_id, stat').all();
    expect(stats).toEqual([
      { user_id: 'u', stat: 'daily_best_streak', value: 4 },
      { user_id: 'u', stat: 'games_played', value: 1 },
      { user_id: 'u', stat: 'games_won', value: 1 },
      { user_id: 'v', stat: 'games_played', value: 1 },
    ]);
    // Les nouveaux types sont acceptés, et l'index d'idempotence existe toujours.
    db.prepare(
      `INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, kind, created_at)
       VALUES ('g', 'u', -10, 60, 'gamble', ?)`,
    ).run(now);
    expect(() =>
      db
        .prepare(
          `INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, kind, reference, created_at)
           VALUES ('g', 'u', 70, 130, 'game_reward', 's1', ?)`,
        )
        .run(now),
    ).toThrow(/UNIQUE/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it("annule une migration en échec sans l'enregistrer", () => {
    const db = openDatabase(':memory:');
    const broken = {
      version: 1,
      name: 'broken',
      up: (d: typeof db) => {
        d.exec('CREATE TABLE t (x INTEGER)');
        throw new Error('fail');
      },
    };
    expect(() => runMigrations(db, [broken])).toThrow('fail');
    const exists = db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 't'").pluck().get();
    expect(exists).toBe(0);
    expect(runMigrations(db, []).currentVersion).toBe(0);
    db.close();
  });
});
