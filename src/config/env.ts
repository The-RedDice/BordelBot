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
  /** Tableau de bord web ; null s'il n'est pas configuré (le bot tourne sans). */
  readonly dashboard: DashboardConfig | null;
}

export interface DashboardConfig {
  /** Adresse d'écoute : 127.0.0.1 par défaut (le tunnel Cloudflare s'y connecte en local). */
  readonly host: string;
  readonly port: number;
  /** URL publique, sans / final (ex. https://bot.exemple.fr) : sert à la redirection OAuth. */
  readonly publicUrl: string;
  /** Secret OAuth2 de l'application (Developer Portal > OAuth2). */
  readonly clientSecret: string;
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

/**
 * Le tableau de bord démarre seulement si DASHBOARD_PORT, DASHBOARD_URL et
 * DISCORD_CLIENT_SECRET sont tous renseignés ; une config incomplète est une erreur.
 */
function dashboardConfig(): DashboardConfig | null {
  const port = optional('DASHBOARD_PORT');
  const url = optional('DASHBOARD_URL');
  const secret = optional('DISCORD_CLIENT_SECRET');
  if (!port && !url && !secret) return null;
  if (!port || !url || !secret) {
    throw new Error('Tableau de bord : DASHBOARD_PORT, DASHBOARD_URL et DISCORD_CLIENT_SECRET vont ensemble (ou aucun des trois)');
  }
  if (!/^\d{2,5}$/.test(port) || Number(port) > 65_535) throw new Error(`DASHBOARD_PORT invalide : "${port}"`);
  let publicUrl: URL;
  try {
    publicUrl = new URL(url);
  } catch {
    throw new Error(`DASHBOARD_URL invalide : "${url}"`);
  }
  if (publicUrl.protocol !== 'https:' && publicUrl.hostname !== 'localhost' && publicUrl.hostname !== '127.0.0.1') {
    throw new Error('DASHBOARD_URL doit être en https (seul localhost est permis en http)');
  }
  return {
    host: optional('DASHBOARD_HOST') ?? '127.0.0.1',
    port: Number(port),
    publicUrl: publicUrl.origin,
    clientSecret: secret,
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
    dashboard: dashboardConfig(),
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
