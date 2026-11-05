#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server.
 *
 * Verifies the real stack: HTTP state, admin auth, WebSocket broadcast, a chat
 * move through the mock pipeline, and a gift effect. Run with the server up:
 *
 *   npm start          (terminal 1)
 *   node scripts/smoke.js
 */

import WebSocket from 'ws';
import { findMove, labelOf } from '../server/game-engine/board.js';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const TOKEN = process.env.ADMIN_TOKEN || 'change-me-now';
const WS_URL = BASE.replace('http', 'ws') + '/ws';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path) {
  const response = await fetch(BASE + path);
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function admin(path, body) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(body || {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

function firstMove(state) {
  if (!state?.grid) return null;
  const board = { cols: state.cols, rows: state.rows, grid: state.grid };
  const move = findMove(board);
  if (!move) return null;
  return `${labelOf(move.a.c - 1, move.a.r - 1)} ${labelOf(move.b.c - 1, move.b.r - 1)}`;
}

async function main() {
  if (!(await waitForServer())) {
    console.error(`Server is not answering on ${BASE}. Start it with: npm start`);
    process.exit(1);
  }

  const health = await json('/api/health');
  check('health endpoint', health.status === 200 && health.body.ok === true, `db=${health.body?.database}`);
  check('sqlite storage active', health.body?.database === 'sqlite', String(health.body?.database));

  const initial = await json('/api/state');
  const game = initial.body.game;
  check('overlay bootstrap state', initial.status === 200 && Array.isArray(game.grid), `level=${game.level}`);
  check('game is running', game.status === 'running', game.status);
  check('board is populated', game.remaining > 0, `${game.remaining} tiles`);

  const music = await json('/api/music');
  check(
    'music playlist endpoint',
    music.status === 200 && Array.isArray(music.body.tracks),
    `${music.body?.tracks?.length ?? 0} track(s), ${music.body?.skipped?.length ?? 0} skipped`
  );

  const unauth = await json('/api/admin/overview');
  check('admin API rejects missing token', unauth.status === 401, `HTTP ${unauth.status}`);

  const auth = await admin('/api/admin/auth', { token: TOKEN });
  check('admin token accepted', auth.status === 200 && auth.body.ok === true);

  const overview = await fetch(`${BASE}/api/admin/overview`, { headers: { 'x-admin-token': TOKEN } }).then((r) => r.json());
  // TikFinity may genuinely be running on this PC, so assert that the public
  // status matches the adapter state instead of assuming it is offline.
  const tfPublic = initial.body.tiktok;
  check(
    'TikFinity status is reported honestly',
    tfPublic.connected
      ? tfPublic.mode === 'TIKFINITY LIVE' && overview.tiktok.tikfinity.state === 'connected'
      : tfPublic.mode === 'MOCK / OFFLINE' && overview.tiktok.tikfinity.connected === false,
    `${tfPublic.state}/${tfPublic.mode}`
  );

  // --- websocket
  const messages = [];
  const socket = new WebSocket(WS_URL);
  const wsReady = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'overlay' }));
    });
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        if (message.type === 'state') {
          clearTimeout(timer);
          resolve(true);
        }
      } catch {
        /* ignore */
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  check('websocket delivers a state snapshot', wsReady, `${messages.length} messages`);

  // --- chat move through the same pipeline the overlay uses
  const stamp = Date.now() % 100000;
  const player = `Smoke${stamp}`;
  await admin('/api/admin/test', { type: 'comment', username: player, text: 'JOIN' });

  let before = (await json('/api/state')).body.game;
  if (before.remaining < 8) {
    // Leave enough tiles for the move and gift checks to be meaningful.
    await admin('/api/admin/game', { action: 'restart' });
    await sleep(600);
    before = (await json('/api/state')).body.game;
  }
  const move = firstMove(before);
  if (move) {
    await admin('/api/admin/test', { type: 'comment', username: `${player}b`, text: move });
  }
  await sleep(500);
  const after = (await json('/api/state')).body.game;
  check('chat move removes a pair', Boolean(move) && after.remaining <= before.remaining - 2, `move=${move} ${before.remaining}->${after.remaining}`);

  // The public top-10 can be crowded after many test runs, so ask the server for
  // this player's own score with the ME command and read the broadcast notice.
  await sleep(1200);
  let scoredPoints = 0;
  // The cooldown can answer the first ME with a "slow down" notice; retry until
  // the server reports the score instead of assuming a single attempt lands.
  for (let attempt = 0; attempt < 4 && scoredPoints < 10; attempt += 1) {
    await admin('/api/admin/test', { type: 'comment', username: `${player}b`, text: 'ME' });
    await sleep(700);
    const notices = messages.filter(
      (message) => message.type === 'notice' && String(message.payload?.username || '').startsWith(`Smoke${stamp}`)
    );
    const last = notices[notices.length - 1];
    const match = String(last?.payload?.text || '').match(/(\d+)\s+points/);
    if (match) scoredPoints = Number(match[1]);
    else await sleep(900);
  }
  check('move awards leaderboard points', scoredPoints >= 10, scoredPoints ? `${player}b=${scoredPoints} points` : 'no score notice');

  const board = await json('/api/leaderboard');
  check('leaderboard endpoint responds', board.status === 200 && Array.isArray(board.body.top), `${board.body?.top?.length ?? 0} players`);

  const fxSeen = messages.some((message) => message.type === 'fx' && message.payload.kind === 'match');
  check('overlay receives match effect over websocket', fxSeen);

  // --- gift effect
  const beforeGift = (await json('/api/state')).body.game.remaining;
  await admin('/api/admin/test', { type: 'gift', username: `${player}Gift`, giftId: 'smoke-medium', giftName: 'Hand Hearts', coins: 99 });
  await sleep(700);
  const afterGift = (await json('/api/state')).body.game.remaining;
  check('medium gift clears half the board', afterGift < beforeGift, `${beforeGift}->${afterGift}`);

  const logs = await fetch(`${BASE}/api/admin/logs?limit=20`, { headers: { 'x-admin-token': TOKEN } }).then((r) => r.json());
  check('event log records activity', Array.isArray(logs.logs) && logs.logs.length > 0, `${logs.logs.length} entries`);

  socket.close();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error.message);
  process.exit(1);
});
