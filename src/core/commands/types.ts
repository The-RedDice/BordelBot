import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { BotContext } from '../context.js';

export interface SlashCommand {
  /** Un SlashCommandBuilder convient (il expose `name` et `toJSON`). */
  readonly data: { readonly name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction, ctx: BotContext): Promise<void>;
}

/**
 * Gestionnaire de boutons, menus et modales. Le routage se fait sur le préfixe du
 * customId, au format `<prefix>:<reste>` (ex. `mole:vote:<sessionId>`).
 */
export interface ComponentHandler {
  readonly prefix: string;
  handle(interaction: MessageComponentInteraction | ModalSubmitInteraction, ctx: BotContext): Promise<void>;
}

/** Unité d'assemblage : un domaine fonctionnel du bot. */
export interface BotModule {
  readonly name: string;
  readonly commands?: readonly SlashCommand[];
  readonly components?: readonly ComponentHandler[];
  /** Appelé une fois au démarrage : abonnements EventBus, timers, etc. */
  init?(ctx: BotContext): void | Promise<void>;
  /** Appelé à l'arrêt : libérer timers et abonnements. */
  dispose?(): void | Promise<void>;
}
