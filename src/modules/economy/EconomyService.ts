import type { BotContext } from '../../core/context.js';
import type { Db } from '../../core/database/connection.js';
import type { BotEvents } from '../../core/events.js';
import type { Logger } from '../../core/logger.js';
import { computeGameReward } from './rewards.js';

// ---------- Constantes ----------

/** Plafond d'un montant unitaire et d'un solde : bien en deçà de Number.MAX_SAFE_INTEGER. */
export const MAX_AMOUNT = 1_000_000_000_000;
export const DAILY_COOLDOWN_MS = 24 * 3_600_000;
/** Au-delà de ce délai depuis le dernier daily, la série repart à 1. */
export const STREAK_WINDOW_MS = 48 * 3_600_000;
/** +10 % de la base par jour de série, au plus +100 %. */
export const STREAK_BONUS_STEP = 0.1;
export const MAX_STREAK_BONUS_DAYS = 10;
export const MAX_PURCHASE_QUANTITY = 100;
export const ITEM_KEY_PATTERN = /^[a-z0-9-]{1,32}$/;
/** Nombre maximal de lignes d'un export CSV (≈ 2 Mo, sous la limite d'upload de Discord). */
export const MAX_EXPORT_ROWS = 20_000;

// ---------- Types ----------

export interface GuildEconomySettings {
  readonly currencyName: string;
  readonly dailyAmount: number;
  readonly gameWinReward: number;
  /** Mise maximale aux jeux d'argent ; 0 les désactive. */
  readonly maxBet: number;
}

export const DEFAULT_SETTINGS: GuildEconomySettings = {
  currencyName: 'pièces',
  dailyAmount: 100,
  gameWinReward: 50,
  maxBet: 10_000,
};

export type TransactionKind =
  | 'daily'
  | 'transfer_in'
  | 'transfer_out'
  | 'game_reward'
  | 'purchase'
  | 'admin_adjust'
  | 'gamble'
  | 'duel'
  | 'market_buy'
  | 'market_sell'
  | 'achievement'
  | 'birthday';

export interface Transaction {
  readonly id: number;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly kind: TransactionKind;
  readonly counterpartyId: string | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly createdAt: number;
}

export interface ShopItem {
  readonly id: number;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly price: number;
  readonly stackable: boolean;
  readonly enabled: boolean;
}

export interface InventoryEntry {
  readonly key: string;
  readonly name: string;
  readonly quantity: number;
}

export interface DailyClaim {
  readonly amount: number;
  readonly bonus: number;
  readonly streak: number;
  readonly balance: number;
  readonly nextAt: number;
}

export interface TransferReceipt {
  readonly amount: number;
  readonly fromBalance: number;
  readonly toBalance: number;
}

export interface Purchase {
  readonly item: ShopItem;
  readonly quantity: number;
  readonly total: number;
  readonly balance: number;
}

export interface GameRewardResult {
  readonly amountPerWinner: number;
  readonly credited: readonly string[];
  /** Gagnants déjà récompensés pour cette partie (événement rejoué). */
  readonly skipped: readonly string[];
}

export type EconomyErrorCode =
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_FUNDS'
  | 'BALANCE_CAP'
  | 'SELF_TRANSFER'
  | 'DAILY_COOLDOWN'
  | 'DAILY_DISABLED'
  | 'INVALID_SETTINGS'
  | 'INVALID_ITEM'
  | 'ITEM_NOT_FOUND'
  | 'INVALID_QUANTITY'
  | 'ALREADY_OWNED'
  | 'GAMBLING_DISABLED'
  | 'BET_TOO_HIGH'
  | 'UNKNOWN_ASSET'
  | 'INSUFFICIENT_SHARES'
  | 'TRADE_TOO_SMALL'
  | 'WAGER_CLOSED';

export interface EconomyError {
  readonly code: EconomyErrorCode;
  /** Destiné à l'utilisateur, affichable tel quel. */
  readonly message: string;
  /** Pour DAILY_COOLDOWN : moment où réessayer (epoch ms). */
  readonly retryAt?: number;
}

export type EcoResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: EconomyError };

/** Levée dans une transaction pour l'annuler ; convertie en résultat par `run`. */
class EconomyFailure extends Error {
  constructor(readonly error: EconomyError) {
    super(error.message);
  }
}

export function fail(code: EconomyErrorCode, message: string, extra: { retryAt?: number } = {}): never {
  throw new EconomyFailure({ code, message, ...extra });
}

