import type { LogFormat, LogLevel } from '../config/env.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

/** Rend une erreur sérialisable (JSON.stringify d'une Error donne `{}`). */
function serializeMeta(meta: unknown): unknown {
  if (meta instanceof Error) {
    const extra = Object.fromEntries(Object.entries(meta));
    return { ...extra, name: meta.name, message: meta.message, stack: meta.stack };
  }
  return meta;
}

/**
 * - `text` : une ligne lisible par événement (développement, `pm2 logs`).
 * - `json` : un objet JSON par ligne (filtrable avec jq, ingérable par un collecteur).
 */
export function createLogger(level: LogLevel = 'info', scope = 'bot', format: LogFormat = 'text'): Logger {
  const min = ORDER[level];
  const write = (lvl: LogLevel, msg: string, meta?: unknown): void => {
    if (ORDER[lvl] < min) return;
    const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
    if (format === 'json') {
      const entry: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, scope, msg };
      if (meta !== undefined) entry['meta'] = serializeMeta(meta);
      let line: string;
      try {
        line = JSON.stringify(entry);
      } catch {
        // Structure circulaire (ex. objet discord.js) : on garde au moins le message.
        line = JSON.stringify({ ...entry, meta: String(meta) });
      }
      out(line);
      return;
    }
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    if (meta === undefined) out(line);
    else out(line, meta);
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    child: (sub) => createLogger(level, `${scope}:${sub}`, format),
  };
}

/** Logger silencieux pour les tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
