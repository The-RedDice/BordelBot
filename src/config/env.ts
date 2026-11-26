import 'dotenv/config';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

export interface AppConfig {
  readonly discordToken: string;
  readonly discordClientId: string;
  readonly devGuildId: string | undefined;
  readonly databasePath: string;
  /** Dossier des sauvegardes (par défaut : `backups/` à côté de la base). */
  readonly backupDir: string;
  /** Sauvegardes gardées par sorte ; 0 désactive les sauvegardes. */
  readonly backupKeep: number;
  readonly logLevel: LogLevel;
  readonly logFormat: LogFormat;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return 'info';
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new Error(`LOG_LEVEL invalide : "${raw}" (attendu : ${LOG_LEVELS.join(', ')})`);
}

function parseLogFormat(raw: string | undefined): LogFormat {
  if (raw === undefined) return 'text';
  if (raw === 'text' || raw === 'json') return raw;
  throw new Error(`LOG_FORMAT invalide : "${raw}" (attendu : text, json)`);
}

function parseBackupKeep(raw: string | undefined): number {
  if (raw === undefined) return 7;
  if (!/^\d{1,3}$/.test(raw)) throw new Error(`BACKUP_KEEP invalide : "${raw}" (attendu : un entier, 0 pour désactiver)`);
  return Number(raw);
}

/** Base et sauvegardes : communes au bot et aux scripts. */
function databaseConfig() {
  const databasePath = optional('DATABASE_PATH') ?? './data/bot.sqlite';
  return {
    databasePath,
    backupDir: optional('BACKUP_DIR') ?? join(dirname(databasePath), 'backups'),
    backupKeep: parseBackupKeep(optional('BACKUP_KEEP')),
  };
}

/** Config complète, nécessaire pour se connecter à Discord. */
export function loadConfig(): AppConfig {
  return {
    discordToken: required('DISCORD_TOKEN'),
    discordClientId: required('DISCORD_CLIENT_ID'),
    devGuildId: optional('DISCORD_DEV_GUILD_ID'),
    ...databaseConfig(),
    logLevel: parseLogLevel(optional('LOG_LEVEL')),
    logFormat: parseLogFormat(optional('LOG_FORMAT')),
  };
}

/** Sous-ensemble utilisable sans token (scripts de migration, tests). */
export function loadDatabaseConfig(): Pick<AppConfig, 'databasePath' | 'backupDir' | 'backupKeep' | 'logLevel' | 'logFormat'> {
  return {
    ...databaseConfig(),
    logLevel: parseLogLevel(optional('LOG_LEVEL')),
    logFormat: parseLogFormat(optional('LOG_FORMAT')),
  };
}
