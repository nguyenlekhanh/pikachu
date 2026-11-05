/**
 * Pikachu-style connection rules.
 *
 * The board grid is padded by one row/column on every side. Tiles only live in
 * the inner playable area, the padding ring is always empty, and paths are
 * allowed to travel through the padding ring. That is what makes the classic
 * "connect around the outside of the board" behaviour work.
 *
 * A connection may contain at most two turns (i.e. 1, 2 or 3 segments).
 */

export const MAX_TURNS = 2;

export function isInside(grid, c, r) {
  return r >= 0 && c >= 0 && r < grid.length && c < grid[0].length;
}

export function isEmpty(grid, c, r) {
  return isInside(grid, c, r) && grid[r][c] === null;
}

/** All cells strictly between two cells on the same row must be empty. */
export function clearRow(grid, r, c1, c2) {
  const from = Math.min(c1, c2) + 1;
  const to = Math.max(c1, c2);
  for (let c = from; c < to; c += 1) {
    if (grid[r][c] !== null) return false;
  }
  return true;
}

/** All cells strictly between two cells on the same column must be empty. */
export function clearCol(grid, c, r1, r2) {
  const from = Math.min(r1, r2) + 1;
  const to = Math.max(r1, r2);
  for (let r = from; r < to; r += 1) {
    if (grid[r][c] !== null) return false;
  }
  return true;
}

function straight(grid, a, b) {
  if (a.r === b.r && a.c !== b.c) return clearRow(grid, a.r, a.c, b.c);
  if (a.c === b.c && a.r !== b.r) return clearCol(grid, a.c, a.r, b.r);
  return false;
}

function corner(grid, a, b) {
  // Two candidate elbow cells.
  const c1 = { c: b.c, r: a.r };
  const c2 = { c: a.c, r: b.r };
  if (!(c1.c === a.c && c1.r === a.r) && !(c1.c === b.c && c1.r === b.r)) {
    if (isEmpty(grid, c1.c, c1.r) && straight(grid, a, c1) && straight(grid, c1, b)) {
      return [a, c1, b];
    }
  }
  if (!(c2.c === a.c && c2.r === a.r) && !(c2.c === b.c && c2.r === b.r)) {
    if (isEmpty(grid, c2.c, c2.r) && straight(grid, a, c2) && straight(grid, c2, b)) {
      return [a, c2, b];
    }
  }
  return null;
}

function turnCount(points) {
  // Count genuine 90 degree direction changes along the polyline.
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

function simplify(points) {
  // Drop duplicated points (zero-length segments) then merge collinear points.
  const deduped = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (!last || last.c !== p.c || last.r !== p.r) deduped.push(p);
  }
  const merged = [];
  for (const p of deduped) {
    while (merged.length >= 2) {
      const a = merged[merged.length - 2];
      const b = merged[merged.length - 1];
      const collinear =
        (a.c === b.c && b.c === p.c) || (a.r === b.r && b.r === p.r);
      if (!collinear) break;
      merged.pop();
    }
    merged.push(p);
  }
  return merged;
}

/**
 * Find a connection between two occupied cells with at most two turns.
 * @returns {{points: Array<{c:number,r:number}>, turns:number}|null}
 */
export function findPath(grid, a, b) {
  if (!a || !b) return null;
  if (a.c === b.c && a.r === b.r) return null;
  if (!isInside(grid, a.c, a.r) || !isInside(grid, b.c, b.r)) return null;
  if (grid[a.r][a.c] === null || grid[b.r][b.c] === null) return null;
  if (grid[a.r][a.c] !== grid[b.r][b.c]) return null;

  // 0 turns
  if (straight(grid, a, b)) {
    return { points: simplify([a, b]), turns: 0 };
  }

  // 1 turn
  const elbow = corner(grid, a, b);
  if (elbow) return { points: simplify(elbow), turns: 1 };

  // 2 turns: pick a middle line (vertical or horizontal) and cross it.
  const width = grid[0].length;
  const height = grid.length;

  for (let mc = 0; mc < width; mc += 1) {
    if (mc === a.c || mc === b.c) continue;
    const p1 = { c: mc, r: a.r };
    const p2 = { c: mc, r: b.r };
    if (!isEmpty(grid, p1.c, p1.r) || !isEmpty(grid, p2.c, p2.r)) continue;
    if (!clearRow(grid, a.r, a.c, mc)) continue;
    if (!clearCol(grid, mc, a.r, b.r)) continue;
    if (!clearRow(grid, b.r, mc, b.c)) continue;
    const points = simplify([a, p1, p2, b]);
    if (turnCount(points) <= MAX_TURNS) return { points, turns: turnCount(points) };
  }

  for (let mr = 0; mr < height; mr += 1) {
    if (mr === a.r || mr === b.r) continue;
    const p1 = { c: a.c, r: mr };
    const p2 = { c: b.c, r: mr };
    if (!isEmpty(grid, p1.c, p1.r) || !isEmpty(grid, p2.c, p2.r)) continue;
    if (!clearCol(grid, a.c, a.r, mr)) continue;
    if (!clearRow(grid, mr, a.c, b.c)) continue;
    if (!clearCol(grid, b.c, mr, b.r)) continue;
    const points = simplify([a, p1, p2, b]);
    if (turnCount(points) <= MAX_TURNS) return { points, turns: turnCount(points) };
  }

  return null;
}

export function cellKey(c, r) {
  return `${c}:${r}`;
}
