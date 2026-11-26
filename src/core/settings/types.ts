import type { ModalBuilder, ModalSubmitInteraction } from 'discord.js';

export interface SettingsSubmitResult {
  readonly ok: boolean;
  /** Affiché à l'admin tel quel. */
  readonly message: string;
}

/**
 * Une section du tableau de bord `/config`, fournie par un module. Le core ne connaît
 * que ce contrat : il affiche `describe`, ouvre la modale d'`editor` et délègue la
 * validation à `submit`. Chaque module garde ainsi ses règles et son stockage.
 */
export interface SettingsSection {
  /** Identifiant court, unique, sans « : » (utilisé dans les customId). */
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  /** Une ligne d'aide dans le menu de sélection (100 caractères max). */
  readonly hint: string;
  /** Valeur d'un champ d'embed (1 024 caractères max). */
  describe(guildId: string): string;
  /** Modale pré-remplie ; le core fixe son customId et son titre. */
  editor(guildId: string): ModalBuilder;
  submit(interaction: ModalSubmitInteraction<'cached'>): Promise<SettingsSubmitResult>;
}
