/** Jeux d'alignement à deux joueurs : morpion et puissance 4. */

export type BoardGame = 'morpion' | 'puissance4';

export interface BoardSpec {
  readonly cols: number;
  readonly rows: number;
  /** Nombre de pions à aligner. */
  readonly connect: number;
  /** Les pions tombent en bas de la colonne (puissance 4). */
  readonly gravity: boolean;
}

export const BOARD_SPECS: Record<BoardGame, BoardSpec> = {
  morpion: { cols: 3, rows: 3, connect: 3, gravity: false },
  puissance4: { cols: 7, rows: 6, connect: 4, gravity: true },
};

/** 0 = case vide ; 1 et 2 = joueurs. */
export type Mark = 0 | 1 | 2;

export interface BoardState {
  readonly game: BoardGame;
  /** Ligne par ligne, de haut en bas. */
  readonly cells: readonly Mark[];
  /** Joueur dont c'est le tour. */
  readonly turn: 1 | 2;
  readonly winner: 0 | 1 | 2;
  readonly draw: boolean;
  /** Cases de l'alignement gagnant. */
  readonly line: readonly number[];
}

export function newBoard(game: BoardGame): BoardState {
  const { cols, rows } = BOARD_SPECS[game];
  return { game, cells: Array<Mark>(cols * rows).fill(0), turn: 1, winner: 0, draw: false, line: [] };
}

export const isOver = (s: BoardState): boolean => s.winner !== 0 || s.draw;

export type MoveResult = { readonly ok: true; readonly state: BoardState } | { readonly ok: false; readonly reason: string };

/**
 * Joue un coup : l'indice d'une case (morpion) ou d'une colonne (puissance 4).
 */
export function play(state: BoardState, move: number): MoveResult {
  if (isOver(state)) return { ok: false, reason: 'La partie est terminée.' };
  const spec = BOARD_SPECS[state.game];
  let index: number;
  if (spec.gravity) {
    if (!Number.isInteger(move) || move < 0 || move >= spec.cols) return { ok: false, reason: 'Colonne invalide.' };
    index = -1;
    for (let row = spec.rows - 1; row >= 0; row--) {
      if (state.cells[row * spec.cols + move] === 0) {
        index = row * spec.cols + move;
        break;
      }
    }
    if (index < 0) return { ok: false, reason: 'Cette colonne est pleine.' };
  } else {
    if (!Number.isInteger(move) || move < 0 || move >= state.cells.length) return { ok: false, reason: 'Case invalide.' };
    if (state.cells[move] !== 0) return { ok: false, reason: 'Cette case est déjà prise.' };
    index = move;
  }

  const cells = [...state.cells];
  cells[index] = state.turn;
  const line = winningLine(cells, spec, index);
  if (line) return { ok: true, state: { ...state, cells, winner: state.turn, line } };
  if (cells.every((c) => c !== 0)) return { ok: true, state: { ...state, cells, draw: true } };
  return { ok: true, state: { ...state, cells, turn: state.turn === 1 ? 2 : 1 } };
}

/** Coups encore jouables (cases vides ou colonnes non pleines). */
export function legalMoves(state: BoardState): number[] {
  if (isOver(state)) return [];
  const spec = BOARD_SPECS[state.game];
  if (spec.gravity) return [...Array(spec.cols).keys()].filter((c) => state.cells[c] === 0);
  return state.cells.flatMap((c, i) => (c === 0 ? [i] : []));
}

const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

/** Alignement passant par la case jouée, ou null. */
function winningLine(cells: readonly Mark[], spec: BoardSpec, index: number): number[] | null {
  const mark = cells[index];
  if (!mark) return null;
  const row = Math.floor(index / spec.cols);
  const col = index % spec.cols;
  const at = (r: number, c: number) => (r >= 0 && r < spec.rows && c >= 0 && c < spec.cols ? cells[r * spec.cols + c] : 0);
  for (const [dr, dc] of DIRECTIONS) {
    const line = [index];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (at(r, c) === mark) {
        line.push(r * spec.cols + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= spec.connect) return line.sort((a, b) => a - b);
  }
  return null;
}
