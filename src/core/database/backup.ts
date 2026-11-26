import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../logger.js';
import type { Db } from './connection.js';
import { hasSchema, pendingMigrations, runMigrations, type Migration, type MigrationResult } from './migrator.js';

/**
 * Sauvegardes de la base SQLite.
 * - `daily` : une par jour, faite à chaud (API de sauvegarde de SQLite, sans arrêter le bot).
 * - `pre-vN` : juste avant d'appliquer des migrations, pour pouvoir revenir en arrière.
 * Chaque sorte garde ses `keep` fichiers les plus récents.
 *
 * Restauration : arrêter le bot, remplacer DATABASE_PATH par la copie choisie
 * (et supprimer les fichiers -wal et -shm), puis redémarrer.
 */

export const BACKUP_PREFIX = 'bot-';
export const BACKUP_EXTENSION = '.sqlite';
export const DAY_MS = 24 * 3_600_000;
/** Vérification régulière : une sauvegarde manquée (bot arrêté) est rattrapée au plus une heure après. */
export const CHECK_INTERVAL_MS = 3_600_000;

export interface BackupFile {
  readonly name: string;
  readonly kind: string;
  readonly at: number;
}

/** `bot-2026-11-26T04-00-00Z-daily.sqlite` : triable, sans « : » (interdit sous Windows). */
export function backupFileName(kind: string, at: number): string {
  const stamp = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
  return `${BACKUP_PREFIX}${stamp}-${kind}${BACKUP_EXTENSION}`;
}

/** Inverse de `backupFileName` ; null pour un fichier qui n'est pas une sauvegarde. */
export function parseBackupFileName(name: string): BackupFile | null {
  const m = /^bot-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z-([a-z0-9-]+)\.sqlite$/.exec(name);
  if (!m) return null;
  const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(at) ? null : { name, kind: m[5] as string, at };
}

/** Sorte de rotation : les sauvegardes `pre-v3`, `pre-v4`… tournent ensemble. */
const rotationGroup = (kind: string) => (kind.startsWith('pre-') ? 'pre' : kind);

/** Fichiers à supprimer pour ne garder que les `keep` plus récents de chaque sorte. */
export function expiredBackups(files: readonly BackupFile[], keep: number): BackupFile[] {
  const groups = new Map<string, BackupFile[]>();
  for (const f of files) groups.set(rotationGroup(f.kind), [...(groups.get(rotationGroup(f.kind)) ?? []), f]);
  return [...groups.values()].flatMap((list) => [...list].sort((a, b) => b.at - a.at).slice(keep));
}

export function listBackups(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map(parseBackupFileName).filter((f): f is BackupFile => f !== null);
}

export interface BackupOptions {
  readonly dir: string;
  /** Nombre de sauvegardes gardées par sorte (au moins 1). */
  readonly keep: number;
  readonly logger?: Logger;
  readonly clock?: () => number;
}

/**
 * Copie la base dans `dir`, vérifie la copie, puis applique la rotation.
 * La copie est écrite sous un nom temporaire puis renommée : un fichier
 * `bot-….sqlite` est toujours complet.
 */
export async function backupDatabase(db: Db, kind: string, options: BackupOptions): Promise<string> {
  const at = (options.clock ?? Date.now)();
  mkdirSync(options.dir, { recursive: true });
  const target = join(options.dir, backupFileName(kind, at));
  const tmp = `${target}.tmp`;
  try {
    await db.backup(tmp);
    // La copie hérite du mode WAL de la base : on la repasse en un seul fichier autonome
    // (openDatabase remet le WAL à la restauration).
    const copy = new Database(tmp);
    try {
      copy.pragma('journal_mode = DELETE');
      const check = copy.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`Copie corrompue (quick_check : ${String(check)})`);
    } finally {
      copy.close();
    }
    renameSync(tmp, target);
  } catch (err) {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
    throw err;
  }

  for (const f of expiredBackups(listBackups(options.dir), Math.max(1, options.keep))) {
    rmSync(join(options.dir, f.name), { force: true });
  }
  const size = statSync(target).size;
  options.logger?.info(`Sauvegarde créée : ${basename(target)} (${(size / 1024 / 1024).toFixed(2)} Mo)`);
  return target;
}

/**
 * Sauvegarde quotidienne : vérifie toutes les heures si la dernière sauvegarde
 * `daily` date de plus de 24 h. Un redémarrage ne décale donc pas le rythme,
 * et un arrêt prolongé est rattrapé dès le démarrage.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly options: BackupOptions,
  ) {}

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fait la sauvegarde du jour si elle est due. Renvoie le chemin créé, ou null. */
  async check(): Promise<string | null> {
    if (this.running) return null;
    const now = (this.options.clock ?? Date.now)();
    const last = Math.max(0, ...listBackups(this.options.dir).filter((f) => f.kind === 'daily').map((f) => f.at));
    if (now - last < DAY_MS) return null;
    this.running = true;
    try {
      return await backupDatabase(this.db, 'daily', this.options);
    } catch (err) {
      this.options.logger?.error('Échec de la sauvegarde quotidienne', err);
      return null;
    } finally {
      this.running = false;
    }
  }
}

/**
 * Applique les migrations, après une sauvegarde `pre-vN` si la base existante
 * va changer (N = première version appliquée). Une base vierge n'est pas
 * sauvegardée : il n'y a rien à protéger. Si la sauvegarde échoue, les
 * migrations ne sont pas appliquées.
 */
export async function migrateWithBackup(
  db: Db,
  migrations: readonly Migration[],
  options: BackupOptions & { readonly enabled: boolean },
): Promise<MigrationResult> {
  const pending = pendingMigrations(db, migrations);
  if (options.enabled && pending.length > 0 && hasSchema(db, migrations)) {
    await backupDatabase(db, `pre-v${pending[0]}`, options);
  }
  return runMigrations(db, migrations, options.logger);
}
