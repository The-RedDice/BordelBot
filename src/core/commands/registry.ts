import type { BotModule, ComponentHandler, SlashCommand } from './types.js';

/** Index des commandes et handlers de composants de tous les modules, avec détection de doublons. */
export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();
  private readonly components = new Map<string, ComponentHandler>();

  constructor(modules: readonly BotModule[]) {
    for (const mod of modules) {
      for (const cmd of mod.commands ?? []) {
        const name = cmd.data.name;
        if (this.commands.has(name)) throw new Error(`Commande "/${name}" déclarée deux fois (module ${mod.name})`);
        this.commands.set(name, cmd);
      }
      for (const handler of mod.components ?? []) {
        if (handler.prefix.includes(':')) throw new Error(`Préfixe invalide "${handler.prefix}" : ":" interdit`);
        if (this.components.has(handler.prefix)) {
          throw new Error(`Préfixe de composant "${handler.prefix}" déclaré deux fois (module ${mod.name})`);
        }
        this.components.set(handler.prefix, handler);
      }
    }
  }

  getCommand(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  getComponentHandler(customId: string): ComponentHandler | undefined {
    const prefix = customId.split(':', 1)[0] ?? '';
    return this.components.get(prefix);
  }

  allCommands(): SlashCommand[] {
    return [...this.commands.values()];
  }
}
