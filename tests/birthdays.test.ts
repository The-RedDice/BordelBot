import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/core/database/connection.js';
import { migrations } from '../src/core/database/migrations/index.js';
import { runMigrations } from '../src/core/database/migrator.js';
import { EventBus } from '../src/core/EventBus.js';
import type { BotEvents } from '../src/core/events.js';
import type { BotJobs } from '../src/core/jobs.js';
import { nullLogger } from '../src/core/logger.js';
import { JobScheduler } from '../src/core/scheduler/JobScheduler.js';
import { BirthdayService, DEFAULT_BIRTHDAY_SETTINGS, isDue } from '../src/modules/birthdays/BirthdayService.js';
import {
  celebrationDay,
  daysUntil,
  formatBirthday,
  isValidBirthday,
  isValidTimeZone,
  localTime,
  nextHour,
  type LocalTime,
} from '../src/modules/birthdays/dates.js';
import { inDaysText } from '../src/modules/birthdays/discord/commands.js';
import { announcement, joinFr } from '../src/modules/birthdays/discord/runner.js';
import { parseHour } from '../src/modules/birthdays/discord/settings.js';
import { BIRTHDAY_TICK_KEY, birthdaysModule } from '../src/modules/birthdays/index.js';
import { EconomyService } from '../src/modules/economy/EconomyService.js';
import { economyModule, getEconomyService } from '../src/modules/economy/index.js';

const G = 'g';
const day = (year: number, month: number, d: number, hour = 12): LocalTime => ({
  year,
  month,
  day: d,
  hour,
  date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
});

describe('dates', () => {
  it('valide les dates sans année, 29 février compris', () => {
    expect(isValidBirthday(2, 29)).toBe(true);
    expect(isValidBirthday(2, 30)).toBe(false);
    expect(isValidBirthday(4, 31)).toBe(false);
    expect(isValidBirthday(12, 31)).toBe(true);
    expect(isValidBirthday(13, 1)).toBe(false);
    expect(formatBirthday(3, 1)).toBe('1er mars');
    expect(formatBirthday(8, 15)).toBe('15 août');
  });

  it('fête le 29 février le 28 hors années bissextiles', () => {
    expect(celebrationDay(2, 29, 2027)).toEqual({ month: 2, day: 28 });
    expect(celebrationDay(2, 29, 2028)).toEqual({ month: 2, day: 29 });
    expect(celebrationDay(2, 29, 2100)).toEqual({ month: 2, day: 28 });
  });

  it('donne la date locale du fuseau, changement d’heure compris', () => {
    // 22 h 30 UTC le 31 décembre = 23 h 30 à Paris (hiver), 0 h 30 le 1er janvier à Helsinki.
    const at = Date.UTC(2026, 11, 31, 22, 30);
    expect(localTime(at, 'Europe/Paris')).toEqual(day(2026, 12, 31, 23));
    expect(localTime(at, 'Europe/Helsinki')).toEqual(day(2027, 1, 1, 0));
    // Été : UTC+2.
    expect(localTime(Date.UTC(2026, 6, 14, 7, 0), 'Europe/Paris').hour).toBe(9);
    expect(isValidTimeZone('America/Montreal')).toBe(true);
    expect(isValidTimeZone('Paris')).toBe(false);
  });

  it('compte les jours jusqu’au prochain anniversaire', () => {
    const today = day(2026, 11, 26);
    expect(daysUntil(11, 26, today)).toBe(0);
    expect(daysUntil(11, 27, today)).toBe(1);
    expect(daysUntil(11, 25, today)).toBe(364);
    expect(daysUntil(2, 29, day(2027, 2, 1))).toBe(27); // fêté le 28 en 2027
    expect(inDaysText(0)).toMatch(/aujourd/);
    expect(inDaysText(1)).toBe('demain');
    expect(inDaysText(12)).toBe('dans 12 jours');
  });

  it('se recale sur l’heure suivante', () => {
    expect(nextHour(Date.UTC(2026, 10, 26, 9, 59, 59))).toBe(Date.UTC(2026, 10, 26, 10, 0, 5));
    expect(nextHour(Date.UTC(2026, 10, 26, 10, 0, 0))).toBe(Date.UTC(2026, 10, 26, 11, 0, 5));
  });
});

