import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { ComponentHandler, SlashCommand } from '../../../../core/commands/types.js';
import type { MoleAdapter } from './MoleAdapter.js';
import { MOLE_PREFIX } from './ids.js';

/** `getAdapter` est résolu à l'appel : l'adaptateur n'existe qu'après l'init du module. */
export function createMoleCommand(getAdapter: () => MoleAdapter): SlashCommand {
  return {
    data: new SlashCommandBuilder()
      .setName('taupe')
      .setDescription('Lance une partie de La Taupe dans ce salon')
      .setContexts(InteractionContextType.Guild)
      .addIntegerOption((o) =>
        o.setName('tours').setDescription("Nombre de tours d'indices (1 par défaut)").setMinValue(1).setMaxValue(3),
      ),
    execute: (interaction) => getAdapter().create(interaction),
  };
}

export function createMoleComponents(getAdapter: () => MoleAdapter): ComponentHandler {
  return {
    prefix: MOLE_PREFIX,
    handle: (interaction) => getAdapter().handleComponent(interaction),
  };
}
