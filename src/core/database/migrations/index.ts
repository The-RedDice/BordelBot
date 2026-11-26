import type { Migration } from '../migrator.js';
import { initialMigration } from './001_initial.js';
import { economyMigration } from './002_economy.js';
import { featuresMigration } from './003_features.js';
import { levelsMigration } from './004_levels.js';
import { schedulerMigration } from './005_scheduler.js';
import { moderationToolsMigration } from './006_moderation_tools.js';
import { birthdaysMigration } from './007_birthdays.js';
import { gamesMigration } from './008_games.js';

/** Ajouter chaque nouvelle migration ici, dans l'ordre. */
export const migrations: readonly Migration[] = [
  initialMigration,
  economyMigration,
  featuresMigration,
  levelsMigration,
  schedulerMigration,
  moderationToolsMigration,
  birthdaysMigration,
  gamesMigration,
];
