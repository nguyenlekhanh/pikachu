import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardFingerprint,
  clearDownTo,
  createGrid,
  findMove,
  generateBoard,
  hasValidMove,
  labelOf,
  makeRng,
  parseCoordinate,
  remainingTiles,
  removePair,
  shuffleRemaining,
  tileCount,
  occupiedCells,
} from '../server/game-engine/board.js';
import { levelConfig, baseLevelConfig, normalizeBoardSize } from '../server/game-engine/levels.js';

test('parseCoordinate understands A1, a1, and rejects junk', () => {
  assert.deepEqual(
    { x: parseCoordinate('A1', 6, 6).x, y: parseCoordinate('A1', 6, 6).y },
    { x: 0, y: 0 }
  );
  assert.equal(parseCoordinate('c4', 6, 6).label, 'C4');
  assert.equal(parseCoordinate('Z9', 6, 6), null);
  assert.equal(parseCoordinate('A0', 6, 6), null);
  assert.equal(parseCoordinate('A7', 6, 6), null);
  assert.equal(parseCoordinate('hello', 6, 6), null);
  assert.equal(labelOf(0, 0), 'A1');
  assert.equal(labelOf(5, 5), 'F6');
});

test('generated boards have an even tile count per type and always have a move', () => {
  const rng = makeRng(1234);
  for (let i = 0; i < 60; i += 1) {
    const board = generateBoard({ cols: 6, rows: 6, types: 6, rng });
    assert.equal(remainingTiles(board), 36);
    assert.ok(hasValidMove(board), 'generated board must have a legal move');

    const counts = new Map();
    for (const cell of occupiedCells(board)) {
      counts.set(cell.type, (counts.get(cell.type) || 0) + 1);
    }
    for (const [, count] of counts) assert.equal(count % 2, 0, 'every tile type must appear an even number of times');
  }
});

test('odd sized boards are rejected', () => {
  assert.throws(() => generateBoard({ cols: 5, rows: 5, types: 5, rng: Math.random }), /even number/);
});

test('shuffle preserves count and tile multiset and keeps the board playable', () => {
  const rng = makeRng(99);
  const board = generateBoard({ cols: 6, rows: 6, types: 8, rng });
  const before = occupiedCells(board).map((cell) => cell.type).sort((a, b) => a - b);
  const beforeFingerprint = boardFingerprint(board);

  shuffleRemaining(board, rng);

  const after = occupiedCells(board).map((cell) => cell.type).sort((a, b) => a - b);
  assert.deepEqual(after, before);
  assert.equal(remainingTiles(board), 36);
  assert.ok(hasValidMove(board));
  assert.notEqual(boardFingerprint(board), beforeFingerprint, 'shuffle should change the layout');
});

test('a cleared board has no moves and zero tiles', () => {
  const board = { cols: 4, rows: 4, grid: createGrid(4, 4) };
  assert.equal(remainingTiles(board), 0);
  assert.equal(findMove(board), null);
  assert.equal(hasValidMove(board), false);
});

test('removePair decreases the count by two', () => {
  const rng = makeRng(7);
  const board = generateBoard({ cols: 4, rows: 4, types: 4, rng });
  const move = findMove(board);
  assert.ok(move);
  const before = tileCount(board, move.a.type);
  removePair(board, move.a, move.b);
  assert.equal(remainingTiles(board), 14);
  assert.equal(tileCount(board, move.a.type), before - 2);
});

test('clearDownTo removes legal pairs until the target is reached', () => {
  const rng = makeRng(2024);
  const board = generateBoard({ cols: 6, rows: 6, types: 6, rng });
  const removed = clearDownTo(board, 18, rng);
  assert.ok(removed.length > 0);
  assert.ok(remainingTiles(board) <= 18);
  for (const pair of removed) {
    assert.notEqual(pair.a.type, undefined);
    assert.ok(pair.path.length >= 2);
  }
});

test('levels scale gently and respect admin overrides', () => {
  assert.deepEqual(baseLevelConfig(1), { cols: 6, rows: 6, types: 6 });
  const level3 = baseLevelConfig(3);
  assert.equal(level3.cols, 6);
  assert.equal(level3.rows, 8);
  assert.ok(level3.types > baseLevelConfig(1).types);

  const fixed = levelConfig(5, { boardSizeMode: 'fixed', cols: 10, rows: 4, difficulty: 'normal' });
  assert.equal(fixed.cols, 10);
  assert.equal(fixed.rows, 4);

  const odd = normalizeBoardSize(5, 5);
  assert.equal((odd.cols * odd.rows) % 2, 0);

  const easy = levelConfig(9, { difficulty: 'easy' });
  const hard = levelConfig(9, { difficulty: 'hard' });
  assert.ok(easy.types < hard.types);
});
