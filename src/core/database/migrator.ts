import type { Db } from './connection.js';
import type { Logger } from '../logger.js';

export interface Migration {
  /** Entier strictement croissant, jamais réutilisé. */
  readonly version: number;
  readonly name: string;
  up(db: Db): void;
}

export interface MigrationResult {
  readonly applied: readonly number[];
  readonly currentVersion: number;
}

/**
 * Applique les migrations manquantes, chacune dans sa propre transaction.
 * Les migrations sont du code TS (et non des .sql) : elles sont compilées avec
 * le reste et rien n'est à copier dans dist/.
 */
export function runMigrations(db: Db, migrations: readonly Migration[], logger?: Logger): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const m of sorted) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new Error(`Version de migration invalide : ${m.version} (${m.name})`);
    }
    if (versions.has(m.version)) throw new Error(`Version de migration dupliquée : ${m.version}`);
    versions.add(m.version);
  }

  const done = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');

  const applied: number[] = [];
  for (const m of sorted) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      record.run(m.version, m.name, Date.now());
    })();
    applied.push(m.version);
    logger?.info(`Migration appliquée : ${m.version} ${m.name}`);
  }

  const current = (db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number | null) ?? 0;
  return { applied, currentVersion: current };
}
