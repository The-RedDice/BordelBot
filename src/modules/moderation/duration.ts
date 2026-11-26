const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Durée maximale d'un timeout imposée par Discord. */
export const MAX_TIMEOUT_MS = 28 * DAY;

const UNITS: Readonly<Record<string, number>> = {
  s: SECOND, sec: SECOND, seconde: SECOND, secondes: SECOND,
  m: MINUTE, min: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, heure: HOUR, heures: HOUR,
  j: DAY, d: DAY, jour: DAY, jours: DAY,
  w: WEEK, sem: WEEK, semaine: WEEK, semaines: WEEK,
};

/**
 * « 30s », « 10m », « 2h », « 1j », « 1sem », « 1h30 », « 1h 30min », « 45 » (minutes).
 * Renvoie des millisecondes, ou null si l'entrée est invalide ou nulle.
 */
export function parseDuration(input: string): number | null {
  // Les espaces sont tolérés entre les éléments mais jamais supprimés : « 30 1h » ne doit pas devenir « 301h ».
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return checked(Number(s) * MINUTE);

  const token = /\s*(\d+)\s*([a-z]*)\s*/y;
  let total = 0;
  let previousUnit: number | null = null;
  let pos = 0;
  while (pos < s.length) {
    token.lastIndex = pos;
    const m = token.exec(s);
    if (!m) return null;
    pos = token.lastIndex;
    const n = Number(m[1]);
    let unit: number | undefined;
    if (m[2]) {
      unit = UNITS[m[2]];
      if (unit === undefined) return null;
    } else {
      // Nombre nu en fin d'expression après des heures : « 1h30 » = 1 h 30 min.
      if (previousUnit !== HOUR || pos !== s.length) return null;
      unit = MINUTE;
    }
    total += n * unit;
    previousUnit = unit;
  }
  return checked(total);
}

function checked(ms: number): number | null {
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

/** 5_400_000 -> « 1 h 30 min ». */
export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(ms / SECOND)) * SECOND;
  for (const [size, label] of [
    [DAY, 'j'],
    [HOUR, 'h'],
    [MINUTE, 'min'],
    [SECOND, 's'],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n} ${label}`);
    rest -= n * size;
  }
  return parts.length ? parts.join(' ') : '0 s';
}
