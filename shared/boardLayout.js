/**
 * Board geometry shared by the renderer and the tests.
 *
 * The board keeps one empty "routing ring" cell around the tiles: connection
 * paths are allowed to go around the outside, and those ring cells are also
 * where the coordinate labels live. Everything is derived from the canvas size
 * and the board dimensions, so a 6x6, 6x8, 8x8 or 10x10 board all line up.
 *
 * Column letters and row numbers use the exact same convention as the server's
 * coordinate parser (A1 = first column, first row; up to column J on a 10-wide
 * board). Nothing here invents a second coordinate system.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const MIN_CELL = 40;
export const TILE_SCALE = 0.86;

/** A, B, ... for a 1-based column index. */
export function columnLetter(col) {
  return LETTERS[col - 1] || '';
}

/** Visible width/height of a label chip, relative to the cell. */
export const LABEL_CHIP = 0.62;
export const LABEL_FONT = 0.4;

/**
 * @param {{ width:number, height:number, cols:number, rows:number }} options
 */
export function computeBoardLayout({ width, height, cols, rows }) {
  const totalCols = cols + 2;
  const totalRows = rows + 2;
  const cell = Math.min(width / totalCols, height / totalRows);

  const originX = (width - totalCols * cell) / 2;
  const originY = (height - totalRows * cell) / 2;

  const left = originX + cell;
  const top = originY + cell;
  const boardWidth = cols * cell;
  const boardHeight = rows * cell;

  const tileCenter = (col, row) => ({
    x: left + (col - 0.5) * cell,
    y: top + (row - 0.5) * cell,
  });

  const columns = Array.from({ length: cols }, (_, index) => {
    const col = index + 1;
    return {
      text: columnLetter(col),
      col,
      x: left + (col - 0.5) * cell,
      y: top - cell / 2,
    };
  });

  const rowLabels = Array.from({ length: rows }, (_, index) => {
    const row = index + 1;
    return {
      text: String(row),
      row,
      x: left - cell / 2,
      y: top + (row - 0.5) * cell,
    };
  });

  return {
    width,
    height,
    cols,
    rows,
    cell,
    originX,
    originY,
    board: {
      left,
      top,
      right: left + boardWidth,
      bottom: top + boardHeight,
      width: boardWidth,
      height: boardHeight,
    },
    tileSize: cell * TILE_SCALE,
    tileCenter,
    columns,
    rowLabels,
  };
}

/**
 * Label boxes with the geometry the renderer draws (a rounded chip around each
 * letter/number). Tests use this to prove labels sit outside the tiles and stay
 * inside the canvas for every supported board size.
 */
export function labelBoxes(layout) {
  const size = layout.cell * LABEL_CHIP;
  const box = (entry, kind) => ({
    kind,
    text: entry.text,
    col: entry.col,
    row: entry.row,
    x: entry.x,
    y: entry.y,
    width: size,
    height: size,
    left: entry.x - size / 2,
    right: entry.x + size / 2,
    top: entry.y - size / 2,
    bottom: entry.y + size / 2,
  });

  return {
    columns: layout.columns.map((entry) => box(entry, 'column')),
    rows: layout.rowLabels.map((entry) => box(entry, 'row')),
  };
}

/** Font size for coordinate labels, kept readable on a phone-sized stream. */
export function labelFontSize(layout) {
  return Math.round(Math.max(18, Math.min(46, layout.cell * LABEL_FONT)));
}
