import { escapeMarkdown } from 'discord.js';
import { relativeTime } from '../../../core/replies.js';
import { formatAmount, type EconomyError, type Transaction, type TransactionKind } from '../EconomyService.js';

export const ECONOMY_COLOR = 0xf1c40f;

const KIND_LABELS: Record<TransactionKind, string> = {
  daily: '🎁 Récompense quotidienne',
  transfer_in: '📥 Virement reçu',
  transfer_out: '📤 Virement envoyé',
  game_reward: '🏆 Victoire',
  purchase: '🛒 Achat',
  admin_adjust: '🛠️ Ajustement',
  gamble: '🎰 Jeu d’argent',
  duel: '⚔️ Duel',
  market_buy: '📈 Achat en bourse',
  market_sell: '📉 Vente en bourse',
  achievement: '🏅 Succès',
};

const GAME_LABELS: Record<string, string> = { mole: 'La Taupe', 'one-vs-all': '1 contre tous' };

export function signedAmount(amount: number, currency: string): string {
  return `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${formatAmount(Math.abs(amount), currency)}`;
}

export function transactionLine(tx: Transaction, currency: string): string {
  const details: string[] = [];
  if (tx.counterpartyId && tx.kind !== 'admin_adjust') details.push(`<@${tx.counterpartyId}>`);
  if (tx.kind === 'game_reward' && tx.note) details.push(GAME_LABELS[tx.note] ?? tx.note);
  else if (tx.note) details.push(escapeMarkdown(tx.note));
  const suffix = details.length ? ` — ${details.join(' · ')}` : '';
  return `${relativeTime(tx.createdAt)} **${signedAmount(tx.amount, currency)}** ${KIND_LABELS[tx.kind]}${suffix}`;
}

/** Message d'erreur, enrichi d'un compte à rebours pour le daily. */
export function errorText(error: EconomyError): string {
  return error.retryAt === undefined ? error.message : `${error.message} Prochaine récompense ${relativeTime(error.retryAt)}.`;
}

export const MEDALS = ['🥇', '🥈', '🥉'] as const;

/** Lignes « succès débloqué » à ajouter à une réponse. `who` : mention, pour un message public à plusieurs. */
export function achievementLines(
  unlocked: readonly { achievement: { emoji: string; name: string }; reward: number }[],
  currency: string,
  who?: string,
): string[] {
  return unlocked.map(
    ({ achievement: a, reward }) =>
      `🏅 ${who ? `${who} débloque` : 'Succès débloqué :'} **${a.emoji} ${a.name}**` +
      (reward > 0 ? ` (+${formatAmount(reward, currency)})` : ''),
  );
}

/** « ▲ +3,2 % » / « ▼ −1,5 % » ; « — » sans donnée. */
export function percentChange(change: number | null): string {
  if (change === null) return '—';
  const text = new Intl.NumberFormat('fr-FR', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(change);
  return `${change > 0 ? '▲' : change < 0 ? '▼' : '•'} ${text}`;
}
