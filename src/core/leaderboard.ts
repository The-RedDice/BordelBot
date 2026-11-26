import { EmbedBuilder } from 'discord.js';

export const MEDALS = ['🥇', '🥈', '🥉'] as const;

export interface LeaderboardRow {
  readonly userId: string;
  /** Valeur déjà formatée (« 1 200 pièces », « niveau 12 · 3 400 XP »…). */
  readonly value: string;
}

export interface LeaderboardView {
  readonly title: string;
  readonly color: number;
  readonly rows: readonly LeaderboardRow[];
  readonly empty: string;
  /** Rang du membre qui consulte (null s'il n'est pas classé). */
  readonly viewerRank: number | null;
  readonly viewerValue?: string;
  readonly footer?: string;
}

/** Embed commun à tous les `/top` : médailles, puis position du membre s'il est hors du podium affiché. */
export function leaderboardEmbed(view: LeaderboardView): EmbedBuilder {
  const lines = view.rows.map((r, idx) => `${MEDALS[idx] ?? `**${idx + 1}.**`} <@${r.userId}> — ${r.value}`);
  const footer = [
    view.viewerRank !== null && view.viewerRank > view.rows.length
      ? `Ta position : ${view.viewerRank}ᵉ${view.viewerValue ? ` (${view.viewerValue})` : ''}`
      : null,
    view.footer ?? null,
  ].filter(Boolean);
  const embed = new EmbedBuilder()
    .setColor(view.color)
    .setTitle(view.title)
    .setDescription(lines.length ? lines.join('\n') : `*${view.empty}*`);
  if (footer.length) embed.setFooter({ text: footer.join(' · ') });
  return embed;
}
