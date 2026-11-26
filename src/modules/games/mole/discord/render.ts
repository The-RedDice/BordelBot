/**
 * Rendu Discord de la Taupe : fonctions pures (état -> builders), sans appel réseau.
 * Les mentions dans les embeds ne notifient personne, d'où les messages
 * « notice » séparés pour prévenir les joueurs.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} from 'discord.js';
import { currentTurnPlayer, type MoleConfig } from '../machine.js';
import type { FinishedState, InGameFields, MoleEffect, MoleRole, MoleState } from '../types.js';
import { MODAL_TEXT_FIELD, moleCustomId } from './ids.js';

export interface BoardView {
  readonly sessionId: string;
  readonly state: MoleState;
  readonly config: MoleConfig;
  /** Échéance du timer actif (epoch ms). */
  readonly deadline: number | null;
  readonly name: (userId: string) => string;
}

type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

export interface BoardMessage {
  readonly content: string;
  readonly embeds: EmbedBuilder[];
  readonly components: Row[];
}

const COLORS = {
  lobby: 0x5865f2,
  running: 0xfee75c,
  agents: 0x57f287,
  mole: 0xed4245,
  neutral: 0x99aab5,
} as const;

const mention = (id: string): string => `<@${id}>`;
const mentions = (ids: readonly string[]): string => ids.map(mention).join(', ');
export const relativeTime = (epochMs: number | null): string =>
  epochMs === null ? '' : `<t:${Math.ceil(epochMs / 1000)}:R>`;
const quote = (text: string): string => `« ${escapeMarkdown(text)} »`;
const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

// ---------- Boutons ----------

function button(view: BoardView, action: Parameters<typeof moleCustomId>[0], label: string, style: ButtonStyle) {
  return new ButtonBuilder().setCustomId(moleCustomId(action, view.sessionId)).setLabel(label).setStyle(style);
}

const roleButton = (v: BoardView) => button(v, 'role', 'Voir mon rôle', ButtonStyle.Secondary).setEmoji('🔍');
const cancelButton = (v: BoardView) => button(v, 'cancel', 'Annuler', ButtonStyle.Danger);
const buttonRow = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

// ---------- Blocs de texte ----------

/** Liste des tours de parole : indices donnés, joueur en cours, joueurs à venir. */
function turnsBlock(s: InGameFields, config: MoleConfig, currentIndex: number | null, deadline: number | null): string {
  const total = s.players.length * config.clueRounds;
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    const n = s.turnOrder.length;
    if (config.clueRounds > 1 && i % n === 0) lines.push(`**Tour ${i / n + 1}**`);
    const player = s.turnOrder[i % n] as string;
    const clue = s.clues[i];
    if (clue) {
      lines.push(`${mention(player)} — ${clue.text === null ? '*a passé son tour*' : quote(clue.text)}`);
    } else if (i === currentIndex) {
      lines.push(`✍️ ${mention(player)} — *réfléchit… (fin ${relativeTime(deadline)})*`);
    } else if (currentIndex !== null) {
      lines.push(`⏳ ${mention(player)}`);
    }
  }
  return lines.join('\n');
}

function voteSummary(s: FinishedState): string {
  const entries = Object.entries(s.votes);
  if (entries.length === 0) return '*Aucun vote.*';
  return entries.map(([voter, target]) => `${mention(voter)} → ${mention(target)}`).join('\n');
}

function endingText(s: FinishedState): string {
  const mole = mention(s.moleId);
  switch (s.reason) {
    case 'moleGuessed':
      return `La taupe ${mole} a été démasquée… mais a trouvé le mot (${quote(s.guess ?? '')}) !`;
    case 'moleCaught':
      return s.guess === null
        ? `La taupe ${mole} a été démasquée et n'a proposé aucun mot à temps.`
        : `La taupe ${mole} a été démasquée et a proposé ${quote(s.guess)} : raté !`;
    case 'wrongAccusation':
      return `Le vote a désigné ${mention(s.accusedId ?? '')}, qui était un agent. La taupe était ${mole}.`;
    case 'tie':
      return `Le vote n'a désigné personne (égalité ou absence de votes). La taupe était ${mole}.`;
  }
}

// ---------- Plateau ----------

