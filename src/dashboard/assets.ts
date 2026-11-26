import { readFileSync } from 'node:fs';

/**
 * Fichiers de l'interface (`src/dashboard/web/`), lus une fois au démarrage.
 * Le chemin relatif est le même depuis `src/dashboard/` (tsx) et
 * `dist/dashboard/` (build) : rien à copier dans dist/.
 */
export interface Asset {
  readonly type: string;
  readonly body: string;
}

const WEB_DIR = new URL('../../src/dashboard/web/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, WEB_DIR), 'utf8');

export const ASSETS: Readonly<Record<string, Asset>> = {
  '/': { type: 'text/html; charset=utf-8', body: read('index.html') },
  '/app.css': { type: 'text/css; charset=utf-8', body: read('app.css') },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: read('app.js') },
};
