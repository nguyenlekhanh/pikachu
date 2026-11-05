import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, parseCommand } from '../server/game-engine/engine.js';
import { GAME_DEFAULTS } from '../server/config.js';
import { MemoryStore } from '../server/database/store.js';
import { findMove, labelOf, makeRng, remainingTiles } from '../server/game-engine/board.js';

function setup(overrides = {}) {
  const store = new MemoryStore();
  store.init();
  const clock = { value: 1_700_000_000_000 };
  const engine = new GameEngine({
    store,
    settings: { ...GAME_DEFAULTS, ...overrides },
    rng: makeRng(7),
    now: () => clock.value,
  });
  const advance = (ms) => {
    clock.value += ms;
  };
  return { engine, store, clock, advance };
}

function legalMove(engine) {
  const move = findMove(engine.board);
  assert.ok(move, 'expected a legal move on the board');
  return {
    move,
    text: `${labelOf(move.a.c - 1, move.a.r - 1)} ${labelOf(move.b.c - 1, move.b.r - 1)}`,
  };
}

function send(engine, username, text) {
  // playerKeyFromEvent prefixes numeric/id-shaped ids, so keys become id:<name>
  return engine.handleChat({ userId: username, username, text });
}

test('parseCommand accepts spacings, compact form and is case insensitive', () => {
  assert.equal(parseCommand('a1 b1', 6, 6).kind, 'move');
  assert.equal(parseCommand('A1B1', 6, 6).kind, 'move');
  assert.equal(parseCommand(' A1,B1 ', 6, 6).kind, 'move');
  assert.equal(parseCommand('!top', 6, 6).name, 'TOP');
  assert.equal(parseCommand('help', 6, 6).name, 'HELP');
  assert.equal(parseCommand('hello world', 6, 6), null);
  assert.equal(parseCommand('A1 Z9', 6, 6).invalid, 'out-of-range');
});

test('new game starts with a full, playable board', () => {
  const { engine } = setup();
  engine.start();
  assert.equal(engine.state.status, 'running');
  assert.equal(remainingTiles(engine.board), 36);
  assert.equal(engine.snapshot().remaining, 36);
  assert.ok(findMove(engine.board));
});

test('a valid move removes both tiles and awards points', () => {
  const { engine, store } = setup();
  engine.start();
  const { text } = legalMove(engine);
  const result = send(engine, 'Alice', text);
  assert.equal(result.ok, true);
  assert.equal(result.points, 10);
  assert.equal(remainingTiles(engine.board), 34);
  assert.equal(store.getPlayer('id:Alice').score, 10);
  assert.equal(store.getPlayer('id:Alice').matches, 1);
});

test('a mismatched pair is rejected without changing the board or score', () => {
  const { engine, store } = setup();
  engine.start();
  // Find two different tile types that are both occupied.
  const cells = [];
  for (let r = 1; r <= engine.board.rows; r += 1) {
    for (let c = 1; c <= engine.board.cols; c += 1) {
      if (engine.board.grid[r][c] !== null) cells.push({ c, r, type: engine.board.grid[r][c] });
    }
  }
  const first = cells[0];
  const second = cells.find((cell) => cell.type !== first.type);
  const text = `${labelOf(first.c - 1, first.r - 1)} ${labelOf(second.c - 1, second.r - 1)}`;
  const result = send(engine, 'Bob', text);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mismatch');
  assert.equal(remainingTiles(engine.board), 36);
  assert.equal(store.getPlayer('id:Bob').score, 0);
});

test('per-player cooldown blocks rapid commands', () => {
  const { engine, advance } = setup();
  engine.start();
  const first = legalMove(engine);
  assert.equal(send(engine, 'Cara', first.text).ok, true);

  advance(500);
  const second = legalMove(engine);
  const blocked = send(engine, 'Cara', second.text);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'cooldown');

  advance(2000);
  assert.equal(send(engine, 'Cara', second.text).ok, true);
});

test('duplicate identical comments are processed once', () => {
  const { engine } = setup();
  engine.start();
  const { text } = legalMove(engine);
  assert.equal(send(engine, 'Dana', text).ok, true);
  const duplicate = send(engine, 'Dana', text);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate');
});

test('two players cannot claim the same tiles', () => {
  const { engine, store } = setup();
  engine.start();
  const { text } = legalMove(engine);
  const first = send(engine, 'Eve', text);
  const second = send(engine, 'Frank', text);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'empty-tile');
  assert.equal(store.getPlayer('id:Frank').score, 0);
  assert.equal(store.getPlayer('id:Eve').score, 10);
});