export function renderBoard(view: BoardView): BoardMessage {
  const { state: s, config } = view;
  const embed = new EmbedBuilder().setTitle('🕵️ La Taupe');
  const components: Row[] = [];

  switch (s.phase) {
    case 'lobby': {
      const canStart = s.players.length >= config.minPlayers;
      embed
        .setColor(COLORS.lobby)
        .setDescription(
          [
            "Tous les agents reçoivent un mot secret… sauf **la taupe**, qui ne connaît que la catégorie.",
            "Chacun donne un indice à tour de rôle, puis tout le monde vote pour démasquer la taupe.",
            '',
            `**Hôte :** ${mention(s.hostId)}`,
            `**Tours d'indices :** ${config.clueRounds}`,
            `**Expiration du salon :** ${relativeTime(view.deadline)}`,
          ].join('\n'),
        )
        .addFields({
          name: `Joueurs (${s.players.length}/${config.maxPlayers}, minimum ${config.minPlayers})`,
          value: s.players.map((p, i) => `${i + 1}. ${mention(p)}`).join('\n'),
        });
      components.push(
        buttonRow(
          button(view, 'join', 'Rejoindre', ButtonStyle.Primary).setEmoji('➕'),
          button(view, 'leave', 'Quitter', ButtonStyle.Secondary),
          button(view, 'start', 'Lancer', ButtonStyle.Success).setEmoji('▶️').setDisabled(!canStart),
          cancelButton(view),
        ),
      );
      break;
    }

    case 'clues': {
      const current = currentTurnPlayer(s);
      embed
        .setColor(COLORS.running)
        .setDescription(
          [
            `**Catégorie :** ${escapeMarkdown(s.category)}`,
            '',
            turnsBlock(s, config, s.turnIndex, view.deadline),
          ].join('\n'),
        );
      if (current) embed.setFooter({ text: truncate(`C'est au tour de ${view.name(current)}`, 2048) });
      components.push(
        buttonRow(
          button(view, 'clue', 'Donner mon indice', ButtonStyle.Primary).setEmoji('✍️'),
          roleButton(view),
          cancelButton(view),
        ),
      );
      break;
    }

    case 'voting': {
      const voters = Object.keys(s.votes);
      embed
        .setColor(COLORS.running)
        .setDescription(
          [
            `**Catégorie :** ${escapeMarkdown(s.category)}`,
            '',
            turnsBlock(s, config, null, null),
            '',
            `🗳️ **Vote en cours** — ${voters.length}/${s.players.length} — fin ${relativeTime(view.deadline)}`,
            voters.length ? `A voté : ${mentions(voters)}` : '*Personne n’a encore voté.*',
          ].join('\n'),
        );
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(moleCustomId('vote', view.sessionId))
            .setPlaceholder('Qui est la taupe ?')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(s.players.map((p) => ({ label: truncate(view.name(p), 100), value: p }))),
        ),
        buttonRow(roleButton(view), cancelButton(view)),
      );
      break;
    }

    case 'guess': {
      embed
        .setColor(COLORS.running)
        .setDescription(
          [
            `**Catégorie :** ${escapeMarkdown(s.category)}`,
            '',
            turnsBlock(s, config, null, null),
            '',
            `🎯 La taupe est démasquée : ${mention(s.moleId)} !`,
            `Dernière chance de deviner le mot secret — fin ${relativeTime(view.deadline)}.`,
          ].join('\n'),
        );
      components.push(
        buttonRow(
          button(view, 'guess', 'Deviner le mot', ButtonStyle.Primary).setEmoji('🎯'),
          roleButton(view),
          cancelButton(view),
        ),
      );
      break;
    }

    case 'finished': {
      const agentsWon = s.winner === 'agents';
      embed
        .setColor(agentsWon ? COLORS.agents : COLORS.mole)
        .setTitle(agentsWon ? '🕵️ La Taupe — victoire des agents' : '🕵️ La Taupe — victoire de la taupe')
        .setDescription(
          [
            endingText(s),
            `Le mot secret était **${escapeMarkdown(s.word)}** (catégorie ${escapeMarkdown(s.category)}).`,
            '',
            turnsBlock(s, config, null, null),
          ].join('\n'),
        )
        .addFields({ name: 'Votes', value: voteSummary(s) });
      break;
    }

    case 'cancelled': {
      const why =
        s.reason === 'host'
          ? `annulée par ${mention(s.cancelledBy ?? s.hostId)}`
          : s.reason === 'empty'
            ? 'annulée : tous les joueurs sont partis'
            : "annulée : personne ne l'a lancée à temps";
      embed.setColor(COLORS.neutral).setDescription(`Partie ${why}.`);
      break;
    }
  }

  return { content: '', embeds: [embed], components };
}

