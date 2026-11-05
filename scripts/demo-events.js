#!/usr/bin/env node
/**
 * Demo driver: pushes a realistic sequence of mock comments and gifts through
 * the running server, so you can watch the whole game react without TikTok.
 *
 * Usage: npm run demo
 *   (server must be running; reads ADMIN_TOKEN from .env)
 */

import 'dotenv/config';
import { findMove, labelOf } from '../server/game-engine/board.js';

// A PORT of 0/empty means "not configured" (see server/config.js).
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const BASE = process.env.DEMO_BASE_URL || `http://localhost:${PORT}`;
const TOKEN = process.env.ADMIN_TOKEN || 'change-me-now';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      'x-admin-token': TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

const comment = (username, text) => api('/api/admin/test', { type: 'comment', username, text });
const gift = (username, coins, giftName, giftId) =>
  api('/api/admin/test', { type: 'gift', username, coins, giftName, giftId });

async function findLiveMove() {
  const state = await api('/api/state');
  const game = state.game;
  if (!game || !game.grid) return null;
  const board = { cols: game.cols, rows: game.rows, grid: game.grid };
  const move = findMove(board);
  if (!move) return null;
  return `${labelOf(move.a.c - 1, move.a.r - 1)} ${labelOf(move.b.c - 1, move.b.r - 1)}`;
}

async function main() {
  console.log(`PIKACHU LIVE demo against ${BASE}`);
  const health = await api('/api/health');
  console.log(`Server is up (db=${health.database}, game=${health.game}).`);

  console.log('→ JOIN from DemoAlice');
  await comment('DemoAlice', 'JOIN');
  await sleep(1200);

  console.log('→ TOP');
  await comment('CoachRay', 'TOP');
  await sleep(900);

  console.log('→ HELP');
  await comment('NinaStreams', 'HELP');
  await sleep(900);

  const move = await findLiveMove();
  if (move) {
    console.log(`→ valid move from DemoAlice: ${move}`);
    await comment('DemoAlice', move);
    await sleep(1400);
  } else {
    console.log('→ board has no move right now, skipping the demo move');
  }

  console.log('→ HINT');
  await comment('PixelPaula', 'HINT');
  await sleep(1000);

  console.log('→ invalid move from TurboTom (A1 B1 is usually a mismatch)');
  await comment('TurboTom', 'A1 B1');
  await sleep(1200);

  console.log('→ tier 1 gift (1 coin)');
  await gift('BigDanny', 1, 'Rose', 'mock-rose');
  await sleep(1600);

  console.log('→ tier 2 gift (5 coins)');
  await gift('ZoeZaps', 5, 'Finger Heart', 'mock-finger');
  await sleep(1600);

  console.log('→ tier 3 gift (99 coins)');
  await gift('LunaPlays', 99, 'Hand Hearts', 'mock-hands');
  await sleep(1800);

  console.log('→ tier 4 gift (400 coins)');
  await gift('MikeTheBoss', 400, 'Galaxy', 'mock-galaxy');
  await sleep(2500);

  console.log('→ ME / RANK');
  await comment('LunaPlays', 'ME');
  await sleep(800);
  await comment('LunaPlays', 'RANK');
  await sleep(600);

  console.log('Demo finished. Check the overlay and the admin event log.');
}

main().catch((error) => {
  console.error('Demo failed:', error.message);
  console.error('Is the server running? Start it with: npm start');
  process.exit(1);
});
