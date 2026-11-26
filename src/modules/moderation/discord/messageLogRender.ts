import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { relativeTime } from '../../../core/replies.js';

const EDIT_COLOR = 0x5865f2;
const DELETE_COLOR = 0xed4245;
const UNKNOWN = '*Inconnu : message envoyé avant le démarrage du bot.*';

/** Coupe un texte à `max` caractères, marque de coupure comprise. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Contenu affichable dans un embed : Markdown neutralisé, vide signalé. */
function shown(content: string | null, max: number): string {
  if (content === null) return UNKNOWN;
  if (!content.trim()) return '*Pas de texte.*';
  return clip(escapeMarkdown(content), max);
}

export interface LoggedAuthor {
  readonly id: string;
  readonly tag: string;
  readonly avatarUrl: string;
}

export interface EditLog {
  readonly author: LoggedAuthor;
  readonly channelId: string;
  readonly url: string;
  /** null : ancienne version inconnue (message pas en cache). */
  readonly before: string | null;
  readonly after: string;
  readonly at: number;
}

/** null si le texte n'a pas changé (Discord signale aussi l'ajout d'aperçus de liens). */
export function editEmbed(log: EditLog): EmbedBuilder | null {
  if (log.before !== null && log.before === log.after) return null;
  return new EmbedBuilder()
    .setColor(EDIT_COLOR)
    .setAuthor({ name: `${log.author.tag} a modifié un message`, iconURL: log.author.avatarUrl })
    .setDescription(`Dans <#${log.channelId}> · [voir le message](${log.url})`)
    .addFields({ name: 'Avant', value: shown(log.before, 1024) }, { name: 'Après', value: shown(log.after, 1024) })
    .setFooter({ text: `Membre : ${log.author.id}` })
    .setTimestamp(log.at);
}

export interface DeleteLog {
  /** null : auteur inconnu (message pas en cache). */
  readonly author: LoggedAuthor | null;
  readonly channelId: string;
  readonly messageId: string;
  readonly content: string | null;
  readonly attachments: readonly string[];
  readonly createdAt: number | null;
  readonly at: number;
}

export function deleteEmbed(log: DeleteLog): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(DELETE_COLOR)
    .setAuthor(
      log.author
        ? { name: `Message de ${log.author.tag} supprimé`, iconURL: log.author.avatarUrl }
        : { name: 'Message supprimé' },
    )
    .setDescription(
      [
        `Dans <#${log.channelId}>${log.createdAt !== null ? ` · envoyé ${relativeTime(log.createdAt)}` : ''}`,
        '',
        shown(log.content, 3800),
      ].join('\n'),
    )
    .setFooter({ text: log.author ? `Membre : ${log.author.id} · Message : ${log.messageId}` : `Message : ${log.messageId}` })
    .setTimestamp(log.at);
  if (log.attachments.length) {
    embed.addFields({ name: 'Pièces jointes', value: clip(log.attachments.map((a) => `• ${escapeMarkdown(a)}`).join('\n'), 1024) });
  }
  return embed;
}

export interface TranscriptLine {
  readonly authorTag: string | null;
  readonly authorId: string | null;
  readonly createdAt: number | null;
  readonly content: string | null;
  readonly attachments: readonly string[];
}

/** Transcription texte d'une suppression en masse, du plus ancien au plus récent. */
export function bulkTranscript(lines: readonly TranscriptLine[]): string {
  const sorted = [...lines].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return sorted
    .map((l) => {
      const when = l.createdAt !== null ? new Date(l.createdAt).toISOString().replace('T', ' ').slice(0, 19) : '????-??-?? ??:??:??';
      const who = l.authorTag ? `${l.authorTag} (${l.authorId})` : 'Auteur inconnu';
      const text = l.content ?? '[contenu inconnu : message envoyé avant le démarrage du bot]';
      const files = l.attachments.length ? ` [pièces jointes : ${l.attachments.join(', ')}]` : '';
      return `[${when} UTC] ${who} : ${text}${files}`;
    })
    .join('\n');
}

export function bulkEmbed(channelId: string, count: number, known: number, at: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(DELETE_COLOR)
    .setAuthor({ name: `${count} messages supprimés en masse` })
    .setDescription(
      `Dans <#${channelId}>.` +
        (known < count ? `\n${count - known} message(s) au contenu inconnu (envoyés avant le démarrage du bot).` : '') +
        (known > 0 ? '\nContenu dans le fichier joint.' : ''),
    )
    .setTimestamp(at);
}