/** Plateau figé quand le bot s'arrête en cours de partie. */
export function renderInterrupted(): BoardMessage {
  return {
    content: '',
    embeds: [
      new EmbedBuilder()
        .setTitle('🕵️ La Taupe')
        .setColor(COLORS.neutral)
        .setDescription('Partie interrompue : le bot a redémarré. Relancez une partie avec `/jeu taupe`.'),
    ],
    components: [],
  };
}

// ---------- Notices (messages qui notifient) ----------

/** Texte à poster dans le salon pour un effet, ou null s'il n'y a rien à annoncer. */
export function noticeFor(effect: MoleEffect, view: BoardView): string | null {
  const s = view.state;
  switch (effect.type) {
    case 'gameStarted':
      return (
        `🕵️ La partie commence ! ${mentions(s.players)}\n` +
        `Cliquez sur **Voir mon rôle** pour découvrir votre mission (catégorie : **${escapeMarkdown(effect.category)}**).`
      );
    case 'turnStarted':
      return `✍️ ${mention(effect.userId)}, à toi de donner un indice ! Fin ${relativeTime(view.deadline)}.`;
    case 'votingStarted':
      return (
        `🗳️ Tous les indices sont donnés ! ${mentions(effect.candidates)}\n` +
        `Votez dans le menu du message de jeu. Fin ${relativeTime(view.deadline)}.`
      );
    case 'guessStarted':
      return (
        `🎯 ${mention(effect.moleId)} était bien la taupe ! ` +
        `Dernière chance : clique sur **Deviner le mot** avant la fin ${relativeTime(view.deadline)}.`
      );
    case 'gameEnded': {
      const winners = effect.winner === 'mole' ? [effect.moleId] : s.players.filter((p) => p !== effect.moleId);
      const label = effect.winner === 'mole' ? 'Victoire de la taupe' : 'Victoire des agents';
      return `🏁 **${label} !** Le mot était **${escapeMarkdown(effect.word)}**. Bravo à ${mentions(winners)} !`;
    }
    case 'gameCancelled':
      return '❌ La partie de Taupe a été annulée.';
    default:
      return null;
  }
}

/** Effets dont la notice doit rester dans le salon (les autres sont remplacées par la suivante). */
export function isFinalNotice(effect: MoleEffect): boolean {
  return effect.type === 'gameEnded' || effect.type === 'gameCancelled';
}

// ---------- Messages privés (éphémères) ----------

export function roleMessage(info: { role: MoleRole; category: string; word: string | null }): string {
  if (info.role === 'mole') {
    return [
      '🕳️ Tu es **la taupe** !',
      `Catégorie : **${escapeMarkdown(info.category)}**. Tu ne connais pas le mot secret.`,
      'Écoute les indices, donne un indice crédible et ne te fais pas démasquer.',
      'Si tu es démasqué·e, tu pourras encore gagner en devinant le mot.',
    ].join('\n');
  }
  return [
    '🔎 Tu es **agent**.',
    `Catégorie : **${escapeMarkdown(info.category)}** — mot secret : **${escapeMarkdown(info.word ?? '')}**`,
    'Donne un indice qui prouve que tu connais le mot, sans le rendre évident pour la taupe.',
  ].join('\n');
}

// ---------- Modales ----------

export function clueModal(sessionId: string, maxLength: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(moleCustomId('clueModal', sessionId))
    .setTitle('Ton indice')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Indice')
        .setDescription(`Un mot ou une courte expression (${maxLength} caractères max).`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(MODAL_TEXT_FIELD)
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(maxLength)
            .setRequired(true),
        ),
    );
}

export function guessModal(sessionId: string, category: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(moleCustomId('guessModal', sessionId))
    .setTitle('Deviner le mot secret')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Mot secret')
        .setDescription(truncate(`Catégorie : ${category}. Une seule tentative !`, 100))
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(MODAL_TEXT_FIELD)
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(60)
            .setRequired(true),
        ),
    );
}
