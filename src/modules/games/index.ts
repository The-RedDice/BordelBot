import type { BotModule } from '../../core/commands/types.js';
import { GameService } from './GameService.js';
import { createMoleCommand, createMoleComponents } from './mole/discord/command.js';
import { MoleAdapter } from './mole/discord/MoleAdapter.js';
import { createWordleCommand } from './wordle/command.js';
import { WordleService } from './wordle/WordleService.js';

/**
 * Module Jeux.
 * - engine/       : FSM génériques et runner de session, sans discord.js.
 * - mole/         : règles de la Taupe (machine pure).
 * - mole/discord/ : adaptateur Discord (commande, plateau, boutons, modales).
 * - wordle/       : mot du jour (règles, persistance, sous-commande).
 * - GameService   : persistance + `game:finished` sur l'EventBus.
 */
let service: GameService | undefined;
let mole: MoleAdapter | undefined;
let wordle: WordleService | undefined;

export function getGameService(): GameService {
  if (!service) throw new Error('Module jeux non initialisé');
  return service;
}

function getMoleAdapter(): MoleAdapter {
  if (!mole) throw new Error('Module jeux non initialisé');
  return mole;
}

function getWordleService(): WordleService {
  if (!wordle) throw new Error('Module jeux non initialisé');
  return wordle;
}

export const gamesModule: BotModule = {
  name: 'games',
  subcommands: [createMoleCommand(getMoleAdapter), createWordleCommand(getWordleService)],
  components: [createMoleComponents(getMoleAdapter)],
  init(ctx) {
    service = new GameService(ctx);
    service.recoverInterrupted();
    mole = new MoleAdapter(service, ctx.logger);
    wordle = new WordleService(ctx.db);
  },
  async dispose() {
    // Stopper d'abord les sessions (timers, hooks), puis figer les plateaux.
    service?.disposeAll();
    await mole?.dispose();
    service = undefined;
    mole = undefined;
    wordle = undefined;
  },
};
