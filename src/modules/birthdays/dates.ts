export const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

/** Jours par mois, 29 février compris (on fête alors le 28 les années non bissextiles). */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isValidBirthday(month: number, day: number): boolean {
  return Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;
}

export const formatBirthday = (month: number, day: number): string => `${day === 1 ? '1er' : day} ${MONTHS[month - 1]}`;

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Date et heure locales dans un fuseau donné. */
export interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  /** AAAA-MM-JJ */
  readonly date: string;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localTime(at: number, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, hour: get('hour'), date };
}

/** Jour où l'on fête un anniversaire une année donnée : le 29 février devient le 28 hors années bissextiles. */
export function celebrationDay(month: number, day: number, year: number): { month: number; day: number } {
  return month === 2 && day === 29 && !isLeapYear(year) ? { month: 2, day: 28 } : { month, day };
}

/** Vrai si un anniversaire (mois, jour) se fête à cette date locale. */
export function isCelebratedOn(month: number, day: number, today: LocalTime): boolean {
  const c = celebrationDay(month, day, today.year);
  return c.month === today.month && c.day === today.day;
}

const DAY_MS = 86_400_000;

/** Jours avant le prochain anniversaire (0 = aujourd'hui). */
export function daysUntil(month: number, day: number, today: LocalTime): number {
  const start = Date.UTC(today.year, today.month - 1, today.day);
  for (const year of [today.year, today.year + 1, today.year + 2]) {
    const c = celebrationDay(month, day, year);
    const at = Date.UTC(year, c.month - 1, c.day);
    if (at >= start) return Math.round((at - start) / DAY_MS);
  }
  return 366;
}

/** Début de l'heure suivante, plus une marge de quelques secondes. */
export function nextHour(at: number, marginMs = 5_000): number {
  return (Math.floor(at / 3_600_000) + 1) * 3_600_000 + marginMs;
}
