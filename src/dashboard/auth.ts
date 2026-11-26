import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../core/database/connection.js';

export const SESSION_COOKIE = 'bb_session';
export const STATE_COOKIE = 'bb_oauth_state';
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;
export const STATE_TTL_S = 600;
const DISCORD_API = 'https://discord.com/api/v10';

export interface SessionUser {
  readonly userId: string;
  readonly username: string;
  readonly avatar: string | null;
}

/** Jeton aléatoire (256 bits), encodé pour une URL ou un cookie. */
export const newToken = (): string => randomBytes(32).toString('base64url');
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Comparaison en temps constant (état OAuth). */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sessions en base : seule l'empreinte du jeton est gardée. */
export class SessionStore {
  private readonly stmts;

  constructor(
    db: Db,
    private readonly clock: () => number = Date.now,
  ) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO dashboard_sessions (token_hash, user_id, username, avatar, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      get: db.prepare<[string, number], SessionUser>(
        `SELECT user_id AS userId, username, avatar FROM dashboard_sessions WHERE token_hash = ? AND expires_at > ?`,
      ),
      remove: db.prepare('DELETE FROM dashboard_sessions WHERE token_hash = ?'),
      purge: db.prepare('DELETE FROM dashboard_sessions WHERE expires_at <= ?'),
    };
  }

  /** Ouvre une session ; renvoie le jeton à mettre dans le cookie. */
  create(user: SessionUser): string {
    const token = newToken();
    const now = this.clock();
    this.stmts.insert.run(hash(token), user.userId, user.username, user.avatar, now, now + SESSION_TTL_MS);
    return token;
  }

  get(token: string | undefined): SessionUser | null {
    if (!token) return null;
    return this.stmts.get.get(hash(token), this.clock()) ?? null;
  }

  destroy(token: string | undefined): void {
    if (token) this.stmts.remove.run(hash(token));
  }

  /** Supprime les sessions expirées ; renvoie leur nombre. */
  purge(): number {
    return this.stmts.purge.run(this.clock()).changes;
  }
}

/** Lit l'en-tête Cookie. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // valeur mal encodée : ignorée
    }
  }
  return cookies;
}

/** Cookie HttpOnly, SameSite=Lax, Secure en HTTPS. `maxAge` 0 efface le cookie. */
export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** URL publique du tableau de bord (sans / final). */
  readonly publicUrl: string;
}

export const redirectUri = (c: OAuthConfig): string => `${c.publicUrl}/auth/callback`;

/** Page d'autorisation Discord : seul le scope `identify` est demandé (identité, pas la liste des serveurs). */
export function authorizeUrl(c: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(c),
    scope: 'identify',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Échange le code d'autorisation contre l'identité Discord du visiteur. Le jeton
 * d'accès n'est utilisé qu'une fois et n'est pas conservé.
 */
export async function exchangeCode(c: OAuthConfig, code: string, fetcher: FetchLike = fetch): Promise<SessionUser> {
  const tokenRes = await fetcher(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(c),
      client_id: c.clientId,
      client_secret: c.clientSecret,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`Discord a refusé le code d'autorisation (HTTP ${tokenRes.status})`);
  const token = (await tokenRes.json()) as { access_token?: unknown; token_type?: unknown };
  if (typeof token.access_token !== 'string') throw new Error('Réponse OAuth sans access_token');

  const userRes = await fetcher(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) throw new Error(`Identité Discord illisible (HTTP ${userRes.status})`);
  const user = (await userRes.json()) as { id?: unknown; username?: unknown; global_name?: unknown; avatar?: unknown };
  if (typeof user.id !== 'string' || typeof user.username !== 'string') throw new Error('Identité Discord incomplète');
  return {
    userId: user.id,
    username: typeof user.global_name === 'string' && user.global_name ? user.global_name : user.username,
    avatar: typeof user.avatar === 'string' ? user.avatar : null,
  };
}
