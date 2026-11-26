import { EmbedBuilder, escapeMarkdown, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { SlashCommand } from '../../../core/commands/types.js';
import { relativeTime, replyEphemeral } from '../../../core/replies.js';
import { MAX_NOTE_LENGTH, type ModerationNote } from '../ModerationService.js';
import { base, guard, type Deps } from './helpers.js';

export const NOTES_SHOWN = 10;

export function noteLine(n: ModerationNote): string {
  return `**#${n.id}** · ${relativeTime(n.createdAt)} par <@${n.authorId}>\n> ${escapeMarkdown(n.content).replace(/\n/g, '\n> ')}`;
}

/**
 * `/note` : notes internes sur un membre (contexte, comportement à surveiller…).
 * Elles ne comptent pas comme avertissements, ne sont jamais envoyées au membre
 * et ne sont affichées qu'aux modérateurs, en privé.
 */
export function createNoteCommand(deps: Deps): SlashCommand {
  const service = () => deps.getService();
  return {
    data: base('note', 'Notes internes de modération sur un membre', PermissionFlagsBits.ModerateMembers)
      .addSubcommand((s) =>
        s
          .setName('ajouter')
          .setDescription('Ajoute une note (invisible pour le membre, ne compte pas comme avertissement)')
          .addUserOption((o) => o.setName('utilisateur').setDescription('Utilisateur concerné').setRequired(true))
          .addStringOption((o) =>
            o.setName('texte').setDescription('Contenu de la note').setRequired(true).setMaxLength(MAX_NOTE_LENGTH),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('voir')
          .setDescription('Notes d’un utilisateur')
          .addUserOption((o) => o.setName('utilisateur').setDescription('Utilisateur concerné').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('supprimer')
          .setDescription('Supprime une note (son auteur, ou un membre qui peut gérer le serveur)')
          .addIntegerOption((o) => o.setName('numero').setDescription('Numéro de la note').setRequired(true).setMinValue(1)),
      ),
    async execute(raw) {
      const i = await guard(raw, PermissionFlagsBits.ModerateMembers);
      if (!i) return;
      const sub = i.options.getSubcommand();

      if (sub === 'ajouter') {
        const user = i.options.getUser('utilisateur', true);
        const text = i.options.getString('texte', true);
        if (!text.trim()) return replyEphemeral(i, 'La note est vide.');
        const note = service().addNote(i.guildId, user.id, i.user.id, text);
        const total = service().countNotes(i.guildId, user.id);
        return replyEphemeral(i, `📝 Note **#${note.id}** ajoutée pour ${user} (${total} au total).`);
      }

      if (sub === 'voir') {
        const user = i.options.getUser('utilisateur', true);
        const notes = service().listNotes(i.guildId, user.id, NOTES_SHOWN);
        const total = service().countNotes(i.guildId, user.id);
        const embed = new EmbedBuilder()
          .setColor(0x99aab5)
          .setAuthor({ name: `Notes sur ${user.tag}`, iconURL: user.displayAvatarURL() })
          .setDescription(notes.length ? notes.map(noteLine).join('\n\n').slice(0, 4096) : '*Aucune note.*')
          .setFooter({ text: total > notes.length ? `${notes.length} plus récentes sur ${total}` : `${total} note(s)` });
        await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return;
      }

      const id = i.options.getInteger('numero', true);
      const note = service().getNote(i.guildId, id);
      if (!note) return replyEphemeral(i, `Aucune note #${id} sur ce serveur.`);
      if (note.authorId !== i.user.id && !i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return replyEphemeral(i, 'Seul son auteur, ou un membre qui peut gérer le serveur, peut supprimer cette note.');
      }
      service().deleteNote(i.guildId, id);
      await replyEphemeral(i, `🗑️ Note #${id} sur <@${note.targetId}> supprimée.`);
    },
  };
}
