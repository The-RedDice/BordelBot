/** customIds : `mole:<action>:<sessionId>` (UUID de 36 car. : on reste loin des 100 max). */
export const MOLE_PREFIX = 'mole';

export const MOLE_ACTIONS = [
  'join',
  'leave',
  'start',
  'cancel',
  'role',
  'clue',
  'clueModal',
  'vote',
  'guess',
  'guessModal',
] as const;
export type MoleUiAction = (typeof MOLE_ACTIONS)[number];

/** Identifiant du champ texte dans les modales d'indice et de devinette. */
export const MODAL_TEXT_FIELD = 'text';

export function moleCustomId(action: MoleUiAction, sessionId: string): string {
  return `${MOLE_PREFIX}:${action}:${sessionId}`;
}

export function parseMoleCustomId(customId: string): { action: MoleUiAction; sessionId: string } | null {
  const [prefix, action, sessionId, ...rest] = customId.split(':');
  if (prefix !== MOLE_PREFIX || !sessionId || rest.length > 0) return null;
  if (!(MOLE_ACTIONS as readonly string[]).includes(action ?? '')) return null;
  return { action: action as MoleUiAction, sessionId };
}