export function formatAmount(amount: number, currency: string): string {
  return `${new Intl.NumberFormat('fr-FR').format(amount)} ${currency}`;
}

function isValidAmount(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_AMOUNT;
}

// ---------- Requêtes ----------

interface ItemRow {
  id: number;
  key: string;
  name: string;
  description: string;
  price: number;
  stackable: number;
  enabled: number;
}

const ITEM_COLUMNS = 'id, key, name, description, price, stackable, enabled';

/** Ligne d'export : une transaction et son titulaire. */
export interface ExportRow extends Transaction {
  readonly userId: string;
}

const EXPORT_COLUMNS = `id, user_id AS userId, amount, balance_after AS balanceAfter, kind,
  counterparty_id AS counterpartyId, reference, note, created_at AS createdAt`;
const toItem = (r: ItemRow): ShopItem => ({ ...r, stackable: r.stackable === 1, enabled: r.enabled === 1 });

function prepareStatements(db: Db) {
  return {
    getSettings: db.prepare<[string], GuildEconomySettings>(
      `SELECT currency_name AS currencyName, daily_amount AS dailyAmount, game_win_reward AS gameWinReward,
              max_bet AS maxBet
       FROM guild_settings WHERE guild_id = ?`,
    ),
    upsertSettings: db.prepare(
      `INSERT INTO guild_settings (guild_id, currency_name, daily_amount, game_win_reward, max_bet, created_at, updated_at)
       VALUES (@guildId, @currencyName, @dailyAmount, @gameWinReward, @maxBet, @now, @now)
       ON CONFLICT (guild_id) DO UPDATE SET
         currency_name = excluded.currency_name, daily_amount = excluded.daily_amount,
         game_win_reward = excluded.game_win_reward, max_bet = excluded.max_bet, updated_at = excluded.updated_at`,
    ),
    getAccount: db.prepare<[string, string], { balance: number; lastDailyAt: number | null; dailyStreak: number }>(
      `SELECT balance, last_daily_at AS lastDailyAt, daily_streak AS dailyStreak
       FROM economy_accounts WHERE guild_id = ? AND user_id = ?`,
    ),
    ensureAccount: db.prepare(
      `INSERT INTO economy_accounts (guild_id, user_id, balance, created_at, updated_at)
       VALUES (@guildId, @userId, 0, @now, @now) ON CONFLICT DO NOTHING`,
    ),
    setBalance: db.prepare(
      `UPDATE economy_accounts SET balance = @balance, updated_at = @now WHERE guild_id = @guildId AND user_id = @userId`,
    ),
    setDaily: db.prepare(
      `UPDATE economy_accounts SET last_daily_at = @now, daily_streak = @streak
       WHERE guild_id = @guildId AND user_id = @userId`,
    ),
    insertTx: db.prepare(
      `INSERT INTO economy_transactions
         (guild_id, user_id, amount, balance_after, kind, counterparty_id, reference, note, created_at)
       VALUES (@guildId, @userId, @amount, @balanceAfter, @kind, @counterpartyId, @reference, @note, @now)`,
    ),
    hasReward: db
      .prepare<[string, string, string], number>(
        `SELECT 1 FROM economy_transactions
         WHERE guild_id = ? AND user_id = ? AND kind = 'game_reward' AND reference = ?`,
      )
      .pluck(),
    hasBirthdayBonus: db
      .prepare<[string, string, string], number>(
        `SELECT 1 FROM economy_transactions
         WHERE guild_id = ? AND user_id = ? AND kind = 'birthday' AND reference = ?`,
      )
      .pluck(),
    leaderboard: db.prepare<[string, number], { userId: string; balance: number }>(
      `SELECT user_id AS userId, balance FROM economy_accounts
       WHERE guild_id = ? AND balance > 0 ORDER BY balance DESC, user_id LIMIT ?`,
    ),
    countRicher: db
      .prepare<[string, number], number>('SELECT COUNT(*) FROM economy_accounts WHERE guild_id = ? AND balance > ?')
      .pluck(),
    history: db.prepare<[string, string, number], Transaction>(
      `SELECT id, amount, balance_after AS balanceAfter, kind, counterparty_id AS counterpartyId,
              reference, note, created_at AS createdAt
       FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?`,
    ),
    exportAll: db.prepare<[string, number], ExportRow>(
      `SELECT * FROM (
         SELECT ${EXPORT_COLUMNS} FROM economy_transactions WHERE guild_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id`,
    ),
    exportUser: db.prepare<[string, string, number], ExportRow>(
      `SELECT * FROM (
         SELECT ${EXPORT_COLUMNS} FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id`,
    ),
    getItem: db.prepare<[string, string], ItemRow>(`SELECT ${ITEM_COLUMNS} FROM shop_items WHERE guild_id = ? AND key = ?`),
    listItems: db.prepare<[string], ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM shop_items WHERE guild_id = ? AND enabled = 1 ORDER BY price, name`,
    ),
    upsertItem: db.prepare(
      `INSERT INTO shop_items (guild_id, key, name, description, price, stackable, enabled, created_at)
       VALUES (@guildId, @key, @name, @description, @price, @stackable, 1, @now)
       ON CONFLICT (guild_id, key) DO UPDATE SET
         name = excluded.name, description = excluded.description, price = excluded.price,
         stackable = excluded.stackable, enabled = 1`,
    ),
    disableItem: db.prepare('UPDATE shop_items SET enabled = 0 WHERE guild_id = ? AND key = ? AND enabled = 1'),
    ownedQuantity: db
      .prepare<[string, string, number], number>(
        'SELECT quantity FROM inventory_items WHERE guild_id = ? AND user_id = ? AND item_id = ?',
      )
      .pluck(),
    addInventory: db.prepare(
      `INSERT INTO inventory_items (guild_id, user_id, item_id, quantity, acquired_at)
       VALUES (@guildId, @userId, @itemId, @quantity, @now)
       ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
    ),
    inventory: db.prepare<[string, string], InventoryEntry>(
      `SELECT i.key, i.name, inv.quantity FROM inventory_items inv
       JOIN shop_items i ON i.id = inv.item_id
       WHERE inv.guild_id = ? AND inv.user_id = ? ORDER BY i.name`,
    ),
  };
}

