import type { Db } from '../core/database/connection.js';
import { dayId, monthLabel, PARIS } from '../core/time.js';
import type { EconomyServices } from '../modules/economy/services.js';
import { MARKET_ASSETS } from '../modules/economy/market/assets.js';
import { MARKET_FEE_RATE } from '../modules/economy/market/MarketService.js';
import { levelOf } from '../modules/levels/curve.js';

const DAY = 86_400_000;
const LEADERBOARD_SIZE = 10;

// ---------- Accès à Discord (abstrait, pour les tests) ----------

export interface GuildRef {
  readonly id: string;
  readonly name: string;
  readonly iconUrl: string | null;
  readonly memberCount: number;
}

export interface UserRef {
  readonly name: string;
  readonly avatarUrl: string;
}

/** Ce que le tableau de bord demande à Discord : jamais rien d'autre que de la lecture. */
export interface Directory {
  /** Serveurs communs au bot et au visiteur. */
  guildsOf(userId: string): Promise<GuildRef[]>;
  /** Le visiteur est-il membre de ce serveur (où le bot est présent) ? */
  isMember(guildId: string, userId: string): Promise<boolean>;
  guild(guildId: string): GuildRef | null;
  /** Pseudo et avatar d'une liste de membres. */
  users(guildId: string, userIds: readonly string[]): Promise<Record<string, UserRef>>;
}

// ---------- Statistiques monétaires ----------

export interface MoneyStats {
  /** Pièces en circulation (soldes, hors bourse). */
  readonly total: number;
  /** Comptes avec un solde positif. */
  readonly holders: number;
  readonly average: number;
  readonly median: number;
  /** Part de la monnaie détenue par les 10 % les plus riches (0 à 1). */
  readonly top10Share: number;
}

export function moneyStats(balances: readonly number[]): MoneyStats {
  const sorted = balances.filter((b) => b > 0).sort((a, b) => b - a);
  const total = sorted.reduce((s, b) => s + b, 0);
  const n = sorted.length;
  if (n === 0) return { total: 0, holders: 0, average: 0, median: 0, top10Share: 0 };
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  const topCount = Math.max(1, Math.ceil(n * 0.1));
  const top = sorted.slice(0, topCount).reduce((s, b) => s + b, 0);
  return { total, holders: n, average: Math.round(total / n), median, top10Share: total > 0 ? top / total : 0 };
}

// ---------- Réponses JSON ----------

export interface MarketView {
  readonly fee: number;
  readonly quotes: {
    symbol: string;
    name: string;
    emoji: string;
    price: number;
    change1h: number | null;
    change24h: number | null;
    dividendRate: number | null;
    /** Derniers cours (24 h) pour une mini-courbe. */
    spark: number[];
  }[];
  readonly news: { symbol: string; emoji: string; at: number; change: number; headline: string }[];
}

export const PERIODS: Record<string, number> = { '1h': 3_600_000, '24h': DAY, '7j': 7 * DAY, '30j': 30 * DAY };

interface Row {
  readonly userId: string;
  readonly value: number;
}

export interface GuildOverview {
  readonly guild: GuildRef;
  readonly currency: string;
  readonly users: Record<string, UserRef>;
  readonly me: { balance: number; rank: number | null; level: number; xp: number };
  readonly stats: MoneyStats & {
    /** Valeur des portefeuilles en bourse au cours actuel. */
    invested: number;
    /** Monnaie créée (positive) ou détruite (négative) sur 7 jours. */
    supplyChange7d: number;
    transactions7d: number;
  };
  readonly leaderboards: {
    fortune: Row[];
    seasonEarnings: Row[];
    seasonWins: Row[];
    levels: (Row & { level: number })[];
  };
  readonly season: {
    id: string;
    label: string;
    endsAt: number;
    podiums: { season: string; label: string; podium: { rank: number; userId: string; score: number; reward: number }[] }[];
  };
  readonly lottery: {
    ticketPrice: number;
    current: { pot: number; drawsAt: number; tickets: number; players: number } | null;
    recent: { drawnAt: number; winnerId: string | null; pot: number }[];
  };
  readonly activity: {
    games7d: number;
    wagers7d: number;
    heists7d: { success: number; failed: number };
    wordleToday: number;
    openTickets: number;
  };
}

export interface DataSources {
  readonly db: Db;
  readonly economy: () => EconomyServices;
  /** Classement des niveaux (XP) d'un serveur. */
  readonly levels: (guildId: string, limit: number) => { userId: string; xp: number }[];
  readonly memberXp: (guildId: string, userId: string) => number;
  readonly clock?: () => number;
}

/** Assemble les données des pages à partir des services (lecture seule). */
export class DashboardData {
  private readonly stmts;
  private readonly clock: () => number;

