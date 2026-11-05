import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBoardLayout,
  labelBoxes,
  labelFontSize,
  columnLetter,
} from '../shared/boardLayout.js';
import { labelOf, parseCoordinate } from '../server/game-engine/board.js';

const SIZES = [
  { cols: 6, rows: 6 },
  { cols: 6, rows: 8 },
  { cols: 8, rows: 8 },
  { cols: 10, rows: 8 },
  { cols: 10, rows: 10 },
];

const overlaps = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

for (const { cols, rows } of SIZES) {
  test(`${cols}x${rows}: every column letter sits exactly above its column`, () => {
    const layout = computeBoardLayout({ width: 940, height: 860, cols, rows });
    const boxes = labelBoxes(layout);

    assert.equal(layout.columns.length, cols);
    assert.deepEqual(
      layout.columns.map((label) => label.text),
      Array.from({ length: cols }, (_, index) => columnLetter(index + 1))
    );

    for (const box of boxes.columns) {
      const tile = layout.tileCenter(box.col, 1);
      assert.ok(Math.abs(box.x - tile.x) < 1e-9, `letter ${box.text} must be centered on column ${box.col}`);
      assert.ok(box.bottom <= layout.board.top + 1e-9, `letter ${box.text} must stay above the tiles`);
    }
  });

  test(`${cols}x${rows}: every row number sits exactly left of its row`, () => {
    const layout = computeBoardLayout({ width: 940, height: 860, cols, rows });
    const boxes = labelBoxes(layout);

    assert.equal(layout.rows, rows);
    assert.equal(layout.rowLabels.length, rows);
    assert.deepEqual(
      layout.rowLabels.map((label) => label.text),
      Array.from({ length: rows }, (_, index) => String(index + 1))
    );

    for (const box of boxes.rows) {
      const tile = layout.tileCenter(1, box.row);
      assert.ok(Math.abs(box.y - tile.y) < 1e-9, `number ${box.text} must be centered on row ${box.row}`);
      assert.ok(box.right <= layout.board.left + 1e-9, `number ${box.text} must stay left of the tiles`);
    }
  });

  test(`${cols}x${rows}: labels never overlap a tile and stay on canvas`, () => {
    const layout = computeBoardLayout({ width: 940, height: 860, cols, rows });
    const boxes = labelBoxes(layout);

    const tiles = [];
    for (let row = 1; row <= rows; row += 1) {
      for (let col = 1; col <= cols; col += 1) {
        const center = layout.tileCenter(col, row);
        const half = layout.tileSize / 2;
        tiles.push({
          left: center.x - half,
          right: center.x + half,
          top: center.y - half,
          bottom: center.y + half,
        });
      }
    }

    for (const box of [...boxes.columns, ...boxes.rows]) {
      for (const tile of tiles) {
        assert.equal(overlaps(box, tile), false, `label ${box.text} overlaps a tile`);
      }
      assert.ok(box.left >= 0 && box.top >= 0, `label ${box.text} is off the left/top edge`);
      assert.ok(box.right <= 940 && box.bottom <= 860, `label ${box.text} is off the right/bottom edge`);
    }

    assert.ok(labelFontSize(layout) >= 18, 'labels must stay readable');
  });
}

test('coordinate labels match the backend parser exactly', () => {
  for (const { cols, rows } of SIZES) {
    const layout = computeBoardLayout({ width: 940, height: 860, cols, rows });
    for (const column of layout.columns) {
      for (const row of layout.rowLabels) {
        const label = `${column.text}${row.text}`;
        const parsed = parseCoordinate(label, cols, rows);
        assert.ok(parsed, `${label} must parse on a ${cols}x${rows} board`);
        assert.equal(labelOf(parsed.x, parsed.y), label);
        // The drawn label must point at the same column/row the engine uses.
        assert.equal(parsed.x + 1, column.col);
        assert.equal(parsed.y + 1, row.row);
      }
    }
  }
});

test('A1 B1 resolves to the tiles under the first drawn labels', () => {
  const layout = computeBoardLayout({ width: 940, height: 860, cols: 6, rows: 6 });
  const a1 = parseCoordinate('A1', 6, 6);
  const b1 = parseCoordinate('B1', 6, 6);
  assert.deepEqual(layout.tileCenter(a1.x + 1, a1.y + 1), {
    x: layout.board.left + layout.cell / 2,
    y: layout.board.top + layout.cell / 2,
  });
  assert.equal(layout.tileCenter(b1.x + 1, b1.y + 1).x - layout.tileCenter(a1.x + 1, a1.y + 1).x, layout.cell);
});

test('the board stays centered on the canvas at every size', () => {
  for (const { cols, rows } of SIZES) {
    const layout = computeBoardLayout({ width: 940, height: 860, cols, rows });
    const centerX = layout.board.left + layout.board.width / 2;
    const centerY = layout.board.top + layout.board.height / 2;
    // Column labels/gutters are symmetric, so the tile block is canvas-centered.
    assert.ok(Math.abs(centerX - 940 / 2) < 1e-9);
    assert.ok(Math.abs(centerY - 860 / 2) < 1e-9);
  }
});
