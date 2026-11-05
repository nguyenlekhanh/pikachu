/**
 * Level scaling. Difficulty rises through tile variety and board size, but V1
 * deliberately stays casual: no timers, no dead boards, no punishing spikes.
 */

const LEVEL_TABLE = [
  { level: 1, cols: 6, rows: 6, types: 6 },
  { level: 2, cols: 6, rows: 6, types: 7 },
  { level: 3, cols: 6, rows: 8, types: 8 },
  { level: 4, cols: 6, rows: 8, types: 9 },
  { level: 5, cols: 8, rows: 8, types: 9 },
  { level: 6, cols: 8, rows: 8, types: 10 },
];

const MAX_TYPES = 15;

export function baseLevelConfig(level) {
  const safeLevel = Math.max(1, Math.floor(level));
  const entry = LEVEL_TABLE[Math.min(safeLevel, LEVEL_TABLE.length) - 1];
  const extra = Math.max(0, safeLevel - LEVEL_TABLE.length);
  return {
    cols: entry.cols,
    rows: entry.rows,
    types: Math.min(MAX_TYPES, entry.types + Math.floor(extra / 2)),
  };
}

export function difficultyTypes(types, difficulty) {
  if (difficulty === 'easy') return Math.max(4, types - 2);
  if (difficulty === 'hard') return Math.min(MAX_TYPES, types + 2);
  return types;
}

export function normalizeBoardSize(cols, rows) {
  const clamp = (value) => Math.min(10, Math.max(4, Math.floor(Number(value) || 6)));
  let c = clamp(cols);
  let r = clamp(rows);
  if ((c * r) % 2 !== 0) r = r >= 4 && r < 10 ? r + 1 : r - 1;
  return { cols: c, rows: r };
}

/**
 * Resolve the board shape and tile variety for a level, honouring the admin
 * overrides without allowing an impossible board.
 */
export function levelConfig(level, settings = {}) {
  const base = baseLevelConfig(level);
  let cols = base.cols;
  let rows = base.rows;

  if (settings.boardSizeMode === 'fixed') {
    const size = normalizeBoardSize(settings.cols, settings.rows);
    cols = size.cols;
    rows = size.rows;
  }

  let types = difficultyTypes(base.types, settings.difficulty);
  if (Number(settings.tileTypes) > 0) types = Math.min(MAX_TYPES, Number(settings.tileTypes));

  // Never ask for more types than the board can hold two of.
  const maxUseful = Math.floor((cols * rows) / 4);
  types = Math.max(3, Math.min(types, Math.max(3, maxUseful), MAX_TYPES));

  return { cols, rows, types };
}
