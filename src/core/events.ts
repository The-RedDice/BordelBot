/**
 * Catalogue des événements internes. C'est le SEUL contrat partagé entre modules :
 * le module de jeux émet `game:finished` sans connaître l'économie, et l'économie
 * s'y abonne sans connaître les jeux.
 */
export type GameKind = 'mole' | 'one-vs-all';

export interface BotEvents {
  'game:finished': {
    readonly sessionId: string;
    readonly guildId: string;
    readonly game: GameKind;
    readonly winnerIds: readonly string[];
    readonly loserIds: readonly string[];
    readonly finishedAt: number;
  };
  'economy:balanceChanged': {
    readonly guildId: string;
    readonly userId: string;
    readonly delta: number;
    readonly newBalance: number;
    readonly reason: string;
  };
  'moderation:caseCreated': {
    readonly caseId: number;
    readonly guildId: string;
    readonly action: ModerationAction;
    readonly targetId: string;
    readonly moderatorId: string;
  };
}

export type ModerationAction = 'warn' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban' | 'purge';
