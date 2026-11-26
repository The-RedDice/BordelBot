import type { Migration } from '../migrator.js';
import { initialMigration } from './001_initial.js';
import { economyMigration } from './002_economy.js';
import { featuresMigration } from './003_features.js';

/** Ajouter chaque nouvelle migration ici, dans l'ordre. */
export const migrations: readonly Migration[] = [initialMigration, economyMigration, featuresMigration];