export interface DeltaParams {
  readonly guildId: string;
  readonly userId: string;
  readonly delta: number;
  readonly kind: TransactionKind;
  readonly counterpartyId?: string | null;
  readonly reference?: string | null;
  readonly note?: string | null;
}

type BalanceChange = BotEvents['economy:balanceChanged'];

/**
 * Accès au grand livre pendant une opération composée (`transact`). Tout ce qui
 * est fait via le ledger et dans le callback est atomique : un `fail` annule tout.
 */
export interface Ledger {
  /** Applique une variation de solde journalisée ; renvoie le nouveau solde. */
  apply(p: DeltaParams): number;
  balance(guildId: string, userId: string): number;
  settings(guildId: string): GuildEconomySettings;
  now(): number;
}

export interface EconomyServiceOptions {
  readonly clock?: () => number;
}

/**
 * Économie d'un serveur. Indépendant de Discord.
 * Règles d'intégrité :
 * - toute variation de solde passe par `applyDelta`, qui écrit la transaction
 *   correspondante dans le journal (economy_transactions) ;
 * - chaque opération publique est une transaction SQLite : en cas d'erreur,
 *   rien n'est écrit (un virement n'est jamais à moitié fait) ;
 * - `economy:balanceChanged` n'est émis qu'après le commit.
 */
export class EconomyService {
  private readonly stmts: ReturnType<typeof prepareStatements>;
  private readonly clock: () => number;
  private readonly logger: Logger;
  private pending: BalanceChange[] = [];
  private running = false;

  constructor(
    private readonly ctx: Pick<BotContext, 'db' | 'bus' | 'logger'>,
    options: EconomyServiceOptions = {},
  ) {
    this.stmts = prepareStatements(ctx.db);
    this.clock = options.clock ?? Date.now;
    this.logger = ctx.logger.child('economy');
  }

  // ----- Paramètres -----

  getSettings(guildId: string): GuildEconomySettings {
    return this.stmts.getSettings.get(guildId) ?? DEFAULT_SETTINGS;
  }

  updateSettings(guildId: string, patch: Partial<GuildEconomySettings>): EcoResult<GuildEconomySettings> {
    return this.run(() => {
      const next = { ...this.getSettings(guildId), ...patch };
      const name = next.currencyName.trim();
      if (name.length < 1 || name.length > 32) fail('INVALID_SETTINGS', 'Le nom de la monnaie doit faire 1 à 32 caractères.');
      for (const [field, label] of [
        ['dailyAmount', 'Le montant du daily'],
        ['gameWinReward', 'La récompense de victoire'],
        ['maxBet', 'La mise maximale'],
      ] as const) {
        const v = next[field];
        if (!Number.isSafeInteger(v) || v < 0 || v > MAX_AMOUNT) {
          fail('INVALID_SETTINGS', `${label} doit être un entier entre 0 et ${formatAmount(MAX_AMOUNT, '')}.`);
        }
      }
      const settings = { ...next, currencyName: name };
      this.stmts.upsertSettings.run({ guildId, ...settings, now: this.clock() });
      return settings;
    });
  }

