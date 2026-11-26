import 'dotenv/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  readonly discordToken: string;
  readonly discordClientId: string;
  readonly devGuildId: string | undefined;
  readonly databasePath: string;
  readonly logLevel: LogLevel;
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

/** Config complète, nécessaire pour se connecter à Discord. */
export function loadConfig(): AppConfig {
  return {
    discordToken: required('DISCORD_TOKEN'),
    discordClientId: required('DISCORD_CLIENT_ID'),
    devGuildId: optional('DISCORD_DEV_GUILD_ID'),
    databasePath: optional('DATABASE_PATH') ?? './data/bot.sqlite',
    logLevel: parseLogLevel(optional('LOG_LEVEL')),
  };
}

/** Sous-ensemble utilisable sans token (scripts de migration, tests). */
export function loadDatabaseConfig(): Pick<AppConfig, 'databasePath' | 'logLevel'> {
  return {
    databasePath: optional('DATABASE_PATH') ?? './data/bot.sqlite',
    logLevel: parseLogLevel(optional('LOG_LEVEL')),
  };
}
