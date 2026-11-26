import { escapeMarkdown, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { SettingsSection } from '../../../core/settings/types.js';
import { formatAmount, MAX_AMOUNT, type EconomyService, type GuildEconomySettings } from '../EconomyService.js';

const FIELDS = {
  currency: 'currency',
  daily: 'daily',
  reward: 'reward',
  maxBet: 'maxBet',
} as const;

/** « 1 000 », « 1000 », « 1.000 » → 1000 ; null si ce n'est pas un entier positif ou nul. */
export function parseAmountInput(raw: string): number | null {
  const compact = raw.replace(/[\s  ._]/g, '');
  if (!/^\d+$/.test(compact)) return null;
  const n = Number(compact);
  return Number.isSafeInteger(n) && n <= MAX_AMOUNT ? n : null;
}

function numberInput(id: string, value: number): TextInputBuilder {
  return new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16).setValue(String(value));
}

export function describeEconomySettings(s: GuildEconomySettings): string {
  const amount = (n: number, off: string) => (n > 0 ? formatAmount(n, s.currencyName) : off);
  return [
    `**Monnaie :** ${escapeMarkdown(s.currencyName)}`,
    `**Daily :** ${amount(s.dailyAmount, 'désactivé')}`,
    `**Victoire :** ${amount(s.gameWinReward, 'désactivée')} (×3 max pour un camp minoritaire)`,
    `**Mise max :** ${amount(s.maxBet, 'jeux d’argent désactivés')}`,
  ].join('\n');
}

export function createEconomySettings(getService: () => EconomyService): SettingsSection {
  return {
    id: 'economy',
    label: 'Économie',
    emoji: '💰',
    hint: 'Monnaie, daily, récompense de victoire, mise maximale',
    describe: (guildId) => describeEconomySettings(getService().getSettings(guildId)),
    editor(guildId) {
      const s = getService().getSettings(guildId);
      return new ModalBuilder().addLabelComponents(
        new LabelBuilder()
          .setLabel('Nom de la monnaie')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(FIELDS.currency)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(32)
              .setValue(s.currencyName),
          ),
        new LabelBuilder()
          .setLabel('Daily')
          .setDescription('Montant de base de la récompense quotidienne (0 = désactivée)')
          .setTextInputComponent(numberInput(FIELDS.daily, s.dailyAmount)),
        new LabelBuilder()
          .setLabel('Récompense de victoire')
          .setDescription('Base versée à chaque gagnant d’une partie (0 = désactivée)')
          .setTextInputComponent(numberInput(FIELDS.reward, s.gameWinReward)),
        new LabelBuilder()
          .setLabel('Mise maximale')
          .setDescription('Pile ou face, machine à sous et duels (0 = jeux d’argent désactivés)')
          .setTextInputComponent(numberInput(FIELDS.maxBet, s.maxBet)),
      );
    },
    async submit(interaction) {
      const read = (id: string) => interaction.fields.getTextInputValue(id);
      const values = {
        dailyAmount: parseAmountInput(read(FIELDS.daily)),
        gameWinReward: parseAmountInput(read(FIELDS.reward)),
        maxBet: parseAmountInput(read(FIELDS.maxBet)),
      };
      const invalid = Object.entries(values).find(([, v]) => v === null);
      if (invalid) {
        const label = { dailyAmount: 'Daily', gameWinReward: 'Récompense de victoire', maxBet: 'Mise maximale' }[invalid[0]];
        return { ok: false, message: `« ${label} » doit être un nombre entier positif ou nul.` };
      }
      const r = getService().updateSettings(interaction.guildId, {
        currencyName: read(FIELDS.currency),
        dailyAmount: values.dailyAmount as number,
        gameWinReward: values.gameWinReward as number,
        maxBet: values.maxBet as number,
      });
      return r.ok ? { ok: true, message: '✅ Réglages de l’économie enregistrés.' } : { ok: false, message: r.error.message };
    },
  };
}
