import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import { existsSync } from 'node:fs';
import type { PricePoint } from './MarketService.js';

const WIDTH = 900;
const HEIGHT = 420;
const PAD = { top: 24, right: 92, bottom: 40, left: 20 };
const UP = '#3ba55d';
const DOWN = '#ed4245';
const GRID = '#3f4248';
const TEXT = '#b5bac1';
const BG = '#2b2d31';
/** Familles essayées dans l'ordre : Linux (paquet fonts-dejavu-core), puis Windows/macOS. */
const FONT = "'DejaVu Sans', 'Liberation Sans', Arial, Helvetica, sans-serif";
/** Heure affichée sur l'axe : celle des joueurs, pas celle du serveur (souvent en UTC). */
const TIME_ZONE = 'Europe/Paris';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatPrice(price: number): string {
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price);
}

function timeLabel(at: number, spanMs: number): string {
  const options: Intl.DateTimeFormatOptions =
    spanMs > 2 * 86_400_000
      ? { day: '2-digit', month: '2-digit', timeZone: TIME_ZONE }
      : { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE };
  return new Intl.DateTimeFormat('fr-FR', options).format(at);
}

/**
 * Graphique des cours en SVG : courbe, aire dégradée, grille, prix de début en
 * pointillés, axes. Vert si le cours a monté sur la période, rouge sinon.
 */
export function priceChartSvg(points: readonly PricePoint[]): string {
  if (points.length === 0) throw new Error('Aucun cours à afficher');
  const first = points[0] as PricePoint;
  const last = points[points.length - 1] as PricePoint;
  const color = last.price >= first.price ? UP : DOWN;

  let min = Math.min(...points.map((p) => p.price));
  let max = Math.max(...points.map((p) => p.price));
  if (max - min < max * 0.002) {
    // Cours quasi plat : on ouvre l'échelle pour ne pas amplifier le bruit.
    const mid = (max + min) / 2;
    min = mid * 0.995;
    max = mid * 1.005;
  }
  const margin = (max - min) * 0.08;
  min -= margin;
  max += margin;

  const t0 = first.at;
  const span = Math.max(1, last.at - t0);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (at: number) => PAD.left + ((at - t0) / span) * plotW;
  const y = (price: number) => PAD.top + (1 - (price - min) / (max - min)) * plotH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const bottom = (PAD.top + plotH).toFixed(1);
  const area = `${line} L${x(last.at).toFixed(1)},${bottom} L${x(t0).toFixed(1)},${bottom} Z`;

  const parts: string[] = [];
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const price = min + ((max - min) * i) / gridLines;
    const gy = y(price).toFixed(1);
    parts.push(`<line x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${gy}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(
      `<text x="${WIDTH - PAD.right + 10}" y="${gy}" dy="4" fill="${TEXT}" font-size="13">${esc(formatPrice(price))}</text>`,
    );
  }
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const at = t0 + (span * i) / ticks;
    const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
    parts.push(
      `<text x="${x(at).toFixed(1)}" y="${HEIGHT - 14}" text-anchor="${anchor}" fill="${TEXT}" font-size="13">${esc(timeLabel(at, span))}</text>`,
    );
  }

  const startY = y(first.price).toFixed(1);
  const lastX = x(last.at).toFixed(1);
  const lastY = y(last.price).toFixed(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${FONT}">
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="${BG}" rx="12"/>
  ${parts.join('\n  ')}
  <line x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${startY}" y2="${startY}" stroke="${TEXT}" stroke-opacity="0.5" stroke-dasharray="4 6"/>
  <path d="${area}" fill="url(#fill)"/>
  <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${lastX}" cy="${lastY}" r="5" fill="${color}" stroke="${BG}" stroke-width="2"/>
  <rect x="${WIDTH - PAD.right + 4}" y="${(Number(lastY) - 12).toFixed(1)}" width="${PAD.right - 8}" height="24" rx="4" fill="${color}"/>
  <text x="${WIDTH - PAD.right + 10}" y="${lastY}" dy="5" fill="#ffffff" font-size="13" font-weight="bold">${esc(formatPrice(last.price))}</text>
</svg>`;
}

/** Polices connues (normale + grasse) : les charger directement évite de scanner tout le système. */
const FONT_FILES: readonly (readonly string[])[] = [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf'],
  [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  ],
  ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'],
];

type FontOptions = NonNullable<ResvgRenderOptions['font']>;
let fontOptions: FontOptions | undefined;

function fonts(): FontOptions {
  if (!fontOptions) {
    const files = FONT_FILES.find(([regular]) => regular !== undefined && existsSync(regular))?.filter((f) => existsSync(f));
    // Aucune police connue : scan complet (plus lent) ; sans aucune police, seul le texte manque.
    fontOptions = files?.length ? { loadSystemFonts: false, fontFiles: [...files] } : { loadSystemFonts: true };
  }
  return fontOptions;
}

/** PNG prêt à joindre à un message (Discord n'affiche pas les SVG). */
export function renderPriceChart(points: readonly PricePoint[]): Buffer {
  const resvg = new Resvg(priceChartSvg(points), { font: fonts() });
  return resvg.render().asPng();
}
