import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';

describe('migrations', () => {
  it('applique le schéma puis est idempotent', () => {
    const db = openDatabase(':memory:');
    const first = runMigrations(db, migrations);
    expect(first.applied).toEqual([1, 2]);
    const second = runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(2);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual([
      'economy_accounts',
      'economy_transactions',
      'game_participants',
      'game_sessions',
      'guild_settings',
      'inventory_items',
      'moderation_cases',
      'schema_migrations',
      'shop_items',
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
