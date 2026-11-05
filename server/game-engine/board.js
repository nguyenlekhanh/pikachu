/**
 * Board model, generation, shuffling and move discovery.
 *
 * A board is { cols, rows, grid } where grid is (rows + 2) x (cols + 2) and the
 * outer ring is always empty. Cells hold a numeric tile type id, or null.
 */

import { findPath, isEmpty } from './matching.js';

export function createGrid(cols, rows) {
  return Array.from({ length: rows + 2 }, () => new Array(cols + 2).fill(null));
}

export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleArray(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export function labelOf(x, y) {
  return `${String.fromCharCode(65 + x)}${y + 1}`;
}

export function paddedOf(x, y) {
  return { c: x + 1, r: y + 1 };
}

export function playableOf(c, r) {
  return { x: c - 1, y: r - 1 };
}

/** Parse "A1" into playable coordinates. Returns null when out of range. */
export function parseCoordinate(text, cols, rows) {
  if (typeof text !== 'string') return null;
  const match = /^\s*([A-Za-z])\s*(\d{1,2})\s*$/.exec(text);
  if (!match) return null;
  const x = match[1].toUpperCase().charCodeAt(0) - 65;
  const y = Number(match[2]) - 1;
  if (x < 0 || x >= cols || y < 0 || y >= rows) return null;
  return { x, y, c: x + 1, r: y + 1, label: labelOf(x, y) };
}

export function tileCount(board, type) {
  let count = 0;
  for (let r = 1; r <= board.rows; r += 1) {
    for (let c = 1; c <= board.cols; c += 1) {
      if (board.grid[r][c] !== null && (type === undefined || board.grid[r][c] === type)) count += 1;
    }
  }
  return count;
}

export function remainingTiles(board) {
  return tileCount(board);
}

export function isBoardCleared(board) {
  return remainingTiles(board) === 0;
}

export function occupiedCells(board) {
  const cells = [];
  for (let r = 1; r <= board.rows; r += 1) {
    for (let c = 1; c <= board.cols; c += 1) {
      if (board.grid[r][c] !== null) cells.push({ c, r, type: board.grid[r][c] });
    }
  }
  return cells;
}

export function cellsByType(board) {
  const map = new Map();
  for (const cell of occupiedCells(board)) {
    if (!map.has(cell.type)) map.set(cell.type, []);
    map.get(cell.type).push(cell);
  }
  return map;
}

/**
 * Generate a solvable-ready board: every tile type has an even count and the
 * finished layout already contains at least one legal move.
 */
export function generateBoard({ cols, rows, types, rng = Math.random }) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 4 || rows < 4) {
    throw new Error('Board must be at least 4x4');
  }
  if ((cols * rows) % 2 !== 0) throw new Error('Board must contain an even number of cells');

  const total = cols * rows;
  const pairCount = total / 2;
  const typeIds = Math.max(3, Math.min(types, Math.floor(pairCount / 2) || 3));

  let grid = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const pool = [];
    for (let i = 0; i < pairCount; i += 1) {
      const type = i % typeIds;
      pool.push(type, type);
    }
    shuffleArray(pool, rng);
    grid = createGrid(cols, rows);
    let index = 0;
    for (let r = 1; r <= rows; r += 1) {
      for (let c = 1; c <= cols; c += 1) {
        grid[r][c] = pool[index];
        index += 1;
      }
    }
    const board = { cols, rows, grid };
    if (findMove(board)) return board;
  }
  return { cols, rows, grid };
}

/** Return the first legal move on the board, or null. */
export function findMove(board) {
  const groups = cellsByType(board);
  for (const cells of groups.values()) {
    if (cells.length < 2) continue;
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const path = findPath(board.grid, cells[i], cells[j]);
        if (path) return { a: cells[i], b: cells[j], path: path.points, turns: path.turns };
      }
    }
  }
  return null;
}

export function listMoves(board, limit = 12) {
  const moves = [];
  const groups = cellsByType(board);
  for (const cells of groups.values()) {
    if (cells.length < 2) continue;
    for (let i = 0; i < cells.length && moves.length < limit; i += 1) {
      for (let j = i + 1; j < cells.length && moves.length < limit; j += 1) {
        const path = findPath(board.grid, cells[i], cells[j]);
        if (path) moves.push({ a: cells[i], b: cells[j], path: path.points, turns: path.turns });
      }
    }
  }
  return moves;
}

export function hasValidMove(board) {
  return findMove(board) !== null;
}

export function removePair(board, a, b) {
  board.grid[a.r][a.c] = null;
  board.grid[b.r][b.c] = null;
}

export function removeAll(board) {
  const removed = occupiedCells(board);
  for (const cell of removed) board.grid[cell.r][cell.c] = null;
  return removed;
}

export function setTile(board, c, r, type) {
  if (r < 1 || c < 1 || r > board.rows || c > board.cols) return false;
  board.grid[r][c] = type;
  return true;
}

/**
 * Shuffle the remaining tiles among their current cells. Keeps the tile count
 * and the exact multiset of tile types. Repeats until a legal move exists.
 */
export function shuffleRemaining(board, rng = Math.random) {
  const cells = occupiedCells(board);
  if (cells.length === 0) return { board, moves: 0, shuffled: false };
  const types = cells.map((cell) => cell.type);

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const pool = shuffleArray([...types], rng);
    cells.forEach((cell, index) => {
      board.grid[cell.r][cell.c] = pool[index];
    });
    const move = findMove(board);
    if (move) return { board, moves: 1, shuffled: true, move };
  }

  // Extremely unlikely: fall back to a guaranteed-playable pair.
  if (cells.length >= 2) {
    board.grid[cells[0].r][cells[0].c] = types[0];
    board.grid[cells[1].r][cells[1].c] = types[0];
  }
  return { board, moves: 1, shuffled: true, forced: true };
}

/**
 * Remove legal pairs until only `targetRemaining` tiles are left (or no more
 * pairs exist). Used by the medium gift tier. Returns the removed pairs.
 */
export function clearDownTo(board, targetRemaining, rng = Math.random) {
  const removed = [];
  let guard = 0;
  while (remainingTiles(board) > targetRemaining && guard < 500) {
    guard += 1;
    const move = findMove(board);
    if (!move) {
      if (remainingTiles(board) >= 2) {
        shuffleRemaining(board, rng);
        continue;
      }
      break;
    }
    removePair(board, move.a, move.b);
    removed.push(move);
  }
  return removed;
}

export function cloneBoard(board) {
  return {
    cols: board.cols,
    rows: board.rows,
    grid: board.grid.map((row) => [...row]),
  };
}

export function boardFingerprint(board) {
  return board.grid.map((row) => row.map((cell) => (cell === null ? '.' : cell)).join(',')).join('|');
}