test('combo bonuses grow with consecutive successful matches', () => {
  const { engine, store, advance } = setup();
  engine.start();
  const expected = [10, 12, 14];
  expected.forEach((points, index) => {
    const { text } = legalMove(engine);
    const result = send(engine, 'Combo Kid', text);
    assert.equal(result.ok, true, `move ${index + 1} should succeed`);
    assert.equal(result.points, points);
    advance(2500);
  });
  assert.equal(store.getPlayer('id:Combo Kid').score, 36);
});

test('an invalid move resets the combo', () => {
  const { engine, store, advance } = setup();
  engine.start();
  const first = legalMove(engine);
  assert.equal(send(engine, 'Gina', first.text).points, 10);
  advance(2500);

  const cells = [];
  for (let r = 1; r <= engine.board.rows; r += 1) {
    for (let c = 1; c <= engine.board.cols; c += 1) {
      if (engine.board.grid[r][c] !== null) cells.push({ c, r, type: engine.board.grid[r][c] });
    }
  }
  const a = cells[0];
  const b = cells.find((cell) => cell.type !== a.type);
  send(engine, 'Gina', `${labelOf(a.c - 1, a.r - 1)} ${labelOf(b.c - 1, b.r - 1)}`);
  advance(2500);

  const next = legalMove(engine);
  assert.equal(send(engine, 'Gina', next.text).points, 10);
});

test('clearing the board completes the level and loads the next one', () => {
  const { engine, advance } = setup();
  engine.start();
  assert.equal(engine.state.level, 1);
  let guard = 0;
  while (remainingTiles(engine.board) > 0 && guard < 300) {
    guard += 1;
    const { text } = legalMove(engine);
    const result = send(engine, 'Team', text);
    assert.equal(result.ok, true);
    advance(5000);
  }
  assert.equal(remainingTiles(engine.board), 0);
  assert.equal(engine.state.totalMatches, 18);
  assert.ok(engine.pendingLevelAt, 'level transition should be scheduled');

  advance(3200);
  engine.tick();
  assert.equal(engine.state.level, 2);
  assert.ok(remainingTiles(engine.board) > 0);
});

test('the board shuffles when no legal move exists', () => {
  const { engine } = setup();
  engine.start();
  const cols = 4;
  const rows = 4;
  const grid = Array.from({ length: rows + 2 }, () => new Array(cols + 2).fill(null));
  grid[2][2] = 0;
  grid[3][2] = 1;
  grid[3][3] = 0;
  grid[2][3] = 1;
  engine.board = { cols, rows, grid };
  assert.equal(findMove(engine.board), null);

  let shuffled = false;
  engine.on('fx', (fx) => {
    if (fx.kind === 'shuffle') shuffled = true;
  });
  engine.shuffleBoard('test');
  assert.equal(shuffled, true);
  assert.equal(remainingTiles(engine.board), 4, 'shuffle must preserve the tile count');
});

test('auto play starts after the idle timeout and stops when a human plays', () => {
  const { engine, advance } = setup();
  engine.start();
  const before = remainingTiles(engine.board);

  advance(15000);
  engine.tick();
  assert.equal(engine.state.autoPlay, false);

  advance(45000);
  engine.tick();
  assert.equal(engine.state.autoPlay, true);

  advance(900);
  engine.tick();
  assert.ok(remainingTiles(engine.board) < before, 'auto play should clear a pair');

  advance(900);
  const { text } = legalMove(engine);
  const result = send(engine, 'Human', text);
  assert.equal(result.ok, true);
  assert.equal(engine.state.autoPlay, false);
});

test('auto play can be disabled entirely', () => {
  const { engine, advance } = setup({ autoPlayEnabled: false });
  engine.start();
  advance(120000);
  engine.tick();
  assert.equal(engine.state.autoPlay, false);
});

