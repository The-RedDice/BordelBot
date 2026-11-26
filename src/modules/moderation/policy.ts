/**
 * Règles de hiérarchie, indépendantes de discord.js (positions de rôles = nombres).
 * Discord refuse déjà les actions impossibles pour le bot, mais vérifier en amont
 * donne un message clair et empêche un modérateur de sanctionner un supérieur
 * en passant par le bot.
 */
export interface HierarchyInput {
  readonly actorId: string;
  readonly targetId: string;
  readonly botId: string;
  readonly ownerId: string;
  /** Position du rôle le plus haut de chacun (0 = @everyone). */
  readonly actorPosition: number;
  readonly targetPosition: number;
  readonly botPosition: number;
  /** false pour un avertissement : le bot n'agit pas sur Discord, sa position est sans effet. */
  readonly botMustOutrank: boolean;
}

export type HierarchyError = 'SELF' | 'BOT_ITSELF' | 'TARGET_IS_OWNER' | 'ACTOR_TOO_LOW' | 'BOT_TOO_LOW';

export const HIERARCHY_MESSAGES: Record<HierarchyError, string> = {
  SELF: 'Tu ne peux pas te sanctionner toi-même.',
  BOT_ITSELF: 'Je ne peux pas me sanctionner moi-même.',
  TARGET_IS_OWNER: 'Impossible de sanctionner le propriétaire du serveur.',
  ACTOR_TOO_LOW: 'Ce membre a un rôle égal ou supérieur au tien.',
  BOT_TOO_LOW: 'Ce membre a un rôle égal ou supérieur au mien : place mon rôle plus haut dans la liste des rôles.',
};

export function checkHierarchy(p: HierarchyInput): HierarchyError | null {
  if (p.targetId === p.actorId) return 'SELF';
  if (p.targetId === p.botId) return 'BOT_ITSELF';
  if (p.targetId === p.ownerId) return 'TARGET_IS_OWNER';
  if (p.actorId !== p.ownerId && p.actorPosition <= p.targetPosition) return 'ACTOR_TOO_LOW';
  if (p.botMustOutrank && p.botPosition <= p.targetPosition) return 'BOT_TOO_LOW';
  return null;
}