describe('BirthdayService', () => {
  let db: Db;
  let svc: BirthdayService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    svc = new BirthdayService(db);
  });

  afterEach(() => db.close());

  it('enregistre, modifie et retire une date, par serveur', () => {
    svc.setBirthday(G, 'u', 3, 14);
    svc.setBirthday(G, 'u', 3, 15);
    svc.setBirthday('autre', 'u', 7, 1);
    expect(svc.getBirthday(G, 'u')).toEqual({ userId: 'u', month: 3, day: 15 });
    expect(() => svc.setBirthday(G, 'u', 2, 30)).toThrow();
    expect(svc.removeBirthday(G, 'u')).toBe(true);
    expect(svc.removeBirthday(G, 'u')).toBe(false);
    expect(svc.getBirthday('autre', 'u')).not.toBeNull();
  });

  it('trouve les anniversaires du jour (29 février le 28 hors bissextiles)', () => {
    svc.setBirthday(G, 'a', 2, 28);
    svc.setBirthday(G, 'b', 2, 29);
    svc.setBirthday(G, 'c', 3, 1);
    expect(svc.birthdaysOn(G, day(2027, 2, 28)).map((b) => b.userId).sort()).toEqual(['a', 'b']);
    expect(svc.birthdaysOn(G, day(2028, 2, 28)).map((b) => b.userId)).toEqual(['a']);
    expect(svc.birthdaysOn(G, day(2028, 2, 29)).map((b) => b.userId)).toEqual(['b']);
    expect(svc.birthdaysOn(G, day(2027, 3, 1)).map((b) => b.userId)).toEqual(['c']);
  });

  it('classe les prochains anniversaires', () => {
    svc.setBirthday(G, 'janvier', 1, 5);
    svc.setBirthday(G, 'demain', 11, 27);
    svc.setBirthday(G, 'jour-j', 11, 26);
    svc.setBirthday(G, 'hier', 11, 25);
    const list = svc.upcoming(G, day(2026, 11, 26), 3);
    expect(list.map((b) => [b.userId, b.inDays])).toEqual([
      ['jour-j', 0],
      ['demain', 1],
      ['janvier', 40],
    ]);
  });

  it('ne fête un anniversaire qu’une fois par an, même si la date change', () => {
    expect(svc.celebrate(G, 'u', 2026, '2026-11-26')).toBe(true);
    expect(svc.celebrate(G, 'u', 2026, '2026-11-27')).toBe(false);
    expect(svc.celebrate(G, 'u', 2027, '2027-11-26')).toBe(true);
  });

  it('retire le rôle du jour à partir du lendemain', () => {
    svc.celebrate(G, 'u', 2026, '2026-11-26');
    svc.recordRole(G, 'u', 2026, 'role');
    svc.celebrate(G, 'sans-role', 2026, '2026-11-26');
    expect(svc.pendingRoleRemovals(G, day(2026, 11, 26))).toEqual([]);
    expect(svc.pendingRoleRemovals(G, day(2026, 11, 27))).toEqual([{ userId: 'u', year: 2026, roleId: 'role' }]);
    svc.markRoleRemoved(G, 'u', 2026);
    expect(svc.pendingRoleRemovals(G, day(2026, 11, 27))).toEqual([]);
  });

  it('enregistre les réglages et refuse les valeurs invalides', () => {
    expect(svc.getSettings(G)).toEqual(DEFAULT_BIRTHDAY_SETTINGS);
    expect(svc.configuredGuilds()).toEqual([]);
    const s = { channelId: 'c', roleId: 'r', bonus: 500, hour: 8, timezone: 'Europe/Brussels' };
    svc.setSettings(G, s);
    expect(svc.getSettings(G)).toEqual(s);
    svc.markRun(G, '2026-11-26');
    expect(svc.configuredGuilds()).toEqual([{ guildId: G, lastRun: '2026-11-26', ...s }]);
    expect(() => svc.setSettings(G, { ...s, hour: 24 })).toThrow();
    expect(() => svc.setSettings(G, { ...s, bonus: -1 })).toThrow();
    expect(() => svc.setSettings(G, { ...s, timezone: 'Mars/Olympus' })).toThrow();
    expect(svc.currencyName(G)).toBe('pièces');
  });

  it('fête les anniversaires une fois l’heure passée, une seule fois par jour', () => {
    const s = { hour: 9 };
    expect(isDue(s, null, day(2026, 11, 26, 8))).toBe(false);
    expect(isDue(s, null, day(2026, 11, 26, 9))).toBe(true);
    expect(isDue(s, '2026-11-25', day(2026, 11, 26, 23))).toBe(true);
    expect(isDue(s, '2026-11-26', day(2026, 11, 26, 23))).toBe(false);
    // Fuseau déplacé vers l'ouest : on ne rejoue pas la veille.
    expect(isDue(s, '2026-11-27', day(2026, 11, 26, 23))).toBe(false);
  });
});

