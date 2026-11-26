import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import { nullLogger } from '../src/core/logger.js';
import {
  DAILY_COOLDOWN_MS,
  EconomyService,
  MAX_AMOUNT,
  STREAK_WINDOW_MS,
  type EcoResult,
} from '../src/modules/economy/EconomyService.js';
import { computeGameReward } from '../src/modules/economy/rewards.js';

const G = 'guild';

function value<T>(r: EcoResult<T>): T {
  if (!r.ok) throw new Error(`Échec inattendu : ${r.error.code}`);
  return r.value;
}
const code = (r: EcoResult<unknown>) => (r.ok ? null : r.error.code);

describe('EconomyService', () => {
  let db: Db;
  let bus: EventBus<BotEvents>;
  let now: number;
  let eco: EconomyService;
  let changes: BotEvents['economy:balanceChanged'][];

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    bus = new EventBus<BotEvents>();
    changes = [];
    bus.on('economy:balanceChanged', (e) => void changes.push(e));
    now = 1_000_000_000_000;
    eco = new EconomyService({ db, bus, logger: nullLogger }, { clock: () => now });
  });
  afterEach(() => db.close());

  const give = (userId: string, amount: number) => value(eco.adjustBalance(G, userId, amount, 'admin', null));
  const txCount = () => db.prepare('SELECT COUNT(*) FROM economy_transactions').pluck().get() as number;

  describe('daily', () => {
    it('crédite la base, puis refuse avant 24 h avec l’heure de retour', () => {
      expect(value(eco.claimDaily(G, 'u'))).toMatchObject({ amount: 100, bonus: 0, streak: 1, balance: 100 });
      now += DAILY_COOLDOWN_MS - 1;
      const again = eco.claimDaily(G, 'u');
      expect(again.ok).toBe(false);
      if (!again.ok) {
        expect(again.error.code).toBe('DAILY_COOLDOWN');
        expect(again.error.retryAt).toBe(now + 1);
      }
    });

    it('fait progresser la série (+10 %/jour, plafonnée) et la remet à 1 après 48 h', () => {
      const streaks: number[] = [];
      const amounts: number[] = [];
      for (let day = 0; day < 13; day++) {
        const c = value(eco.claimDaily(G, 'u'));
        streaks.push(c.streak);
        amounts.push(c.amount);
        now += DAILY_COOLDOWN_MS;
      }
      expect(streaks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(amounts.slice(0, 3)).toEqual([100, 110, 120]);
      expect(amounts.slice(10)).toEqual([200, 200, 200]); // bonus plafonné à +100 %

      now += STREAK_WINDOW_MS; // trou de plus de 48 h depuis le dernier daily
      expect(value(eco.claimDaily(G, 'u'))).toMatchObject({ streak: 1, amount: 100 });
    });

    it('respecte la configuration du serveur, y compris la désactivation', () => {
      value(eco.updateSettings(G, { dailyAmount: 0 }));
      expect(code(eco.claimDaily(G, 'u'))).toBe('DAILY_DISABLED');
      value(eco.updateSettings(G, { dailyAmount: 30 }));
      expect(value(eco.claimDaily(G, 'u')).amount).toBe(30);
      expect(eco.getSettings('autre-serveur').dailyAmount).toBe(100);
    });
  });

  describe('virements', () => {
    it('débite et crédite atomiquement, avec deux écritures au journal', () => {
      give('a', 500);
      expect(value(eco.transfer(G, 'a', 'b', 200))).toEqual({ amount: 200, fromBalance: 300, toBalance: 200 });
      const [toB, fromA] = eco.history(G, 'b').concat(eco.history(G, 'a'));
      expect(toB).toMatchObject({ kind: 'transfer_in', amount: 200, counterpartyId: 'a' });
      expect(fromA).toMatchObject({ kind: 'transfer_out', amount: -200, counterpartyId: 'b', balanceAfter: 300 });
    });

    it('refuse solde insuffisant, auto-virement et montants invalides sans rien écrire', () => {
      give('a', 50);
      const before = txCount();
      changes = [];
      expect(code(eco.transfer(G, 'a', 'b', 51))).toBe('INSUFFICIENT_FUNDS');
      expect(code(eco.transfer(G, 'a', 'a', 10))).toBe('SELF_TRANSFER');
      for (const bad of [0, -5, 1.5, Number.NaN, MAX_AMOUNT + 1]) {
        expect(code(eco.transfer(G, 'a', 'b', bad))).toBe('INVALID_AMOUNT');
      }
      expect(txCount()).toBe(before);
      expect(eco.getBalance(G, 'b')).toBe(0);
      expect(changes).toEqual([]);
    });

    it('refuse de dépasser le plafond de solde chez le destinataire, sans débiter l’émetteur', () => {
      give('a', 10);
      value(eco.setBalance(G, 'b', MAX_AMOUNT, 'admin', null));
      expect(code(eco.transfer(G, 'a', 'b', 10))).toBe('BALANCE_CAP');
      expect(eco.getBalance(G, 'a')).toBe(10);
    });

    it('isole les serveurs', () => {
      give('a', 100);
      expect(eco.getBalance('autre', 'a')).toBe(0);
      expect(code(eco.transfer('autre', 'a', 'b', 1))).toBe('INSUFFICIENT_FUNDS');
    });
  });

  describe('récompenses de jeux', () => {
    const event = (over: Partial<BotEvents['game:finished']> = {}): BotEvents['game:finished'] => ({
      sessionId: 'game-1',
      guildId: G,
      game: 'mole',
      winnerIds: ['a', 'b', 'c'],
      loserIds: ['m'],
      finishedAt: now,
      ...over,
    });

    it('calcule un bonus pour le camp minoritaire, plafonné à ×3', () => {
      expect(computeGameReward(50, 3, 1)).toBe(50);
      expect(computeGameReward(50, 1, 2)).toBe(100);
      expect(computeGameReward(50, 1, 11)).toBe(150);
      expect(computeGameReward(50, 2, 3)).toBe(75);
      expect(computeGameReward(0, 1, 3)).toBe(0);
      expect(computeGameReward(50, 0, 3)).toBe(0);
    });

    it('crédite chaque gagnant une seule fois, même si l’événement est rejoué', () => {
      expect(value(eco.rewardGame(event()))).toEqual({ amountPerWinner: 50, credited: ['a', 'b', 'c'], skipped: [] });
      expect(value(eco.rewardGame(event()))).toEqual({ amountPerWinner: 50, credited: [], skipped: ['a', 'b', 'c'] });
      expect(eco.getBalance(G, 'a')).toBe(50);
      expect(eco.getBalance(G, 'm')).toBe(0);
      expect(eco.history(G, 'a')[0]).toMatchObject({ kind: 'game_reward', reference: 'game-1', note: 'mole' });
    });

    it('la taupe gagnante seule touche le multiplicateur', () => {
      value(eco.rewardGame(event({ sessionId: 'game-2', winnerIds: ['m'], loserIds: ['a', 'b', 'c'] })));
      expect(eco.getBalance(G, 'm')).toBe(150);
    });

    it('est branché sur l’EventBus via le module', async () => {
      const { economyModule } = await import('../src/modules/economy/index.js');
      await economyModule.init?.({ db, bus, logger: nullLogger });
      await bus.emit('game:finished', event({ sessionId: 'game-bus' }));
      expect(eco.getBalance(G, 'b')).toBe(50);
      await economyModule.dispose?.();
      await bus.emit('game:finished', event({ sessionId: 'game-after-dispose' }));
      expect(eco.getBalance(G, 'b')).toBe(50);
    });
  });

  describe('administration', () => {
    it('ajoute, retire sans passer sous zéro, et fixe un solde exact', () => {
      expect(give('u', 100)).toBe(100);
      expect(code(eco.adjustBalance(G, 'u', -101, 'admin', 'test'))).toBe('INSUFFICIENT_FUNDS');
      expect(value(eco.adjustBalance(G, 'u', -40, 'admin', 'amende'))).toBe(60);
      expect(value(eco.setBalance(G, 'u', 1_000, 'admin', 'reset'))).toBe(1_000);
      expect(eco.history(G, 'u')[0]).toMatchObject({ kind: 'admin_adjust', amount: 940, counterpartyId: 'admin', note: 'reset' });
      expect(code(eco.setBalance(G, 'u', -1, 'admin', null))).toBe('INVALID_AMOUNT');
    });

    it('valide les paramètres du serveur', () => {
      expect(value(eco.updateSettings(G, { currencyName: '  écus ' })).currencyName).toBe('écus');
      expect(code(eco.updateSettings(G, { currencyName: ' ' }))).toBe('INVALID_SETTINGS');
      expect(code(eco.updateSettings(G, { gameWinReward: -1 }))).toBe('INVALID_SETTINGS');
      expect(eco.getSettings(G)).toMatchObject({ currencyName: 'écus', dailyAmount: 100, gameWinReward: 50 });
    });

    it('émet economy:balanceChanged après commit', () => {
      give('a', 100);
      value(eco.transfer(G, 'a', 'b', 30));
      expect(changes.map((c) => [c.userId, c.delta, c.newBalance, c.reason])).toEqual([
        ['a', 100, 100, 'admin_adjust'],
        ['a', -30, 70, 'transfer_out'],
        ['b', 30, 30, 'transfer_in'],
      ]);
    });
  });

  describe('classement et historique', () => {
    it('trie par solde, ignore les soldes nuls et calcule le rang', () => {
      give('a', 10);
      give('b', 30);
      give('c', 20);
      value(eco.setBalance(G, 'z', 0, 'admin', null));
      expect(eco.leaderboard(G).map((r) => r.userId)).toEqual(['b', 'c', 'a']);
      expect(eco.getRank(G, 'c')).toBe(2);
      expect(eco.getRank(G, 'z')).toBeNull();
      expect(eco.leaderboard(G, 1)).toEqual([{ userId: 'b', balance: 30 }]);
    });

    it('renvoie l’historique du plus récent au plus ancien', () => {
      give('a', 10);
      give('a', 20);
      expect(eco.history(G, 'a').map((t) => t.amount)).toEqual([20, 10]);
      expect(eco.history(G, 'a', 1)).toHaveLength(1);
    });
  });

  describe('boutique et inventaire', () => {
    beforeEach(() => {
      value(eco.upsertItem(G, { key: 'Potion', name: 'Potion', price: 25 }));
      value(eco.upsertItem(G, { key: 'badge-or', name: "Badge d'or", price: 100, stackable: false }));
    });

    it('valide les articles', () => {
      expect(code(eco.upsertItem(G, { key: 'pas une clé', name: 'x', price: 1 }))).toBe('INVALID_ITEM');
      expect(code(eco.upsertItem(G, { key: 'ok', name: '', price: 1 }))).toBe('INVALID_ITEM');
      expect(code(eco.upsertItem(G, { key: 'ok', name: 'x', price: -1 }))).toBe('INVALID_ITEM');
      expect(eco.listItems(G).map((i) => i.key)).toEqual(['potion', 'badge-or']);
    });

    it('achète, débite et cumule dans l’inventaire', () => {
      give('u', 200);
      expect(value(eco.buy(G, 'u', 'potion', 2))).toMatchObject({ quantity: 2, total: 50, balance: 150 });
      value(eco.buy(G, 'u', 'POTION'));
      expect(eco.inventory(G, 'u')).toEqual([{ key: 'potion', name: 'Potion', quantity: 3 }]);
      expect(eco.history(G, 'u')[0]).toMatchObject({ kind: 'purchase', amount: -25, reference: 'potion' });
    });

    it('refuse fonds insuffisants sans rien ajouter à l’inventaire', () => {
      give('u', 20);
      expect(code(eco.buy(G, 'u', 'potion'))).toBe('INSUFFICIENT_FUNDS');
      expect(eco.inventory(G, 'u')).toEqual([]);
    });

    it('article unique : un seul exemplaire', () => {
      give('u', 1_000);
      expect(code(eco.buy(G, 'u', 'badge-or', 2))).toBe('INVALID_QUANTITY');
      value(eco.buy(G, 'u', 'badge-or'));
      expect(code(eco.buy(G, 'u', 'badge-or'))).toBe('ALREADY_OWNED');
    });

    it('un article retiré ne se vend plus mais reste dans les inventaires', () => {
      give('u', 100);
      value(eco.buy(G, 'u', 'potion'));
      value(eco.disableItem(G, 'potion'));
      expect(code(eco.disableItem(G, 'potion'))).toBe('ITEM_NOT_FOUND');
      expect(code(eco.buy(G, 'u', 'potion'))).toBe('ITEM_NOT_FOUND');
      expect(eco.listItems(G).map((i) => i.key)).toEqual(['badge-or']);
      expect(eco.inventory(G, 'u')).toEqual([{ key: 'potion', name: 'Potion', quantity: 1 }]);
      // Le recréer le remet en vente.
      value(eco.upsertItem(G, { key: 'potion', name: 'Potion+', price: 30 }));
      expect(eco.getItem(G, 'potion')).toMatchObject({ enabled: true, name: 'Potion+', price: 30 });
    });

    it('refuse les quantités invalides', () => {
      give('u', 10_000);
      for (const q of [0, -1, 1.5, 101]) expect(code(eco.buy(G, 'u', 'potion', q))).toBe('INVALID_QUANTITY');
    });
  });

  it('applique la migration 002', () => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('economy_transactions')").pluck().all();
    expect(cols).toContain('note');
    expect(runMigrations(db, migrations).currentVersion).toBe(2);
  });
});
