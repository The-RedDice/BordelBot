/** Calculs de dates dans un fuseau horaire (tirages hebdomadaires, saisons mensuelles…). */

export const PARIS = 'Europe/Paris';

export interface ZonedParts {
  readonly year: number;
  /** 1 à 12. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = dimanche … 6 = samedi. */
  readonly weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(at: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/**
 * Instant (ms) correspondant à une heure locale. Les débordements sont permis
 * (jour 32 = 1er du mois suivant). Lors d'un changement d'heure, une heure qui
 * n'existe pas est décalée d'une heure.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wanted = Date.UTC(year, month - 1, day, hour);
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(t, timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    t += wanted - shown;
  }
  return t;
}

/** Prochaine occurrence (strictement après `at`) d'un jour de la semaine à une heure locale. */
export function nextWeekly(at: number, weekday: number, hour: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  let days = (weekday - p.weekday + 7) % 7;
  let t = zonedTime(p.year, p.month, p.day + days, hour, timeZone);
  if (t <= at) {
    days += 7;
    t = zonedTime(p.year, p.month, p.day + days, hour, timeZone);
  }
  return t;
}

/** Identifiant du mois local : « 2026-11 ». */
export function monthId(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** Début (inclus) et fin (exclue) d'un mois local. */
export function monthRange(id: string, timeZone: string): { readonly start: number; readonly end: number } {
  const [y, m] = id.split('-').map(Number) as [number, number];
  return { start: zonedTime(y, m, 1, 0, timeZone), end: zonedTime(y, m + 1, 1, 0, timeZone) };
}

/** Mois précédent : « 2026-01 » → « 2025-12 ». */
export function previousMonthId(id: string): string {
  const [y, m] = id.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const MONTH_NAMES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « 2026-11 » → « novembre 2026 ». */
export function monthLabel(id: string): string {
  const [y, m] = id.split('-').map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1] ?? '?'} ${y}`;
}
