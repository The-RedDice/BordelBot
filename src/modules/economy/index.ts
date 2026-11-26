import type { BotModule } from '../../core/commands/types.js';
import { createEconomyAdminCommand } from './discord/adminCommand.js';
import { createEconomyCommands } from './discord/commands.js';
import { EconomyService } from './EconomyService.js';

/**
 * Module Économie : soldes, daily, virements, boutique, inventaire.
 * Crédite les gagnants à la réception de `game:finished`, sans dépendre du
 * module de jeux. Le crédit est idempotent (vérification + index unique uq_tx_game_reward).
 */
let service: EconomyService | undefined;
let unsubscribe: (() => void) | undefined;

export function getEconomyService(): EconomyService {
  if (!service) throw new Error('Module économie non initialisé');
  return service;
}

export const economyModule: BotModule = {
  name: 'economy',
  commands: [...createEconomyCommands(getEconomyService), createEconomyAdminCommand(getEconomyService)],
  init(ctx) {
    const eco = new EconomyService(ctx);
    service = eco;
    const log = ctx.logger.child('economy');
    unsubscribe = ctx.bus.on('game:finished', (event) => {
      const r = eco.rewardGame(event);
      if (!r.ok) {
        log.warn(`Récompense non versée pour la partie ${event.sessionId}`, r.error);
        return;
      }
      if (r.value.credited.length > 0) {
        log.info(`Partie ${event.sessionId} : ${r.value.amountPerWinner} versé(s) à ${r.value.credited.length} gagnant(s)`);
      }
    });
  },
  dispose() {
    unsubscribe?.();
    unsubscribe = undefined;
    service = undefined;
  },
};