  // ----- Lecture -----

  getBalance(guildId: string, userId: string): number {
    return this.stmts.getAccount.get(guildId, userId)?.balance ?? 0;
  }

  /** Rang dans le classement (1 = le plus riche), ou null si le solde est nul. */
  getRank(guildId: string, userId: string): number | null {
    const balance = this.getBalance(guildId, userId);
    if (balance <= 0) return null;
    return (this.stmts.countRicher.get(guildId, balance) ?? 0) + 1;
  }

  leaderboard(guildId: string, limit = 10): { userId: string; balance: number }[] {
    return this.stmts.leaderboard.all(guildId, limit);
  }

  history(guildId: string, userId: string, limit = 10): Transaction[] {
    return this.stmts.history.all(guildId, userId, limit);
  }

  /** Les `limit` dernières opérations du serveur (ou d'un membre), de la plus ancienne à la plus récente. */
  exportTransactions(guildId: string, userId: string | null, limit = MAX_EXPORT_ROWS): ExportRow[] {
    return userId === null
      ? this.stmts.exportAll.all(guildId, limit)
      : this.stmts.exportUser.all(guildId, userId, limit);
  }

  /** Série de daily en cours (0 si elle est rompue). */
  currentStreak(guildId: string, userId: string): number {
    const account = this.stmts.getAccount.get(guildId, userId);
    if (!account?.lastDailyAt) return 0;
    return this.clock() - account.lastDailyAt <= STREAK_WINDOW_MS ? account.dailyStreak : 0;
  }

  // ----- Opérations composées (jeux d'argent, bourse, succès) -----

  /**
   * Exécute `fn` dans une transaction, avec accès au grand livre. Les erreurs
   * levées par `fail()` deviennent un résultat `{ ok: false }` et annulent tout,
   * écritures du module appelant comprises (même connexion SQLite).
   */
  transact<T>(fn: (ledger: Ledger) => T): EcoResult<T> {
    return this.run(() =>
      fn({
        apply: (p) => this.applyDelta(p),
        balance: (guildId, userId) => this.getBalance(guildId, userId),
        settings: (guildId) => this.getSettings(guildId),
        now: () => this.clock(),
      }),
    );
  }

  // ----- Daily -----

  claimDaily(guildId: string, userId: string): EcoResult<DailyClaim> {
    return this.run(() => {
      const now = this.clock();
      const base = this.getSettings(guildId).dailyAmount;
      if (base <= 0) fail('DAILY_DISABLED', "La récompense quotidienne est désactivée sur ce serveur.");

      const account = this.stmts.getAccount.get(guildId, userId);
      const last = account?.lastDailyAt ?? null;
      if (last !== null && now - last < DAILY_COOLDOWN_MS) {
        fail('DAILY_COOLDOWN', 'Tu as déjà récupéré ta récompense quotidienne.', { retryAt: last + DAILY_COOLDOWN_MS });
      }
      const streak = last !== null && now - last <= STREAK_WINDOW_MS ? (account?.dailyStreak ?? 0) + 1 : 1;
      const bonus = Math.floor(base * STREAK_BONUS_STEP * Math.min(streak - 1, MAX_STREAK_BONUS_DAYS));
      const amount = base + bonus;

      const balance = this.applyDelta({ guildId, userId, delta: amount, kind: 'daily', note: `série de ${streak} jour(s)` });
      this.stmts.setDaily.run({ guildId, userId, now, streak });
      return { amount, bonus, streak, balance, nextAt: now + DAILY_COOLDOWN_MS };
    });
  }

  // ----- Virements -----

  transfer(guildId: string, fromId: string, toId: string, amount: number): EcoResult<TransferReceipt> {
    return this.run(() => {
      if (fromId === toId) fail('SELF_TRANSFER', 'Tu ne peux pas te faire un virement à toi-même.');
      this.assertAmount(amount);
      const fromBalance = this.applyDelta({
        guildId,
        userId: fromId,
        delta: -amount,
        kind: 'transfer_out',
        counterpartyId: toId,
      });
      const toBalance = this.applyDelta({ guildId, userId: toId, delta: amount, kind: 'transfer_in', counterpartyId: fromId });
      return { amount, fromBalance, toBalance };
    });
  }

