import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

import { GameEngine, createSessionId } from '../server/game-engine/engine.js';
import { GAME_DEFAULTS } from '../server/config.js';
import { MemoryStore } from '../server/database/store.js';
import { SqliteStore } from '../server/database/sqlite.js';
import { findMove, makeRng, remainingTiles } from '../server/game-engine/board.js';
import { createApiRouter } from '../server/api/routes.js';

function setup(overrides = {}) {
  const store = new MemoryStore();
  store.init();
  const clock = { value: 1_700_000_000_000 };
  const engine = new GameEngine({
    store,
    settings: { ...GAME_DEFAULTS, ...overrides },
    rng: makeRng(11),
    now: () => clock.value,
    logger: { info() {}, warn() {}, error() {} },
  });
  const events = { session: [], state: [], feed: [], leaderboard: [], mascot: [], notice: [] };
  for (const type of Object.keys(events)) engine.on(type, (payload) => events[type].push(payload));
  const advance = (ms) => {
    clock.value += ms;
  };
  return { engine, store, clock, events, advance };
}

function seedSession(store) {
  store.ensurePlayer({ id: 'id:alice', username: 'Alice' });
  store.addScore('id:alice', { points: 120, matches: 4, attempts: 5 });
  store.addGift('id:alice', { coins: 50, count: 2 });
  store.recordGift({ giftId: 'rose', name: 'Rose', coins: 1 });
}

test('reset clears players, leaderboards and point/match statistics', () => {
  const { engine, store } = setup();
  engine.start();
  seedSession(store);
  assert.equal(store.countPlayers(), 1);

  const result = engine.resetSession();

  assert.equal(result.ok, true);
  assert.equal(store.countPlayers(), 0);
  assert.deepEqual(store.listGifts(), []);
  assert.deepEqual(store.listLogs(), []);
  assert.deepEqual(engine.leaderboard().top, []);
  assert.deepEqual(engine.leaderboard().gifters, []);
  assert.deepEqual(engine.leaderboard().active, []);
  assert.equal(engine.leaderboard().totalPlayers, 0);
});

test('reset clears session gift statistics but keeps gift metadata mapping intact', () => {
  const { engine, store } = setup();
  engine.start();
  store.recordGift({ giftId: 'rose', name: 'Rose', coins: 1 });
  store.recordGift({ giftId: 'rose', name: 'Rose', coins: 1 });
  assert.equal(store.listGifts().length, 1);

  engine.resetSession();

  assert.deepEqual(store.listGifts(), []);
  // Gift ID mappings and tiers are configuration, not session data.
  const mappings = engine.settings.giftRules.map((rule) => rule.giftId);
  assert.deepEqual(mappings, GAME_DEFAULTS.giftRules.map((rule) => rule.giftId));
  assert.equal(engine.settings.giftTiers.length, GAME_DEFAULTS.giftTiers.length);
});

test('reset announces the new session and broadcasts an empty leaderboard', () => {
  const { engine, store, events } = setup();
  engine.start();
  seedSession(store);

  engine.resetSession();

  assert.equal(events.session.length, 1);
  assert.equal(events.session[0].action, 'reset');
  assert.match(events.session[0].sessionId, /^LIVE-/);
  assert.equal(events.leaderboard.at(-1).top.length, 0);
  const state = events.state.at(-1);
  assert.equal(state.sessionId, events.session[0].sessionId);
  assert.equal(state.remaining, state.cols * state.rows);
});

test('reset returns to a running Level 1 with a full board and clears game over', () => {
  const { engine } = setup();
  engine.start();
  engine.state.level = 4;
  engine.state.totalMatches = 88;
  engine.stopGame('test');

  const result = engine.resetSession();
  const snapshot = result.game;

  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.level, 1);
  assert.equal(snapshot.totalMatches, 0);
  assert.equal(snapshot.gameOverAt, null);
  assert.equal(snapshot.gameOverReason, null);
  assert.equal(snapshot.levelTransition, false);
  assert.equal(remainingTiles(engine.board), snapshot.cols * snapshot.rows);
});

test('reset always generates a solvable Level 1 board', () => {
  const { engine, advance } = setup();
  engine.start();

  for (let i = 0; i < 6; i += 1) {
    advance(6000);
    const result = engine.resetSession();
    assert.equal(result.ok, true);
    assert.ok(findMove(engine.board), `reset #${i + 1} produced a board without a legal move`);
    assert.equal(remainingTiles(engine.board), engine.board.cols * engine.board.rows);
  }
});

