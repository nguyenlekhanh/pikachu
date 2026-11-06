/**
 * Mascot flight geometry - pure math, no DOM, so it can be unit tested.
 *
 * The overlay reserves a rail on each side of the board. A mascot may only move
 * inside its own rail, so it can never cover the playable tile grid, the
 * coordinates, the instruction banner, the gift legend or the leaderboard.
 */

/** Current display size (design px at 1080x1920) that 60-70% is applied to. */
export const MASCOT_BASE_SIZE = 240;
export const MASCOT_SCALE_MIN = 0.6;
export const MASCOT_SCALE_MAX = 0.7;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function mascotSize(scale = 0.6) {
  const bounded = clamp(Number(scale) || 0.6, MASCOT_SCALE_MIN, MASCOT_SCALE_MAX);
  return Math.round(MASCOT_BASE_SIZE * bounded);
}

/**
 * Build the two rails from the *real* board rectangle (design coordinates).
 *
 * Returns travel rectangles for the mascot's top-left corner. `gap` keeps a
 * visible gutter between the mascot and the board, so even the tail/wings never
 * touch the frame. If a screen is too narrow for a rail, the rail collapses to
 * the outer edge instead of moving over the board (never overlap).
 */
export function computeLanes({ stageWidth = 1080, board, size = mascotSize(), gap = 8, edge = 8 } = {}) {
  if (!board || !Number.isFinite(board.x) || !Number.isFinite(board.w)) {
    throw new Error('computeLanes needs the board rectangle');
  }
  const minY = board.y;
  const maxY = Math.max(minY, board.y + board.h - size);
  const leftMaxX = board.x - size - gap;
  const rightMinX = board.x + board.w + gap;

  return {
    left: {
      side: 'left',
      minX: edge,
      maxX: Math.max(edge, leftMaxX),
      minY,
      maxY,
      size,
    },
    right: {
      side: 'right',
      minX: Math.min(rightMinX, stageWidth - edge - size),
      maxX: Math.max(Math.min(rightMinX, stageWidth - edge - size), stageWidth - edge - size),
      minY,
      maxY,
      size,
    },
  };
}

/** Axis-aligned hit test used by the tests and by the overlay guard. */
export function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** The rectangle a mascot occupies when its top-left corner is at (x, y). */
export function mascotRect(lane, x, y) {
  return { x, y, w: lane.size, h: lane.size };
}

/**
 * Is this flight position legal for the lane? Used before every move, so a
 * stale transform or a resize can never leave a mascot over the board.
 */
export function insideLane(lane, x, y, slack = 0.5) {
  return (
    x >= lane.minX - slack &&
    x <= lane.maxX + slack &&
    y >= lane.minY - slack &&
    y <= lane.maxY + slack
  );
}

/**
 * Pick the next patrol target inside a lane. Mascots move mostly vertically
 * along the board edge, with a small horizontal drift, and sometimes stop at
 * the top or bottom of the rail ("pause at the edges").
 */
export function nextWaypoint(lane, rng = Math.random, current = null) {
  const top = lane.minY;
  const bottom = lane.maxY;
  const span = Math.max(1, bottom - top);
  const drift = Math.min(18, Math.max(0, lane.maxX - lane.minX));
  const edgeStop = rng() < 0.4;
  let y;
  if (edgeStop) {
    y = rng() < 0.5 ? top : bottom;
  } else {
    y = top + rng() * span;
  }
  // Avoid tiny hops that look like twitching.
  if (current && Math.abs(y - current.y) < span * 0.22) {
    y = current.y > top + span / 2 ? top : bottom;
  }
  const x = drift > 0 ? lane.minX + rng() * drift : lane.minX;
  return { x: clamp(x, lane.minX, lane.maxX), y: clamp(y, top, bottom), pauseMs: edgeStop ? 900 + rng() * 1800 : 0 };
}
