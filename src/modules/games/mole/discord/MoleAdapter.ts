import {
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type APIInteractionGuildMember,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type User,
} from 'discord.js';
import type { Logger } from '../../../../core/logger.js';
import { replyEphemeral } from '../../../../core/replies.js';
import type { GameService } from '../../GameService.js';
import { createMoleLobby, createMoleMachine, currentTurnPlayer, roleOf } from '../machine.js';
import type { MoleAction } from '../types.js';
import { MODAL_TEXT_FIELD, parseMoleCustomId } from './ids.js';
import { MoleTable } from './MoleTable.js';
import { clueModal, guessModal, roleMessage } from './render.js';

type ComponentInteraction = MessageComponentInteraction | ModalSubmitInteraction;

const SHUTDOWN_TIMEOUT_MS = 3_000;

function displayNameOf(i: { member: GuildMember | APIInteractionGuildMember | null; user: User }): string {
  if (i.member instanceof GuildMember) return i.member.displayName;
  return i.member?.nick ?? i.user.displayName;
}

const ephemeral = replyEphemeral;

/**
 * Traduit les interactions Discord en actions de la FSM.
 * Les réponses sont soit éphémères (erreurs, infos privées), soit un simple
 * acquittement : c'est MoleTable qui met à jour le plateau, pour toutes les
 * transitions, y compris celles déclenchées par les timers.
 */
export class MoleAdapter {
  private readonly tables = new Map<string, MoleTable>();
  private readonly logger: Logger;

  constructor(
    private readonly games: GameService,
    logger: Logger,
  ) {
    this.logger = logger.child('mole');
  }

  get activeTables(): number {
    return this.tables.size;
  }

  async create(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await ephemeral(interaction, 'Cette commande s’utilise sur un serveur.');
      return;
    }
    const channel = interaction.channel;
    if (!channel?.isSendable()) {
      await ephemeral(interaction, 'Je ne peux pas lancer de partie dans ce salon.');
      return;
    }
    const sendFlag = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    const missing = interaction.appPermissions.missing([
      PermissionFlagsBits.ViewChannel,
      sendFlag,
      PermissionFlagsBits.EmbedLinks,
    ]);
    if (missing.length > 0) {
      await ephemeral(interaction, `Il me manque des permissions dans ce salon : ${missing.join(', ')}.`);
      return;
    }

    const hostId = interaction.user.id;
    const machine = createMoleMachine({ clueRounds: interaction.options.getInteger('tours') ?? 1 });
    const started = this.games.start({
      machine,
      initialState: createMoleLobby(hostId),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      hostId,
    });
    if (!started.ok) {
      await ephemeral(interaction, started.error.message);
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { session } = started;
    const table = new MoleTable(session, machine, channel, this.logger, () => this.tables.delete(session.id));
    table.names.set(hostId, displayNameOf(interaction));
    this.tables.set(session.id, table);

    try {
      await table.open();
    } catch (err) {
      this.logger.error(`Impossible de publier le plateau de la partie ${session.id}`, err);
      session.dispatch({ type: 'cancel', userId: hostId });
      await interaction.editReply('Impossible de publier la partie dans ce salon.');
      return;
    }
    await interaction.editReply(
      `Partie créée ! ${table.boardUrl ?? ''}\nLes autres joueurs peuvent rejoindre avec le bouton **Rejoindre**.`,
    );
  }

  async handleComponent(interaction: ComponentInteraction): Promise<void> {
    const parsed = parseMoleCustomId(interaction.customId);
    if (!parsed) return;
    const table = this.tables.get(parsed.sessionId);
    if (!table) {
      await ephemeral(interaction, 'Cette partie est terminée ou n’existe plus.');
      return;
    }

    const userId = interaction.user.id;
    table.names.set(userId, displayNameOf(interaction));
    const { session, machine } = table;

    switch (parsed.action) {
      case 'join':
      case 'leave':
      case 'start':
      case 'cancel':
        return this.dispatchAndAck(interaction, table, { type: parsed.action, userId });

      case 'role': {
        const info = roleOf(session.state, userId);
        return ephemeral(interaction, info ? roleMessage(info) : 'Tu ne participes pas à cette partie.');
      }

      case 'clue': {
        if (!interaction.isButton()) return;
        if (currentTurnPlayer(session.state) !== userId) return ephemeral(interaction, 'Ce n’est pas ton tour.');
        return interaction.showModal(clueModal(session.id, machine.config.maxClueLength));
      }

      case 'clueModal': {
        if (!interaction.isModalSubmit()) return;
        const text = interaction.fields.getTextInputValue(MODAL_TEXT_FIELD);
        return this.dispatchAndAck(interaction, table, { type: 'clue', userId, text });
      }

      case 'vote': {
        if (!interaction.isStringSelectMenu()) return;
        const targetId = interaction.values[0];
        if (!targetId) return;
        const result = session.dispatch({ type: 'vote', userId, targetId });
        if (!result.ok) return ephemeral(interaction, result.error.message);
        // Le vote reste secret jusqu'à la fin : confirmation privée uniquement.
        return ephemeral(
          interaction,
          `🗳️ Vote enregistré contre **${table.names.get(targetId) ?? 'ce joueur'}**. ` +
            'Tu peux changer d’avis tant que le vote est ouvert.',
        );
      }

      case 'guess': {
        if (!interaction.isButton()) return;
        const s = session.state;
        if (s.phase !== 'guess' || s.moleId !== userId) {
          return ephemeral(interaction, 'Seule la taupe démasquée peut deviner le mot.');
        }
        return interaction.showModal(guessModal(session.id, s.category));
      }

      case 'guessModal': {
        if (!interaction.isModalSubmit()) return;
        const word = interaction.fields.getTextInputValue(MODAL_TEXT_FIELD);
        return this.dispatchAndAck(interaction, table, { type: 'guess', userId, word });
      }
    }
  }

  /** Arrêt du bot : fige les plateaux (borné dans le temps). Les sessions sont stoppées par GameService. */
  async dispose(): Promise<void> {
    const tables = [...this.tables.values()];
    this.tables.clear();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref());
    await Promise.race([Promise.allSettled(tables.map((t) => t.interrupt())), timeout]);
  }

  private async dispatchAndAck(interaction: ComponentInteraction, table: MoleTable, action: MoleAction): Promise<void> {
    const result = table.session.dispatch(action);
    if (!result.ok) return ephemeral(interaction, result.error.message);
    // Le plateau est mis à jour par MoleTable : on acquitte sans répondre.
    if (interaction.isMessageComponent() || interaction.isFromMessage()) {
      await interaction.deferUpdate();
    } else {
      await ephemeral(interaction, 'C’est noté !');
    }
  }
}