test('reset creates a new session id and records its start time', () => {
  const { engine, clock } = setup();
  engine.start();
  const before = engine.sessionId;

  const result = engine.resetSession();

  assert.notEqual(result.sessionId, before);
  assert.equal(engine.snapshot().sessionId, result.sessionId);
  assert.equal(engine.snapshot().sessionStartedAt, clock.value);
  assert.equal(result.previousSessionId, before);
  assert.equal(createSessionId(clock.value) !== createSessionId(clock.value), true);
});

test('settings, music and TikFinity configuration survive the reset', () => {
  const { engine, store } = setup();
  engine.start();
  engine.applySettings({ musicShuffle: true, musicVolume: 0.17, cooldownMs: 3200, difficulty: 'hard' });
  const settingsBefore = JSON.parse(JSON.stringify(engine.settings));
  store.setConfig(engine.settings);

  engine.resetSession();

  assert.deepEqual(engine.settings, settingsBefore);
  assert.deepEqual(store.getConfig(), settingsBefore);
  assert.equal(engine.settings.musicShuffle, true);
  assert.equal(engine.settings.musicVolume, 0.17);
});

test('licensed music files and gift icons are untouched by a reset', () => {
  const count = (dir) => {
    const full = path.join(process.cwd(), dir);
    return fs
      .readdirSync(full)
      .sort()
      .map((name) => `${name}:${fs.statSync(path.join(full, name)).size}`);
  };
  const musicBefore = count('assets/music');
  const iconsBefore = count('assets/gift_icon');
  const { engine } = setup();
  engine.start();

  engine.resetSession();

  assert.deepEqual(count('assets/music'), musicBefore);
  assert.deepEqual(count('assets/gift_icon'), iconsBefore);
  assert.ok(musicBefore.length > 10);
  assert.ok(iconsBefore.length >= 5);
});

test('reset cancels auto play timers and pending level transitions', () => {
  const { engine, advance } = setup();
  engine.start();
  engine.state.autoPlay = true;
  engine.autoMoveCount = 7;
  engine.pendingLevelAt = 1_700_000_003_000;
  engine.levelCompletePending = true;
  engine.nextAutoMoveAt = 1_700_000_000_000;
  engine.idleStage = 3;

  engine.resetSession();

  assert.equal(engine.pendingLevelAt, null);
  assert.equal(engine.levelCompletePending, false);
  assert.equal(engine.nextAutoMoveAt, 0);
  assert.equal(engine.autoMoveCount, 0);
  assert.equal(engine.idleStage, 0);
  assert.equal(engine.state.autoPlay, false);
  assert.equal(engine.runtimePlayers.size, 0);

  // A tick after the old schedule would have fired must not move a tile.
  const remaining = remainingTiles(engine.board);
  advance(30_000);
  engine.tick();
  assert.equal(remainingTiles(engine.board), remaining);
});

test('comments and gifts arriving during the reset are rejected', () => {
  const { engine, store } = setup();
  engine.start();
  let duringChat = null;
  let duringGift = null;
  const reset = store.resetSession.bind(store);
  store.resetSession = () => {
    duringChat = engine.handleChat({ userId: 'Bob', username: 'Bob', text: 'JOIN' });
    duringGift = engine.handleGift({ giftId: 'rose', giftName: 'Rose', coins: 1, username: 'Bob' });
    reset();
  };

  const result = engine.resetSession();

  assert.equal(result.ok, true);
  assert.equal(duringChat.reason, 'reset-in-progress');
  assert.equal(duringGift.reason, 'reset-in-progress');
  assert.equal(store.countPlayers(), 0);
  assert.equal(engine.suspended, false);
});

test('events from the previous session are ignored after a reset', () => {
  const { engine, clock } = setup();
  engine.start();
  const oldSession = engine.sessionId;
  clock.value += 10_000;
  engine.resetSession();

  const staleChat = engine.handleChat({
    userId: 'Zed',
    username: 'Zed',
    text: 'JOIN',
    ts: clock.value - 60_000,
    sessionId: oldSession,
  });
  const staleGift = engine.handleGift({ giftId: 'rose', giftName: 'Rose', coins: 1, username: 'Zed', sessionId: oldSession });
  const fresh = engine.handleChat({ userId: 'Zed', username: 'Zed', text: 'JOIN', ts: clock.value });

  assert.equal(staleChat.reason, 'stale-session');
  assert.equal(staleGift.reason, 'stale-session');
  assert.equal(fresh.ok, true);
  assert.equal(fresh.type, 'join');
});

