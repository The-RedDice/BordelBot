import {
  InteractionContextType,
  SlashCommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { PARENT_COMMANDS, type ParentCommandName } from './parents.js';
import type { BotModule, ComponentHandler, SlashCommand, Subcommand } from './types.js';

/** Limite Discord : 25 sous-commandes ou groupes par commande. */
const MAX_SUBCOMMANDS = 25;

/** Nom de l'entrée appelée : le groupe s'il y en a un, sinon la sous-commande. */
function entryName(interaction: ChatInputCommandInteraction | AutocompleteInteraction): string {
  return interaction.options.getSubcommandGroup(false) ?? interaction.options.getSubcommand();
}

/** Assemble les contributions des modules en une slash command unique. */
function buildParentCommand(name: ParentCommandName, entries: ReadonlyMap<string, Subcommand>): SlashCommand {
  const def: { description: string; permissions?: bigint } = PARENT_COMMANDS[name];
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(def.description)
    .setContexts(InteractionContextType.Guild);
  if (def.permissions !== undefined) data.setDefaultMemberPermissions(def.permissions);
  for (const entry of entries.values()) {
    if (entry.data instanceof SlashCommandSubcommandGroupBuilder) data.addSubcommandGroup(entry.data);
    else data.addSubcommand(entry.data);
  }
  return {
    data,
    async execute(interaction, ctx) {
      await entries.get(entryName(interaction))?.execute(interaction, ctx);
    },
    async autocomplete(interaction, ctx) {
      await entries.get(entryName(interaction))?.autocomplete?.(interaction, ctx);
    },
  };
}

/** Index des commandes et handlers de composants de tous les modules, avec détection de doublons. */
export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();
  private readonly components = new Map<string, ComponentHandler>();

  constructor(modules: readonly BotModule[]) {
    const sections = new Set<string>();
    const parents = new Map<ParentCommandName, Map<string, Subcommand>>();
    for (const mod of modules) {
      for (const section of mod.settings ?? []) {
        if (section.id.includes(':')) throw new Error(`Section de réglages invalide "${section.id}" : ":" interdit`);
        if (sections.has(section.id)) throw new Error(`Section de réglages "${section.id}" déclarée deux fois (module ${mod.name})`);
        sections.add(section.id);
      }
      for (const cmd of mod.commands ?? []) {
        const name = cmd.data.name;
        if (this.commands.has(name) || name in PARENT_COMMANDS) {
          throw new Error(`Commande "/${name}" déclarée deux fois (module ${mod.name})`);
        }
        this.commands.set(name, cmd);
      }
      for (const sub of mod.subcommands ?? []) {
        const entries = parents.get(sub.parent) ?? new Map<string, Subcommand>();
        const name = sub.data.name;
        if (entries.has(name)) throw new Error(`Sous-commande "/${sub.parent} ${name}" déclarée deux fois (module ${mod.name})`);
        entries.set(name, sub);
        parents.set(sub.parent, entries);
      }
      for (const handler of mod.components ?? []) {
        if (handler.prefix.includes(':')) throw new Error(`Préfixe invalide "${handler.prefix}" : ":" interdit`);
        if (this.components.has(handler.prefix)) {
          throw new Error(`Préfixe de composant "${handler.prefix}" déclaré deux fois (module ${mod.name})`);
        }
        this.components.set(handler.prefix, handler);
      }
    }
    for (const [name, entries] of parents) {
      if (entries.size > MAX_SUBCOMMANDS) throw new Error(`"/${name}" dépasse ${MAX_SUBCOMMANDS} sous-commandes`);
      this.commands.set(name, buildParentCommand(name, entries));
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
