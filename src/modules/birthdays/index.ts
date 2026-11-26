import type { BotModule } from '../../core/commands/types.js';
import type { EventBus } from '../../core/EventBus.js';
import type { BotEvents } from '../../core/events.js';
import type { Logger } from '../../core/logger.js';
import { BirthdayService } from './BirthdayService.js';
import { nextHour } from './dates.js';
import { createBirthdayCommand } from './discord/commands.js';
import { runBirthdays, type BirthdayDeps } from './discord/runner.js';
import { createBirthdaySettings } from './discord/settings.js';

/**
 * Module Anniversaires : `/anniversaire`, annonce le jour J à l'heure choisie,
 * rôle du jour et bonus en monnaie (versé par l'économie via `birthday:celebrated`).
 * Une tâche planifiée passe toutes les heures : un arrêt du bot est rattrapé au
 * redémarrage, et chaque anniversaire n'est fêté qu'une fois par an.
 */
let service: BirthdayService | undefined;
let bus: EventBus<BotEvents> | undefined;
let logger: Logger | undefined;
let unregister: (() => void) | undefined;

export const BIRTHDAY_TICK_KEY = 'birthdays:tick';

function getService(): BirthdayService {
  if (!service) throw new Error('Module anniversaires non initialisé');
  return service;
}

const deps: BirthdayDeps = {
  getService,
  bus: () => {
    if (!bus) throw new Error('Module anniversaires non initialisé');
    return bus;
  },
  logger: () => {
    if (!logger) throw new Error('Module anniversaires non initialisé');
    return logger;
  },
};

export const birthdaysModule: BotModule = {
  name: 'birthdays',
  commands: [createBirthdayCommand(deps)],
  settings: [createBirthdaySettings(getService)],
  init(ctx) {
    service = new BirthdayService(ctx.db);
    bus = ctx.bus;
    logger = ctx.logger.child('birthdays');
    unregister = ctx.scheduler.register('birthdays:tick', async (_job, client) => {
      await runBirthdays(client, deps);
      return { rescheduleAt: nextHour(Date.now()) };
    });
    // Tâche unique (clé fixe) : créée au premier démarrage, conservée ensuite en base.
    if (!ctx.scheduler.getByKey(BIRTHDAY_TICK_KEY)) {
      ctx.scheduler.schedule('birthdays:tick', Date.now(), {}, { key: BIRTHDAY_TICK_KEY });
    }
  },
  dispose() {
    unregister?.();
    unregister = undefined;
    service = undefined;
    bus = undefined;
    logger = undefined;
  },
};