test('a storage failure keeps the previous session and leaves it running', () => {
  const { engine, store, events } = setup();
  engine.start();
  seedSession(store);
  engine.state.level = 3;
  const board = engine.board;
  const sessionId = engine.sessionId;
  store.resetSession = () => {
    throw new Error('disk full');
  };

  const result = engine.resetSession();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'storage-failed');
  assert.equal(engine.sessionId, sessionId);
  assert.equal(engine.board, board);
  assert.equal(engine.state.level, 3);
  assert.equal(engine.suspended, false);
  assert.equal(events.session.length, 0);
  assert.equal(store.countPlayers(), 1);
});

test('two resets in a row are refused, then allowed after the cooldown', () => {
  const { engine, advance, events } = setup();
  engine.start();
  assert.equal(engine.resetSession().ok, true);

  const second = engine.resetSession();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'too-soon');
  assert.equal(events.session.length, 1);

  advance(6000);
  assert.equal(engine.resetSession().ok, true);
  assert.equal(events.session.length, 2);
});

test('the SQLite reset is one transaction that rolls back on failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikachu-reset-'));
  const store = new SqliteStore(path.join(dir, 'test.db'));
  store.init();
  try {
    store.ensurePlayer({ id: 'id:alice', username: 'Alice' });
    store.addScore('id:alice', { points: 90, matches: 3 });
    store.addGift('id:alice', { coins: 20, count: 1 });
    store.recordGift({ giftId: 'rose', name: 'Rose', coins: 1 });
    store.log({ category: 'test', message: 'Demo gift from a test run.' });
    store.setConfig({ musicEnabled: false, giftTiers: GAME_DEFAULTS.giftTiers });

    // Force the second DELETE in the transaction to fail.
    store.db.exec("CREATE TRIGGER block_gift_delete BEFORE DELETE ON gifts BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    assert.throws(() => store.resetSession(), /blocked/);

    assert.equal(store.listTop(1).length, 1, 'players must survive a rolled back reset');
    assert.equal(store.listGifts().length, 1, 'gifts must survive a rolled back reset');
    assert.equal(store.listLogs().length >= 1, true, 'logs must survive a rolled back reset');
    assert.deepEqual(store.getConfig(), { musicEnabled: false, giftTiers: GAME_DEFAULTS.giftTiers });

    store.db.exec('DROP TRIGGER block_gift_delete');
    store.resetSession();

    assert.equal(store.listTop(1).length, 0);
    assert.equal(store.listGifts().length, 0);
    assert.equal(store.listLogs().length, 0);
    assert.deepEqual(store.getConfig(), { musicEnabled: false, giftTiers: GAME_DEFAULTS.giftTiers });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the admin reset endpoint requires the token and syncs new state to overlays', async () => {
  const { engine, store } = setup();
  engine.start();
  seedSession(store);

  const frames = [];
  const hub = { clientCount: 2, broadcast: (type, payload) => frames.push({ type, payload }) };
  engine.on('state', (state) => hub.broadcast('state', state));
  engine.on('leaderboard', (board) => hub.broadcast('leaderboard', board));

  const tikfinity = {
    status: () => ({
      state: 'connected',
      connected: true,
      url: 'ws://127.0.0.1:21213/',
      lastEventAt: null,
      eventsReceived: 0,
      attempt: 0,
      lastError: null,
    }),
  };
  const mock = { status: () => ({ state: 'idle', eventsReceived: 0, lastEventAt: null }) };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ engine, store, tikfinity, mock, hub, ingest: () => {}, music: null, logger: null }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauthorized = await fetch(`${base}/api/admin/game`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reset-session' }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(engine.sessionId !== null, true);

    const response = await fetch(`${base}/api/admin/game`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'change-me-now' },
      body: JSON.stringify({ action: 'reset-session' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.session.id, engine.sessionId);
    assert.equal(body.game.level, 1);
    assert.equal(body.game.status, 'running');
    assert.deepEqual(body.leaderboard.top, []);

    const stateFrame = frames.filter((frame) => frame.type === 'state').at(-1);
    assert.equal(stateFrame.payload.sessionId, body.session.id);
    assert.equal(stateFrame.payload.remaining, stateFrame.payload.cols * stateFrame.payload.rows);

    // A second immediate reset is refused, not repeated.
    const repeated = await fetch(`${base}/api/admin/game`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'change-me-now' },
      body: JSON.stringify({ action: 'reset-session' }),
    });
    assert.equal(repeated.status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
