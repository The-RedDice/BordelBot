import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { relativeTime } from '../../../core/replies.js';
import { formatDuration } from '../duration.js';
import type { ModerationAction, ModerationCase } from '../ModerationService.js';

export const ACTION_LABELS: Record<ModerationAction, string> = {
  warn: 'Avertissement',
  timeout: 'Exclusion temporaire',
  untimeout: "Fin d'exclusion",
  kick: 'Expulsion',
  ban: 'Bannissement',
  unban: 'Débannissement',
  purge: 'Purge de messages',
};

const ACTION_EMOJIS: Record<ModerationAction, string> = {
  warn: '⚠️',
  timeout: '🔇',
  untimeout: '🔊',
  kick: '👢',
  ban: '🔨',
  unban: '🕊️',
  purge: '🧹',
};

const ACTION_COLORS: Record<ModerationAction, number> = {
  warn: 0xfee75c,
  timeout: 0xe67e22,
  untimeout: 0x57f287,
  kick: 0xe67e22,
  ban: 0xed4245,
  unban: 0x57f287,
  purge: 0x5865f2,
};

const reasonText = (r: string | null) => (r ? escapeMarkdown(r) : '*Aucune raison fournie*');

/** Embed du salon de logs. */
export function caseEmbed(c: ModerationCase): EmbedBuilder {
  const target = c.action === 'purge' ? `<#${c.targetId}>` : `<@${c.targetId}> (\`${c.targetId}\`)`;
  const embed = new EmbedBuilder()
    .setColor(ACTION_COLORS[c.action])
    .setTitle(`${ACTION_EMOJIS[c.action]} Cas #${c.caseNumber} — ${ACTION_LABELS[c.action]}`)
    .addFields(
      { name: c.action === 'purge' ? 'Salon' : 'Membre', value: target, inline: true },
      { name: 'Modérateur', value: `<@${c.moderatorId}>`, inline: true },
    )
    .setTimestamp(c.createdAt);

  if (c.durationMs !== null && c.expiresAt !== null) {
    embed.addFields({
      name: 'Durée',
      value: `${formatDuration(c.durationMs)} (fin ${relativeTime(c.expiresAt)})`,
      inline: true,
    });
  }
  if (c.action === 'purge' && c.metadata) {
    const deleted = Number(c.metadata['deleted'] ?? 0);
    const author = typeof c.metadata['authorId'] === 'string' ? ` de <@${c.metadata['authorId']}>` : '';
    embed.addFields({ name: 'Messages supprimés', value: `${deleted}${author}`, inline: true });
  }
  embed.addFields({ name: 'Raison', value: reasonText(c.reason) });
  return embed;
}

/** Une ligne de `/sanctions`. */
export function caseLine(c: ModerationCase): string {
  const duration = c.durationMs !== null ? ` · ${formatDuration(c.durationMs)}` : '';
  const line =
    `**#${c.caseNumber}** ${ACTION_EMOJIS[c.action]} ${ACTION_LABELS[c.action]}${duration} · ${relativeTime(c.createdAt)} ` +
    `par <@${c.moderatorId}>\n> ${reasonText(c.reason)}`;
  return c.revoked ? `~~${line.split('\n')[0]}~~ *(révoqué)*\n${line.split('\n')[1]}` : line;
}

/** MP envoyé au membre sanctionné. */
export function sanctionDm(action: ModerationAction, guildName: string, reason: string | null, durationMs?: number): string {
  const where = `sur **${escapeMarkdown(guildName)}**`;
  const what: Partial<Record<ModerationAction, string>> = {
    warn: `⚠️ Tu as reçu un avertissement ${where}.`,
    timeout: `🔇 Tu as été exclu·e temporairement ${where} pour ${formatDuration(durationMs ?? 0)}.`,
    kick: `👢 Tu as été expulsé·e ${where}.`,
    ban: `🔨 Tu as été banni·e ${where}.`,
  };
  return `${what[action] ?? `${ACTION_LABELS[action]} ${where}.`}\n**Raison :** ${reasonText(reason)}`;
}

/** Texte de la raison transmise au journal d'audit Discord (512 caractères max). */
export function auditReason(moderatorTag: string, reason: string | null): string {
  return `${moderatorTag} : ${reason ?? 'aucune raison fournie'}`.slice(0, 512);
}
