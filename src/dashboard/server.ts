import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '../core/logger.js';
import { ASSETS } from './assets.js';
import {
  authorizeUrl,
  cookie,
  exchangeCode,
  newToken,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sameToken,
  STATE_COOKIE,
  STATE_TTL_S,
  type FetchLike,
  type OAuthConfig,
  type SessionStore,
  type SessionUser,
} from './auth.js';
import type { DashboardData, Directory } from './data.js';
import { avatarUrl } from './directory.js';

export interface DashboardServerDeps {
  readonly oauth: OAuthConfig;
  readonly sessions: SessionStore;
  readonly data: DashboardData;
  readonly directory: Directory;
  readonly logger: Logger;
  readonly fetcher?: FetchLike;
}

/** Politique de sécurité : aucun script ni style extérieur, pas d'intégration dans un cadre. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://discord.com",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Serveur HTTP du tableau de bord (node:http, sans dépendance). Lecture seule :
 * aucune route ne modifie l'économie ni Discord. Les données d'un serveur ne
 * sont servies qu'à ses membres, connectés avec Discord.
 */
export function createDashboardServer(deps: DashboardServerDeps): Server {
  const secure = deps.oauth.publicUrl.startsWith('https://');

  const send = (res: ServerResponse, status: number, body: string, type: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) =>
    send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', headers);
  const redirect = (res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}, status = 302) => {
    res.writeHead(status, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store', ...headers });
    res.end();
  };

  const sessionOf = (req: IncomingMessage): { token: string | undefined; user: SessionUser | null } => {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    return { token, user: deps.sessions.get(token) };
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', deps.oauth.publicUrl);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // ----- Fichiers de la page -----
    const asset = method === 'GET' ? ASSETS[path] : undefined;
    if (asset) return send(res, 200, asset.body, asset.type, { 'Cache-Control': 'no-cache' });
    if (path === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');

    // ----- Connexion Discord -----
    if (path === '/auth/login' && method === 'GET') {
      const state = newToken();
      return redirect(res, authorizeUrl(deps.oauth, state), { 'Set-Cookie': cookie(STATE_COOKIE, state, STATE_TTL_S, secure) });
    }
    if (path === '/auth/callback' && method === 'GET') {
      const clearState = cookie(STATE_COOKIE, '', 0, secure);
      const expected = parseCookies(req.headers.cookie).get(STATE_COOKIE);
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error')) return redirect(res, '/', { 'Set-Cookie': clearState });
      if (!expected || !state || !code || !sameToken(expected, state)) {
        return redirect(res, '/?erreur=etat', { 'Set-Cookie': clearState });
      }
      try {
        const user = await exchangeCode(deps.oauth, code, deps.fetcher);
        const token = deps.sessions.create(user);
        return redirect(res, '/', { 'Set-Cookie': [clearState, cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000, secure)] });
      } catch (err) {
        deps.logger.warn('Tableau de bord : échec de la connexion Discord', err);
        return redirect(res, '/?erreur=connexion', { 'Set-Cookie': clearState });
      }
    }
    if (path === '/auth/logout' && method === 'POST') {
      deps.sessions.destroy(sessionOf(req).token);
      return redirect(res, '/', { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0, secure) }, 303);
    }

    if (method !== 'GET') return json(res, 405, { error: 'Méthode non permise' });

    // ----- API publique : la bourse (aucune donnée personnelle) -----
    if (path === '/api/market') return json(res, 200, deps.data.market());
    const history = /^\/api\/market\/([A-Za-z]{1,8})$/.exec(path);
    if (history) {
      const points = deps.data.history(history[1]!, url.searchParams.get('periode') ?? '24h');
      return points ? json(res, 200, { points }) : json(res, 404, { error: 'Actif ou période inconnus' });
    }

    // ----- API réservée aux membres connectés -----
    if (path.startsWith('/api/')) {
      const { user } = sessionOf(req);
      if (!user) return json(res, 401, { error: 'Connexion requise' });
      if (path === '/api/me') {
        return json(res, 200, {
          user: { id: user.userId, name: user.username, avatarUrl: avatarUrl(user.userId, user.avatar) },
          guilds: await deps.directory.guildsOf(user.userId),
        });
      }
      const guildMatch = /^\/api\/guilds\/(\d+)$/.exec(path);
      if (guildMatch && SNOWFLAKE.test(guildMatch[1]!)) {
        const guildId = guildMatch[1]!;
        const guild = deps.directory.guild(guildId);
        // 404 dans les deux cas : on ne révèle pas la présence du bot sur un serveur dont on n'est pas membre.
        if (!guild || !(await deps.directory.isMember(guildId, user.userId))) return json(res, 404, { error: 'Serveur introuvable' });
        const { userIds, ...overview } = deps.data.overview(guild, user.userId);
        return json(res, 200, { ...overview, users: await deps.directory.users(guildId, userIds) });
      }
    }

    return json(res, 404, { error: 'Introuvable' });
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      deps.logger.error(`Tableau de bord : erreur sur ${req.method} ${req.url}`, err);
      if (!res.headersSent) json(res, 500, { error: 'Erreur interne' });
      else res.end();
    });
  });
}
