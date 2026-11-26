/** Minuscules, sans accents ni ponctuation : « L'Éléphant ! » -> ["l", "elephant"]. */
export function tokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function sameWord(a: string, b: string): boolean {
  const ta = tokens(a).join(' ');
  return ta.length > 0 && ta === tokens(b).join(' ');
}

/** Vrai si l'indice contient le mot secret comme mot entier (« chat » oui, « château » non). */
export function revealsWord(clue: string, word: string): boolean {
  const w = tokens(word).join(' ');
  if (!w) return false;
  return ` ${tokens(clue).join(' ')} `.includes(` ${w} `);
}