describe('annonce et réglages', () => {
  it('liste les membres et le bonus', () => {
    expect(joinFr(['a', 'b', 'c'])).toBe('a, b et c');
    expect(joinFr(['a'])).toBe('a');
    expect(announcement(['1'], 0, 'pièces')).toBe('🎂 **Joyeux anniversaire** à <@1> ! 🎉');
    expect(announcement(['1', '2'], 1500, 'pièces').split('\n')[1]).toBe('🎁 1 500 pièces offert à chacun·e pour l’occasion.');
  });

  it('lit l’heure de l’annonce', () => {
    expect(parseHour('9')).toBe(9);
    expect(parseHour('9h')).toBe(9);
    expect(parseHour('09:00')).toBe(9);
    expect(parseHour('0')).toBe(0);
    for (const bad of ['24', '9h30', 'midi', '']) expect(parseHour(bad), bad).toBeNull();
  });
});

describe('bonus d’anniversaire (économie)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
  });

  afterEach(async () => {
    await economyModule.dispose?.();
    await birthdaysModule.dispose?.();
    db.close();
  });

  it('verse le bonus une seule fois par an', () => {
    const eco = new EconomyService({ db, bus: new EventBus<BotEvents>(), logger: nullLogger });
    expect(eco.rewardBirthday(G, 'u', 2026, 500)).toEqual({ ok: true, value: true });
    expect(eco.rewardBirthday(G, 'u', 2026, 500)).toEqual({ ok: true, value: false });
    expect(eco.rewardBirthday(G, 'u', 2027, 500)).toEqual({ ok: true, value: true });
    expect(eco.rewardBirthday(G, 'v', 2026, 0)).toEqual({ ok: true, value: false });
    expect(eco.getBalance(G, 'u')).toBe(1000);
    expect(eco.history(G, 'u', 1)[0]?.kind).toBe('birthday');
    // L'index unique protège aussi contre une insertion directe en double.
    expect(() =>
      db
        .prepare(
          `INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, kind, reference, created_at)
           VALUES (?, 'u', 1, 1, 'birthday', '2026', 0)`,
        )
        .run(G),
    ).toThrow(/UNIQUE/);
  });

  it('crédite via l’événement et planifie la tâche horaire une seule fois', async () => {
    const bus = new EventBus<BotEvents>(nullLogger);
    const scheduler = new JobScheduler<BotJobs>(db);
    const ctx = { db, bus, logger: nullLogger, scheduler };
    await economyModule.init?.(ctx);
    await birthdaysModule.init?.(ctx);
    await bus.emit('birthday:celebrated', { guildId: G, userId: 'u', year: 2026, bonus: 250 });
    await bus.emit('birthday:celebrated', { guildId: G, userId: 'u', year: 2026, bonus: 250 });
    expect(getEconomyService().getBalance(G, 'u')).toBe(250);

    expect(scheduler.getByKey(BIRTHDAY_TICK_KEY)?.kind).toBe('birthdays:tick');
    await birthdaysModule.dispose?.();
    await birthdaysModule.init?.(ctx);
    expect(scheduler.list('birthdays:tick')).toHaveLength(1);
  });
});