  // ----- Récompenses de jeux -----

  /** Idempotent : rejouer le même événement ne crédite personne deux fois. */
  rewardGame(event: BotEvents['game:finished']): EcoResult<GameRewardResult> {
    return this.run(() => {
      const winners = [...new Set(event.winnerIds)];
      const losers = [...new Set(event.loserIds)];
      const amount = computeGameReward(this.getSettings(event.guildId).gameWinReward, winners.length, losers.length);
      const credited: string[] = [];
      const skipped: string[] = [];
      if (amount > 0) {
        for (const userId of winners) {
          if (this.stmts.hasReward.get(event.guildId, userId, event.sessionId) !== undefined) {
            skipped.push(userId);
            continue;
          }
          this.applyDelta({
            guildId: event.guildId,
            userId,
            delta: amount,
            kind: 'game_reward',
            reference: event.sessionId,
            note: event.game,
          });
          credited.push(userId);
        }
      }
      return { amountPerWinner: amount, credited, skipped };
    });
  }

  // ----- Anniversaires -----

  /**
   * Bonus d'anniversaire. Idempotent : un seul par membre et par an
   * (vérification + index unique uq_tx_birthday). Renvoie false s'il était déjà versé.
   */
  rewardBirthday(guildId: string, userId: string, year: number, amount: number): EcoResult<boolean> {
    return this.run(() => {
      if (!Number.isSafeInteger(amount) || amount <= 0) return false;
      const reference = String(year);
      if (this.stmts.hasBirthdayBonus.get(guildId, userId, reference) !== undefined) return false;
      this.applyDelta({ guildId, userId, delta: amount, kind: 'birthday', reference });
      return true;
    });
  }

  // ----- Administration -----

  /** Ajoute (delta > 0) ou retire (delta < 0) ; un retrait ne peut pas rendre le solde négatif. */
  adjustBalance(guildId: string, userId: string, delta: number, adminId: string, reason: string | null): EcoResult<number> {
    return this.run(() => {
      this.assertAmount(Math.abs(delta));
      return this.applyDelta({ guildId, userId, delta, kind: 'admin_adjust', counterpartyId: adminId, note: reason });
    });
  }

  setBalance(guildId: string, userId: string, target: number, adminId: string, reason: string | null): EcoResult<number> {
    return this.run(() => {
      if (!Number.isSafeInteger(target) || target < 0 || target > MAX_AMOUNT) {
        fail('INVALID_AMOUNT', `Le solde doit être un entier entre 0 et ${formatAmount(MAX_AMOUNT, '')}.`);
      }
      const delta = target - this.getBalance(guildId, userId);
      if (delta === 0) return target;
      return this.applyDelta({ guildId, userId, delta, kind: 'admin_adjust', counterpartyId: adminId, note: reason });
    });
  }

  // ----- Boutique et inventaire -----

  listItems(guildId: string): ShopItem[] {
    return this.stmts.listItems.all(guildId).map(toItem);
  }

  getItem(guildId: string, key: string): ShopItem | null {
    const row = this.stmts.getItem.get(guildId, key);
    return row ? toItem(row) : null;
  }

  /** Crée l'article, ou le met à jour (et le réactive) si la clé existe déjà. */
  upsertItem(
    guildId: string,
    input: { key: string; name: string; description?: string; price: number; stackable?: boolean },
  ): EcoResult<ShopItem> {
    return this.run(() => {
      const key = input.key.trim().toLowerCase();
      const name = input.name.trim();
      const description = (input.description ?? '').trim();
      if (!ITEM_KEY_PATTERN.test(key)) {
        fail('INVALID_ITEM', 'La clé doit faire 1 à 32 caractères : lettres minuscules, chiffres ou tirets.');
      }
      if (name.length < 1 || name.length > 64) fail('INVALID_ITEM', "Le nom de l'article doit faire 1 à 64 caractères.");
      if (description.length > 200) fail('INVALID_ITEM', 'La description est limitée à 200 caractères.');
      if (!Number.isSafeInteger(input.price) || input.price < 0 || input.price > MAX_AMOUNT) {
        fail('INVALID_ITEM', 'Le prix doit être un entier positif ou nul.');
      }
      this.stmts.upsertItem.run({
        guildId,
        key,
        name,
        description,
        price: input.price,
        stackable: input.stackable === false ? 0 : 1,
        now: this.clock(),
      });
      const item = this.getItem(guildId, key);
      if (!item) throw new Error(`Article ${key} introuvable juste après son écriture`);
      return item;
    });
  }