test('a 1 coin gift triggers a hint', () => {
  const { engine, store } = setup();
  engine.start();
  const fx = [];
  engine.on('fx', (fxEvent) => fx.push(fxEvent));
  const result = engine.handleGift({
    userId: 'Gifter',
    username: 'Gifter',
    giftId: '5655',
    giftName: 'Rose',
    diamondCount: 1,
    repeatCount: 1,
    repeatEnd: true,
    createTime: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'HINT');
  assert.ok(fx.some((event) => event.kind === 'hint'));
  assert.equal(store.getPlayer('id:Gifter').giftCoins, 1);
});

test('duplicate gift events are ignored', () => {
  const { engine } = setup();
  engine.start();
  const event = {
    userId: 'id-Gifter',
    username: 'Gifter',
    giftId: '5655',
    giftName: 'Rose',
    diamondCount: 1,
    repeatCount: 1,
    repeatEnd: true,
    createTime: 42,
  };
  assert.equal(engine.handleGift(event).ok, true);
  const duplicate = engine.handleGift(event);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate');
});

test('gift streak parts are deferred until the streak completes', () => {
  const { engine } = setup();
  engine.start();
  const base = {
    userId: 'Streaker',
    username: 'Streaker',
    giftId: '9999',
    giftName: 'Hand Hearts',
    diamondCount: 10,
    createTime: 7,
  };
  const partial = engine.handleGift({ ...base, repeatCount: 1, repeatEnd: false });
  assert.equal(partial.deferred, true);

  const final = engine.handleGift({ ...base, repeatCount: 3, repeatEnd: true });
  assert.equal(final.ok, true);
  assert.equal(final.coins, 30);
  assert.equal(final.action, 'REVEAL_PAIR');
});

test('a large gift completes the level', () => {
  const { engine } = setup();
  engine.start();
  const result = engine.handleGift({
    userId: 'Big',
    username: 'BigSpender',
    giftId: '1111',
    giftName: 'Galaxy',
    diamondCount: 400,
    repeatCount: 1,
    repeatEnd: true,
    createTime: 9,
  });
  assert.equal(result.action, 'COMPLETE_LEVEL');
  assert.equal(remainingTiles(engine.board), 0);
  assert.ok(engine.pendingLevelAt);
});

test('STOP_GAME requires the admin switch and preserves the leaderboard', () => {
  const blocked = setup();
  blocked.engine.start();
  send(blocked.engine, 'Scorer', legalMove(blocked.engine).text);
  const blockedResult = blocked.engine.handleGift({
    userId: 'Super',
    username: 'SuperFan',
    giftId: '2222',
    giftName: 'Universe',
    diamondCount: 1500,
    repeatCount: 1,
    repeatEnd: true,
    createTime: 11,
  });
  assert.equal(blockedResult.requestedAction, 'STOP_GAME');
  assert.equal(blockedResult.action, 'REVEAL_PAIR', 'disabled STOP_GAME must downgrade to a reveal');
  assert.notEqual(blocked.engine.state.status, 'gameover');

  const enabled = setup({ stopGameEnabled: true });
  enabled.engine.start();
  send(enabled.engine, 'Scorer', legalMove(enabled.engine).text);
  const result = enabled.engine.handleGift({
    userId: 'Super',
    username: 'SuperFan',
    giftId: '2222',
    giftName: 'Universe',
    diamondCount: 1500,
    repeatCount: 1,
    repeatEnd: true,
    createTime: 12,
  });
  assert.equal(result.action, 'STOP_GAME');
  assert.equal(enabled.engine.state.status, 'gameover');
  assert.ok(enabled.store.listTop(10).length > 0, 'leaderboard data must survive a game over');
});

test('leaderboard ranks players by score', () => {
  const { engine, store, advance } = setup();
  engine.start();
  const a = legalMove(engine);
  send(engine, 'Low', a.text);
  advance(2500);
  const b = legalMove(engine);
  send(engine, 'High', b.text);
  advance(2500);
  const c = legalMove(engine);
  send(engine, 'High', c.text);

  const top = store.listTop(5);
  assert.equal(top[0].username, 'High');
  assert.equal(store.rankOf('id:High'), 1);
  assert.equal(store.rankOf('id:Low'), 2);
  assert.equal(engine.leaderboard().totalPlayers, 2);
});

test('TOP, ME, RANK, JOIN and HELP produce player notices', () => {
  const { engine, advance } = setup();
  engine.start();
  const notices = [];
  engine.on('notice', (notice) => notices.push(notice));

  assert.equal(send(engine, 'Ivy', 'JOIN').ok, true);
  for (const command of ['TOP', 'ME', 'RANK', 'HELP']) {
    advance(1200);
    engine.handleChat({ userId: 'Ivy', username: 'Ivy', text: command });
  }
  assert.ok(notices.length >= 4);
  assert.ok(notices.some((notice) => /rank/i.test(notice.text)));
});

test('paused games reject moves and resume continues play', () => {
  const { engine, advance } = setup();
  engine.start();
  engine.pause();
  const { text } = legalMove(engine);
  const result = send(engine, 'Jo', text);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'paused');
  engine.resume();
  advance(2500);
  const resumed = send(engine, 'Jo', text);
  assert.equal(resumed.ok, true);
});

test('restart resets level, matches and board', () => {
  const { engine } = setup();
  engine.start();
  send(engine, 'Kim', legalMove(engine).text);
  engine.restart();
  assert.equal(engine.state.level, 1);
  assert.equal(engine.state.totalMatches, 0);
  assert.equal(remainingTiles(engine.board), 36);
});
