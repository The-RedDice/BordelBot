import type { LogLevel } from '../config/env.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel = 'info', scope = 'bot'): Logger {
  const min = ORDER[level];
  const write = (lvl: LogLevel, msg: string, meta?: unknown): void => {
    if (ORDER[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
    if (meta === undefined) out(line);
    else out(line, meta);
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    child: (sub) => createLogger(level, `${scope}:${sub}`),
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
