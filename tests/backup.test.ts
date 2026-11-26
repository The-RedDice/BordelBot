import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupDatabase,
  backupFileName,
  BackupScheduler,
  DAY_MS,
  expiredBackups,
  listBackups,
  migrateWithBackup,
  parseBackupFileName,
} from '../src/core/database/backup.js';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';

const T0 = Date.UTC(2026, 10, 26, 4, 0, 0);

describe('noms et rotation', () => {
  it('nomme les sauvegardes de façon triable et relisible', () => {
    const name = backupFileName('daily', T0);
    expect(name).toBe('bot-2026-11-26T04-00-00Z-daily.sqlite');
    expect(parseBackupFileName(name)).toEqual({ name, kind: 'daily', at: T0 });
    expect(parseBackupFileName(backupFileName('pre-v4', T0))?.kind).toBe('pre-v4');
    for (const other of ['bot.sqlite', 'bot-2026-11-26T04-00-00Z-daily.sqlite.tmp', 'notes.txt']) {
      expect(parseBackupFileName(other)).toBeNull();
    }
  });

  it('garde les N plus récentes de chaque sorte (les pre-vN ensemble)', () => {
    const f = (kind: string, day: number) => ({ name: `${kind}-${day}`, kind, at: T0 + day * DAY_MS });
    const files = [f('daily', 1), f('daily', 3), f('daily', 2), f('pre-v3', 1), f('pre-v4', 2), f('manual', 1)];
    expect(expiredBackups(files, 2).map((x) => x.name)).toEqual(['daily-1']);
    expect(expiredBackups(files, 1).map((x) => x.name).sort()).toEqual(['daily-1', 'daily-2', 'pre-v3-1']);
  });
});

describe('sauvegarde sur disque', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bordelbot-backup-'));
    db = openDatabase(join(dir, 'bot.sqlite'));
    runMigrations(db, migrations);
    db.prepare("INSERT INTO user_stats (guild_id, user_id, stat, value) VALUES ('g', 'u', 'games_won', 3)").run();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const backups = () => join(dir, 'backups');

  it('copie la base, sans fichier temporaire, et applique la rotation', async () => {
    let now = T0;
    const options = { dir: backups(), keep: 2, clock: () => now };
    const first = await backupDatabase(db, 'daily', options);
    const copy = new Database(first, { readonly: true });
    expect(copy.prepare('SELECT value FROM user_stats').pluck().get()).toBe(3);
    copy.close();

    for (let i = 0; i < 3; i++) {
      now += DAY_MS;
      await backupDatabase(db, 'daily', options);
    }
    await backupDatabase(db, 'manual', options);
    expect(listBackups(backups()).filter((f) => f.kind === 'daily')).toHaveLength(2);
    expect(existsSync(first)).toBe(false);
    expect(readdirSync(backups()).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('ignore les fichiers étrangers dans le dossier', async () => {
    await backupDatabase(db, 'daily', { dir: backups(), keep: 1, clock: () => T0 });
    writeFileSync(join(backups(), 'notes.txt'), 'à garder');
    await backupDatabase(db, 'daily', { dir: backups(), keep: 1, clock: () => T0 + DAY_MS });
    expect(readdirSync(backups()).sort()).toEqual([backupFileName('daily', T0 + DAY_MS), 'notes.txt']);
  });

  it('ne fait la sauvegarde quotidienne que si la dernière a plus de 24 h', async () => {
    let now = T0;
    const scheduler = new BackupScheduler(db, { dir: backups(), keep: 7, clock: () => now });
    expect(await scheduler.check()).not.toBeNull();
    now += DAY_MS - 60_000;
    expect(await scheduler.check()).toBeNull();
    now += 60_000;
    expect(await scheduler.check()).not.toBeNull();
    expect(listBackups(backups())).toHaveLength(2);
  });
});

describe('sauvegarde avant migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bordelbot-migrate-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const options = (enabled = true) => ({ dir: join(dir, 'backups'), keep: 5, enabled, clock: () => T0 });

  it('sauvegarde une base existante avant de la migrer, et seulement dans ce cas', async () => {
    const db = openDatabase(join(dir, 'bot.sqlite'));
    // Base vierge : rien à protéger.
    runMigrations(db, migrations.filter((m) => m.version <= 3));
    expect(listBackups(options().dir)).toEqual([]);

    const r = await migrateWithBackup(db, migrations, options());
    expect(r.applied).toEqual([4]);
    const files = listBackups(options().dir);
    expect(files.map((f) => f.kind)).toEqual(['pre-v4']);
    const copy = new Database(join(options().dir, files[0]?.name ?? ''), { readonly: true });
    expect(copy.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(3);
    copy.close();

    // Schéma à jour : pas de nouvelle sauvegarde.
    await migrateWithBackup(db, migrations, options());
    expect(listBackups(options().dir)).toHaveLength(1);
    db.close();
  });

  it('ne sauvegarde ni une base vierge ni quand les sauvegardes sont désactivées', async () => {
    const fresh = openDatabase(join(dir, 'fresh.sqlite'));
    expect((await migrateWithBackup(fresh, migrations, options())).applied).toEqual([1, 2, 3, 4]);
    fresh.close();

    const old = openDatabase(join(dir, 'old.sqlite'));
    runMigrations(old, migrations.filter((m) => m.version <= 3));
    await migrateWithBackup(old, migrations, options(false));
    old.close();
    expect(listBackups(options().dir)).toEqual([]);
  });
});
