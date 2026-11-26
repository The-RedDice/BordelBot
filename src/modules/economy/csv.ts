import type { ExportRow } from './EconomyService.js';

const HEADER = ['id', 'date', 'membre', 'type', 'montant', 'solde_apres', 'contrepartie', 'reference', 'note'];

/** Échappement RFC 4180, et neutralisation des formules (=, +, -, @) à l'ouverture dans un tableur. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Journal économique au format CSV (UTF-8 avec BOM pour qu'Excel lise les accents).
 * Les identifiants Discord dépassent la précision d'un nombre de tableur : les importer
 * en colonne « texte » pour qu'ils ne soient pas arrondis.
 */
export function transactionsCsv(rows: readonly ExportRow[]): string {
  const lines = [HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        new Date(r.createdAt).toISOString(),
        r.userId,
        r.kind,
        r.amount,
        r.balanceAfter,
        r.counterpartyId,
        r.reference,
        r.note,
      ]
        .map((v) => csvCell(typeof v === 'number' ? v : (v ?? null)))
        .join(','),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
