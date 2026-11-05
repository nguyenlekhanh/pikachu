import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrid } from '../server/game-engine/board.js';
import { findPath, clearRow, clearCol } from '../server/game-engine/matching.js';

/** Build a padded grid from a compact playable map. */
function gridFrom(rowsOfTypes, cols, rows) {
  const grid = createGrid(cols, rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const value = rowsOfTypes[r][c];
      grid[r + 1][c + 1] = value === '.' ? null : value;
    }
  }
  return grid;
}

function turnCount(points) {
  let turns = 0;
  let prev = null;
  for (let i = 1; i < points.length; i += 1) {
    const dc = Math.sign(points[i].c - points[i - 1].c);
    const dr = Math.sign(points[i].r - points[i - 1].r);
    if (prev && (prev.dc !== dc || prev.dr !== dr)) turns += 1;
    prev = { dc, dr };
  }
  return turns;
}

test('adjacent identical tiles connect with zero turns', () => {
  const grid = gridFrom(['AA...', '.....', '.....', '.....', '.....'], 5, 5);
  const path = findPath(grid, { c: 1, r: 1 }, { c: 2, r: 1 });
  assert.ok(path);
  assert.equal(path.turns, 0);
  assert.equal(path.points.length, 2);
});

test('different tiles never match even with a clear line', () => {
  const grid = gridFrom(['AB...', '.....', '.....', '.....', '.....'], 5, 5);
  assert.equal(findPath(grid, { c: 1, r: 1 }, { c: 2, r: 1 }), null);
});

test('identical tiles blocked by another tile on the same row cannot connect directly', () => {
  const grid = gridFrom(['AXA..', '.....', '.....', '.....', '.....'], 5, 5);
  const path = findPath(grid, { c: 1, r: 1 }, { c: 3, r: 1 });
  // The board is open above, so a two turn path around the blocker is legal.
  assert.ok(path);
  assert.equal(path.turns, 2);
  assert.ok(path.points.some((point) => point.r === 0), 'path should route through the padding ring');
});

test('an enclosed tile cannot connect to the outside', () => {
  const grid = gridFrom(
    ['....A', '.XXX.', '.XAX.', '.XXX.', '.....'],
    5,
    5
  );
  // The center A is walled in by tiles on all eight sides.
  const path = findPath(grid, { c: 3, r: 3 }, { c: 5, r: 1 });
  assert.equal(path, null);
});

test('one turn elbow is found when the corner is free', () => {
  const grid = gridFrom(['A....', '.....', '..A..', '.....', '.....'], 5, 5);
  const path = findPath(grid, { c: 1, r: 1 }, { c: 3, r: 3 });
  assert.ok(path);
  assert.equal(path.turns, 1);
});

test('two turns are allowed', () => {
  const grid = gridFrom(['A....', 'XXXX.', '.....', '....A', '.....'], 5, 5);
  const path = findPath(grid, { c: 1, r: 1 }, { c: 5, r: 4 });
  assert.ok(path);
  assert.ok(path.turns <= 2);
});

test('a configuration that only allows three or more turns is rejected', () => {
  const grid = createGrid(4, 4);
  // A(2,2) and A(3,3) diagonal, with B at the two elbows and the mid lines
  // blocked: no straight, elbow or two-turn path can exist.
  grid[2][2] = 0;
  grid[3][2] = 1;
  grid[3][3] = 0;
  grid[2][3] = 1;
  const path = findPath(grid, { c: 2, r: 2 }, { c: 3, r: 3 });
  assert.equal(path, null);
});

test('paths returned never exceed two turns', () => {
  for (let i = 0; i < 300; i += 1) {
    const cols = 6;
    const rows = 6;
    const grid = createGrid(cols, rows);
    for (let r = 1; r <= rows; r += 1) {
      for (let c = 1; c <= cols; c += 1) {
        grid[r][c] = Math.floor(Math.random() * 4);
      }
    }
    for (let r = 1; r <= rows; r += 1) {
      for (let c = 1; c <= cols; c += 1) {
        for (let r2 = r; r2 <= rows; r2 += 1) {
          for (let c2 = 1; c2 <= cols; c2 += 1) {
            if (r === r2 && c === c2) continue;
            const path = findPath(grid, { c, r }, { c: c2, r: r2 });
            if (path) assert.ok(turnCount(path.points) <= 2, 'path exceeded two turns');
          }
        }
      }
    }
  }
});

test('clearRow and clearCol ignore the endpoints', () => {
  const grid = gridFrom(['A.A..', '.....', '.....', '.....', '.....'], 5, 5);
  assert.equal(clearRow(grid, 1, 1, 3), true);
  grid[1][2] = 5;
  assert.equal(clearRow(grid, 1, 1, 3), false);

  const grid2 = gridFrom(['A....', '.....', 'A....', '.....', '.....'], 5, 5);
  assert.equal(clearCol(grid2, 1, 1, 3), true);
  grid2[2][1] = 5;
  assert.equal(clearCol(grid2, 1, 1, 3), false);
});
