import { DiscordAPIError, RESTJSONErrorCodes, type Message, type SendableChannels } from 'discord.js';
import type { Logger } from '../../../../core/logger.js';
import type { GameSession } from '../../engine/GameSession.js';
import type { MoleMachine } from '../machine.js';
import type { MoleAction, MoleEffect, MoleState } from '../types.js';
import { isFinalNotice, noticeFor, renderBoard, renderInterrupted, type BoardView } from './render.js';

export type MoleSession = GameSession<MoleState, MoleAction, MoleEffect>;

const isUnknownMessage = (err: unknown): boolean =>
  err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage;

/**
 * Lien entre une session de Taupe et un salon Discord.
 * - Un seul « plateau » (message) par partie, réédité après chaque transition.
 * - Les rendus sont regroupés : plusieurs transitions rapprochées (votes) ne
 *   donnent qu'une édition, qui affiche toujours l'état le plus récent.
 * - Tous les appels Discord passent par une file séquentielle : l'ordre des
 *   messages est garanti et un échec réseau n'affecte pas la partie.
 */
export class MoleTable {
  /** Pseudos connus, pour les libellés du menu de vote (les embeds utilisent des mentions). */
  readonly names = new Map<string, string>();
  private board: Message | null = null;
  private boardGone = false;
  private lastNotice: Message | null = null;
  private chain: Promise<void> = Promise.resolve();
  private renderQueued = false;
  private readonly unsubscribe: () => void;

  constructor(
    readonly session: MoleSession,
    readonly machine: MoleMachine,
    private readonly channel: SendableChannels,
    private readonly logger: Logger,
    onClosed: () => void,
  ) {
    this.unsubscribe = session.subscribe({
      onTransition: ({ effects }) => {
        this.scheduleRender();
        // Les notices sont calculées tout de suite : l'échéance affichée est celle de cette transition.
        const view = this.view();
        for (const effect of effects) {
          const text = noticeFor(effect, view);
          if (text) this.enqueue(() => this.notify(text, isFinalNotice(effect)));
        }
      },
      onEnd: () => {
        onClosed();
        this.enqueue(async () => this.unsubscribe());
      },
    });
  }

  /** Publie le plateau dans le salon. Lève si l'envoi échoue. */
  async open(): Promise<void> {
    this.board = await this.channel.send(renderBoard(this.view()));
  }

  /** Arrêt du bot : attend les envois en cours, puis fige le plateau. */
  async interrupt(): Promise<void> {
    this.unsubscribe();
    await this.chain;
    if (!this.board || this.boardGone) return;
    await this.board.edit(renderInterrupted()).catch(() => undefined);
  }

  get boardUrl(): string | null {
    return this.board?.url ?? null;
  }

  private view(): BoardView {
    return {
      sessionId: this.session.id,
      state: this.session.state,
      config: this.machine.config,
      deadline: this.session.timerDeadline,
      name: (id) => this.names.get(id) ?? 'Joueur inconnu',
    };
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err: unknown) => {
      this.logger.error(`Échec d'un appel Discord (partie ${this.session.id})`, err);
    });
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    this.enqueue(async () => {
      this.renderQueued = false;
      await this.renderNow();
    });
  }

  private async renderNow(): Promise<void> {
    if (!this.board || this.boardGone) return;
    try {
      await this.board.edit(renderBoard(this.view()));
    } catch (err) {
      if (!isUnknownMessage(err)) throw err;
      // Plateau supprimé : la partie n'est plus jouable, on l'annule pour libérer le salon.
      this.boardGone = true;
      this.logger.warn(`Plateau supprimé, annulation de la partie ${this.session.id}`);
      if (!this.session.isOver) this.session.dispatch({ type: 'cancel', userId: this.session.state.hostId });
    }
  }

  /** Poste une notice ; les notices intermédiaires sont supprimées quand la suivante arrive. */
  private async notify(content: string, keep: boolean): Promise<void> {
    const previous = this.lastNotice;
    this.lastNotice = null;
    const message = await this.channel.send({ content });
    if (!keep) this.lastNotice = message;
    await previous?.delete().catch(() => undefined);
  }
}