  /** Retire l'article de la vente. Les exemplaires déjà achetés restent dans les inventaires. */
  disableItem(guildId: string, key: string): EcoResult<void> {
    return this.run(() => {
      const { changes } = this.stmts.disableItem.run(guildId, key.trim().toLowerCase());
      if (changes === 0) fail('ITEM_NOT_FOUND', 'Aucun article en vente avec cette clé.');
    });
  }

  buy(guildId: string, userId: string, key: string, quantity = 1): EcoResult<Purchase> {
    return this.run(() => {
      const it = this.getItem(guildId, key.trim().toLowerCase());
      if (!it || !it.enabled) fail('ITEM_NOT_FOUND', "Cet article n'est pas en vente.");
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
        fail('INVALID_QUANTITY', `La quantité doit être comprise entre 1 et ${MAX_PURCHASE_QUANTITY}.`);
      }
      if (!it.stackable) {
        if (quantity !== 1) fail('INVALID_QUANTITY', 'Cet article ne peut être acheté qu’en un seul exemplaire.');
        if (this.stmts.ownedQuantity.get(guildId, userId, it.id) !== undefined) {
          fail('ALREADY_OWNED', 'Tu possèdes déjà cet article.');
        }
      }
      const total = it.price * quantity;
      if (total > MAX_AMOUNT) fail('INVALID_AMOUNT', 'Montant total trop élevé.');

      const balance =
        total > 0
          ? this.applyDelta({
              guildId,
              userId,
              delta: -total,
              kind: 'purchase',
              reference: it.key,
              note: `${quantity} × ${it.name}`,
            })
          : this.getBalance(guildId, userId);
      this.stmts.addInventory.run({ guildId, userId, itemId: it.id, quantity, now: this.clock() });
      return { item: it, quantity, total, balance };
    });
  }

  inventory(guildId: string, userId: string): InventoryEntry[] {
    return this.stmts.inventory.all(guildId, userId);
  }

  // ----- Interne -----

  private assertAmount(amount: number): void {
    if (!isValidAmount(amount)) {
      fail('INVALID_AMOUNT', `Le montant doit être un entier entre 1 et ${formatAmount(MAX_AMOUNT, '')}.`);
    }
  }

  /** À appeler dans `run` uniquement. Renvoie le nouveau solde. */
  private applyDelta(p: DeltaParams): number {
    const now = this.clock();
    const { guildId, userId, delta } = p;
    this.stmts.ensureAccount.run({ guildId, userId, now });
    const current = this.getBalance(guildId, userId);
    const balance = current + delta;
    if (balance < 0) {
      const currency = this.getSettings(guildId).currencyName;
      fail('INSUFFICIENT_FUNDS', `Solde insuffisant : ${formatAmount(current, currency)} disponibles.`);
    }
    if (balance > MAX_AMOUNT) fail('BALANCE_CAP', 'Ce solde dépasserait le plafond autorisé.');

    this.stmts.setBalance.run({ guildId, userId, balance, now });
    this.stmts.insertTx.run({
      guildId,
      userId,
      amount: delta,
      balanceAfter: balance,
      kind: p.kind,
      counterpartyId: p.counterpartyId ?? null,
      reference: p.reference ?? null,
      note: p.note ?? null,
      now,
    });
    this.pending.push({ guildId, userId, delta, newBalance: balance, reason: p.kind });
    return balance;
  }

  /** Exécute `fn` dans une transaction, convertit les EconomyFailure en résultat, émet les événements après commit. */
  private run<T>(fn: () => T): EcoResult<T> {
    // Une opération dans une autre perdrait les événements en attente de l'englobante.
    if (this.running) throw new Error('Opération économique imbriquée : utiliser le ledger de transact()');
    this.pending = [];
    this.running = true;
    try {
      const value = this.ctx.db.transaction(fn)();
      this.running = false;
      const events = this.pending;
      this.pending = [];
      for (const e of events) void this.ctx.bus.emit('economy:balanceChanged', e);
      return { ok: true, value };
    } catch (err) {
      this.running = false;
      this.pending = [];
      if (err instanceof EconomyFailure) return { ok: false, error: err.error };
      this.logger.error('Erreur inattendue dans une opération économique', err);
      throw err;
    }
  }
}