  constructor(private readonly src: DataSources) {
    this.clock = src.clock ?? Date.now;
    const db = src.db;
    this.stmts = {
      balances: db.prepare<[string], number>('SELECT balance FROM economy_accounts WHERE guild_id = ? AND balance > 0').pluck(),
      holdings: db.prepare<[string], { symbol: string; quantity: number }>(
        'SELECT symbol, SUM(quantity) AS quantity FROM market_holdings WHERE guild_id = ? GROUP BY symbol',
      ),
      supply: db.prepare<[string, number], { change: number; count: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS change, COUNT(*) AS count FROM economy_transactions
         WHERE guild_id = ? AND created_at >= ? AND kind NOT IN ('transfer_in', 'transfer_out')`,
      ),
      games: db
        .prepare<[string, number], number>(`SELECT COUNT(*) FROM game_sessions WHERE guild_id = ? AND status = 'finished' AND ended_at >= ?`)
        .pluck(),
      wagers: db
        .prepare<[string, number], number>('SELECT COUNT(*) FROM wagers WHERE guild_id = ? AND settled_at >= ?')
        .pluck(),
      heists: db.prepare<[string, number], { success: number; count: number }>(
        'SELECT success, COUNT(*) AS count FROM heists WHERE guild_id = ? AND at >= ? GROUP BY success',
      ),
      wordle: db.prepare<[string, string], number>('SELECT COUNT(*) FROM word_games WHERE guild_id = ? AND date = ?').pluck(),
      tickets: db.prepare<[string], number>(`SELECT COUNT(*) FROM tickets WHERE guild_id = ? AND status = 'open'`).pluck(),
      recentDraws: db.prepare<[string], { drawnAt: number; winnerId: string | null; pot: number }>(
        `SELECT drawn_at AS drawnAt, winner_id AS winnerId, pot FROM lottery_draws
         WHERE guild_id = ? AND status = 'drawn' ORDER BY drawn_at DESC LIMIT 5`,
      ),
      seasons: db
        .prepare<[string], string>('SELECT DISTINCT season FROM season_results WHERE guild_id = ? ORDER BY season DESC LIMIT 3')
        .pluck(),
    };
  }

  market(): MarketView {
    const { market } = this.src.economy();
    return {
      fee: MARKET_FEE_RATE,
      quotes: MARKET_ASSETS.map((asset) => {
        const q = market.quote(asset);
        return {
          symbol: asset.symbol,
          name: asset.name,
          emoji: asset.emoji,
          price: q.price,
          change1h: q.change1h,
          change24h: q.change24h,
          dividendRate: asset.dividendRate ?? null,
          spark: market.history(asset, DAY, 48).map((p) => p.price),
        };
      }),
      news: market.news(8).map((n) => ({ symbol: n.asset.symbol, emoji: n.asset.emoji, at: n.at, change: n.change, headline: n.headline })),
    };
  }

  /** Historique d'un actif ; null si le symbole ou la période est inconnu. */
  history(symbol: string, period: string): { at: number; price: number }[] | null {
    const { market } = this.src.economy();
    const asset = market.getAsset(symbol);
    const ms = PERIODS[period];
    if (!asset || ms === undefined) return null;
    return market.history(asset, ms, 300);
  }

  /** Données d'un serveur, sans les pseudos (ajoutés ensuite par la couche Discord). */
  overview(guild: GuildRef, viewerId: string): Omit<GuildOverview, 'users'> & { userIds: string[] } {
    const { eco, market, seasons, lottery, events } = this.src.economy();
    const now = this.clock();
    const id = guild.id;
    const weekAgo = now - 7 * DAY;

    const invested = this.stmts.holdings.all(id).reduce((sum, h) => {
      const asset = market.getAsset(h.symbol);
      return asset ? sum + Math.floor(h.quantity * market.quote(asset).price) : sum;
    }, 0);
    const supply = this.stmts.supply.get(id, weekAgo) ?? { change: 0, count: 0 };

    const season = seasons.currentSeason();
    const leaderboards = {
      fortune: eco.leaderboard(id, LEADERBOARD_SIZE).map((r) => ({ userId: r.userId, value: r.balance })),
      seasonEarnings: seasons.earningsBoard(id, season, LEADERBOARD_SIZE),
      seasonWins: seasons.winsBoard(id, season, LEADERBOARD_SIZE),
      levels: this.src.levels(id, LEADERBOARD_SIZE).map((r) => ({ userId: r.userId, value: r.xp, level: levelOf(r.xp) })),
    };
    const podiums = this.stmts.seasons.all(id).map((s) => ({ season: s, label: monthLabel(s), podium: seasons.results(id, s) }));

    const draw = lottery.current(id);
    const entries = draw ? lottery.entries(draw.id) : [];
    const recent = this.stmts.recentDraws.all(id);

    const heists = { success: 0, failed: 0 };
    for (const h of this.stmts.heists.all(id, weekAgo)) heists[h.success ? 'success' : 'failed'] = h.count;

    const xp = this.src.memberXp(id, viewerId);
    const userIds = new Set<string>([
      ...Object.values(leaderboards).flatMap((rows) => rows.map((r) => r.userId)),
      ...podiums.flatMap((p) => p.podium.map((x) => x.userId)),
      ...recent.flatMap((r) => (r.winnerId ? [r.winnerId] : [])),
    ]);

    return {
      guild,
      currency: eco.getSettings(id).currencyName,
      userIds: [...userIds],
      me: { balance: eco.getBalance(id, viewerId), rank: eco.getRank(id, viewerId), level: levelOf(xp), xp },
      stats: { ...moneyStats(this.stmts.balances.all(id)), invested, supplyChange7d: supply.change, transactions7d: supply.count },
      leaderboards,
      season: { id: season, label: monthLabel(season), endsAt: seasons.seasonEnd(season), podiums },
      lottery: {
        ticketPrice: events.get(id).ticketPrice,
        current: draw
          ? { pot: draw.pot, drawsAt: draw.drawsAt, tickets: entries.reduce((s, e) => s + e.count, 0), players: entries.length }
          : null,
        recent,
      },
      activity: {
        games7d: this.stmts.games.get(id, weekAgo) ?? 0,
        wagers7d: this.stmts.wagers.get(id, weekAgo) ?? 0,
        heists7d: heists,
        wordleToday: this.stmts.wordle.get(id, dayId(now, PARIS)) ?? 0,
        openTickets: this.stmts.tickets.get(id) ?? 0,
      },
    };
  }
}
