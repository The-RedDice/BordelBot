import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from './duration.js';

export type ThresholdAction = 'timeout' | 'kick' | 'ban';

/** Sanction appliquée automatiquement quand un membre atteint `warnCount` avertissements actifs. */
export interface WarnThreshold {
  readonly warnCount: number;
  readonly action: ThresholdAction;
  /** Obligatoire pour un timeout ; pour un ban, null = définitif. */
  readonly durationMs: number | null;
}

export const MAX_THRESHOLDS = 10;
export const MAX_THRESHOLD_WARNS = 50;

const ACTION_ALIASES: Readonly<Record<string, ThresholdAction>> = {
  timeout: 'timeout',
  exclusion: 'timeout',
  mute: 'timeout',
  kick: 'kick',
  expulsion: 'kick',
  ban: 'ban',
  bannissement: 'ban',
};

export const THRESHOLD_LABELS: Record<ThresholdAction, string> = {
  timeout: 'exclusion temporaire',
  kick: 'expulsion',
  ban: 'bannissement',
};

export type ParseThresholdsResult =
  | { readonly ok: true; readonly value: WarnThreshold[] }
  | { readonly ok: false; readonly message: string };

/**
 * Une règle par ligne : « 3 = timeout 1h », « 5 = kick », « 7 = ban 7j », « 9 = ban ».
 * Lignes vides ignorées ; renvoie les paliers triés par nombre d'avertissements.
 */
export function parseThresholds(text: string): ParseThresholdsResult {
  const result: WarnThreshold[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = /^(\d+)\s*(?:avertissements?|warns?)?\s*[=:>-]+\s*([a-zé]+)\s*(.*)$/i.exec(line);
    const action = m ? ACTION_ALIASES[(m[2] ?? '').toLowerCase()] : undefined;
    if (!m || !action) {
      return { ok: false, message: `Ligne illisible : « ${line} ». Format : \`3 = timeout 1h\`, \`5 = kick\`, \`7 = ban 7j\`.` };
    }
    const warnCount = Number(m[1]);
    if (!Number.isInteger(warnCount) || warnCount < 1 || warnCount > MAX_THRESHOLD_WARNS) {
      return { ok: false, message: `« ${line} » : le nombre d’avertissements doit être compris entre 1 et ${MAX_THRESHOLD_WARNS}.` };
    }
    const rawDuration = (m[3] ?? '').trim();
    let durationMs: number | null = null;
    if (rawDuration) {
      if (action === 'kick') return { ok: false, message: `« ${line} » : une expulsion n’a pas de durée.` };
      durationMs = parseDuration(rawDuration);
      if (durationMs === null) return { ok: false, message: `« ${line} » : durée invalide (exemples : 10m, 2h, 3j).` };
    }
    if (action === 'timeout') {
      if (durationMs === null) return { ok: false, message: `« ${line} » : indique la durée de l’exclusion (ex. \`timeout 1h\`).` };
      if (durationMs > MAX_TIMEOUT_MS) return { ok: false, message: `« ${line} » : Discord limite les exclusions à 28 jours.` };
    }
    if (result.some((t) => t.warnCount === warnCount)) {
      return { ok: false, message: `Deux règles pour ${warnCount} avertissement(s).` };
    }
    result.push({ warnCount, action, durationMs });
  }
  if (result.length > MAX_THRESHOLDS) return { ok: false, message: `${MAX_THRESHOLDS} paliers au maximum.` };
  return { ok: true, value: result.sort((a, b) => a.warnCount - b.warnCount) };
}

/** Inverse de `parseThresholds` : sert à pré-remplir la modale de `/config`. */
export function formatThresholds(list: readonly WarnThreshold[]): string {
  return list
    .map((t) => `${t.warnCount} = ${t.action}${t.durationMs !== null ? ` ${formatDuration(t.durationMs)}` : ''}`)
    .join('\n');
}

/** Affichage lisible : « 3 avert. → exclusion temporaire (1 h) ». */
export function describeThreshold(t: WarnThreshold): string {
  const duration =
    t.durationMs !== null ? ` (${formatDuration(t.durationMs)})` : t.action === 'ban' ? ' (définitif)' : '';
  return `${t.warnCount} avert. → ${THRESHOLD_LABELS[t.action]}${duration}`;
}
