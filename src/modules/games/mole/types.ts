/**
 * La Taupe : tous les agents connaissent un mot secret, sauf la taupe qui ne
 * connaît que la catégorie. Chacun donne un indice à tour de rôle, puis tout le
 * monde vote. Si la taupe est démasquée, elle a une dernière chance : deviner le mot.
 */

export type MoleRole = 'mole' | 'agent';
export type MoleWinner = 'mole' | 'agents';
export type MoleEndReason =
  | 'moleCaught' //       taupe désignée puis mauvaise réponse (ou pas de réponse)
  | 'moleGuessed' //      taupe désignée mais elle a trouvé le mot
  | 'wrongAccusation' //  un agent a été désigné à tort
  | 'tie'; //             égalité ou aucun vote : personne n'est désigné

export interface Clue {
  readonly playerId: string;
  readonly round: number;
  /** null : tour passé (temps écoulé). */
  readonly text: string | null;
}

interface Common {
  readonly hostId: string;
  readonly players: readonly string[];
}

export interface InGameFields extends Common {
  readonly moleId: string;
  readonly category: string;
  readonly word: string;
  readonly turnOrder: readonly string[];
  readonly clues: readonly Clue[];
}

export interface LobbyState extends Common {
  readonly phase: 'lobby';
}

export interface CluesState extends InGameFields {
  readonly phase: 'clues';
  /** Index global de tour, de 0 à players × clueRounds - 1. */
  readonly turnIndex: number;
}

export interface VotingState extends InGameFields {
  readonly phase: 'voting';
  /** votant -> accusé */
  readonly votes: Readonly<Record<string, string>>;
}

export interface GuessState extends InGameFields {
  readonly phase: 'guess';
  readonly votes: Readonly<Record<string, string>>;
  readonly accusedId: string;
}

export interface FinishedState extends InGameFields {
  readonly phase: 'finished';
  readonly votes: Readonly<Record<string, string>>;
  readonly accusedId: string | null;
  readonly guess: string | null;
  readonly winner: MoleWinner;
  readonly reason: MoleEndReason;
}

/** host : annulée par l'hôte · empty : tous les joueurs sont partis · expired : lobby jamais lancé. */
export type MoleCancelReason = 'host' | 'empty' | 'expired';

export interface CancelledState extends Common {
  readonly phase: 'cancelled';
  readonly reason: MoleCancelReason;
  /** Renseigné quand reason = 'host'. */
  readonly cancelledBy: string | null;
}

export type MoleState = LobbyState | CluesState | VotingState | GuessState | FinishedState | CancelledState;

export type MoleAction =
  | { readonly type: 'join'; readonly userId: string }
  | { readonly type: 'leave'; readonly userId: string }
  | { readonly type: 'start'; readonly userId: string }
  | { readonly type: 'cancel'; readonly userId: string }
  | { readonly type: 'clue'; readonly userId: string; readonly text: string }
  | { readonly type: 'vote'; readonly userId: string; readonly targetId: string }
  | { readonly type: 'guess'; readonly userId: string; readonly word: string }
  | { readonly type: 'timeout'; readonly key: string };

/** Effets émis vers l'adaptateur. `roleAssigned` est privé : à n'afficher qu'au joueur concerné. */
export type MoleEffect =
  | { readonly type: 'playerJoined'; readonly userId: string; readonly players: readonly string[] }
  | {
      readonly type: 'playerLeft';
      readonly userId: string;
      readonly players: readonly string[];
      readonly hostId: string;
    }
  | { readonly type: 'gameStarted'; readonly category: string; readonly turnOrder: readonly string[] }
  | {
      readonly type: 'roleAssigned';
      readonly userId: string;
      readonly role: MoleRole;
      readonly category: string;
      readonly word: string | null;
    }
  | { readonly type: 'turnStarted'; readonly userId: string; readonly turnIndex: number; readonly round: number }
  | { readonly type: 'clueGiven'; readonly userId: string; readonly round: number; readonly text: string | null }
  | { readonly type: 'votingStarted'; readonly candidates: readonly string[] }
  | { readonly type: 'voteCast'; readonly voterId: string; readonly votesCast: number; readonly votesExpected: number }
  | {
      readonly type: 'voteResolved';
      readonly tally: Readonly<Record<string, number>>;
      readonly accusedId: string | null;
    }
  | { readonly type: 'guessStarted'; readonly moleId: string }
  | {
      readonly type: 'gameEnded';
      readonly winner: MoleWinner;
      readonly reason: MoleEndReason;
      readonly moleId: string;
      readonly word: string;
      readonly accusedId: string | null;
      readonly guess: string | null;
    }
  | { readonly type: 'gameCancelled'; readonly reason: MoleCancelReason; readonly by: string | null };
