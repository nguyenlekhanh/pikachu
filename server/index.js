import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';

import { config, GAME_DEFAULTS } from './config.js';
import { logger } from './logger.js';
import { createStore } from './database/store.js';
import { GameEngine, playerKeyFromEvent } from './game-engine/engine.js';
import { TikFinityAdapter } from './tiktok/tikfinity.js';
import { MockAdapter } from './tiktok/mock.js';
import { Hub } from './websocket/hub.js';
import { MusicLibrary } from './music/playlist.js';
import { MusicTransport } from './music/transport.js';
import { createApiRouter } from './api/routes.js';
import { buildGiftLegend } from './gift-handler/legend.js';
import { AIService } from './ai/service.js';
import { AICohost } from './ai/cohost.js';

// ---------------------------------------------------------------- composition

const store = createStore({ dbFile: config.dbFile, logger });
const persisted = store.getConfig() || {};
const engine = new GameEngine({
  store,
  logger,
  settings: { ...GAME_DEFAULTS, ...persisted },
});

const music = new MusicLibrary({ dir: config.music.dir, logger });
const musicTransport = new MusicTransport({
  library: music,
  broadcast: (type, payload) => hub.broadcast(type, payload),
  store,
  logger,
  getShuffle: () => Boolean(engine.settings.musicShuffle),
});

// AI provider registry. Keys are encrypted with AI_SECRET/APP_SECRET; the
// ADMIN_TOKEN fallback is reported in the admin UI, never in logs.
const aiService = new AIService({
  store,
  aiConfig: config.ai,
  encryptionSecret: config.ai.encryptionSecret || config.adminToken,
  encryptionSource: config.ai.encryptionSecret ? config.ai.encryptionSource : 'ADMIN_TOKEN-derived',
  logger,
});

try {
  if (config.ai.openrouter.warning) logger.warn(`AI: ${config.ai.openrouter.warning}`);
  const imported = aiService.importOpenRouter();
  if (imported.ok && imported.created) logger.info('AI: OpenRouter imported from .env (inactive).');
} catch (error) {
  logger.warn('AI: OpenRouter import skipped:', error.message);
}

// Initial setup: if no provider has been chosen yet, make the imported
// OpenRouter provider active for Zappy. An existing admin selection always wins,
// and a later provider failure is never auto-switched away from.
if (!aiService.activeProvider()) {
  const preferred =
    aiService.list().find((provider) => provider.providerType === 'openrouter') || aiService.list()[0];
  if (preferred) {
    aiService.activate(preferred.id);
    logger.info(`AI: activated ${preferred.name} as the initial provider.`);
  }
}

const app = express();
const server = http.createServer(app);
const hub = new Hub({ server, logger });

const tikfinity = new TikFinityAdapter({
  url: config.tikfinity.url,
  reconnect: config.tikfinity.reconnect,
  logger,
});

const mock = new MockAdapter({
  logger,
  simulate: config.mock.simulate,
  intervalMs: config.mock.intervalMs,
});

// Zappy's AI co-host. It only observes chat/game events and broadcasts spoken
// lines through the existing mascot channel; it never mutates the game.
const aiCohost = new AICohost({
  ai: aiService,
  engine,
  hub,
  store,
  logger,
});

// ------------------------------------------------------------- engine -> overlay

const snapshotWithLegend = (snapshot) => ({
  ...snapshot,
  giftLegend: buildGiftLegend({ tiers: engine.settings.giftTiers, dir: config.giftIconDir }),
});

hub.cacheState(snapshotWithLegend(engine.snapshot()));

engine.on('state', (snapshot) => {
  const enriched = snapshotWithLegend(snapshot);
  hub.cacheState(enriched);
  hub.broadcast('state', enriched);
});
engine.on('fx', (fx) => hub.broadcast('fx', fx));
engine.on('mascot', (line) => hub.broadcast('mascot', line));
engine.on('feed', (entry) => hub.broadcast('feed', entry));
engine.on('notice', (notice) => hub.broadcast('notice', notice));
engine.on('leaderboard', (board) => hub.broadcast('leaderboard', board));
// Fired once per pre-LIVE reset; overlays drop the old feed before the fresh
// state snapshot arrives.
engine.on('session', (session) => hub.broadcast('session', session));
engine.on('overlay', (overlay) => hub.broadcast('overlay', overlay));

// ------------------------------------------------------------- events -> engine

let lastLikeFeedAt = 0;

function ingest(event, origin = 'tikfinity') {
  if (!event) return;
  try {
    switch (event.kind) {
      case 'chat':
        engine.handleChat(event);
        // Never awaited: AI filtering/batching must not block TikFinity or moves.
        aiCohost.observeChat(event);
        break;
      case 'gift':
        engine.handleGift(event);
        break;
      case 'follow': {
        store.ensurePlayer({
          id: playerKeyFromEvent(event),
          username: event.username,
          displayName: event.displayName,
        });
        engine.emit('feed', { kind: 'follow', username: event.username, text: `${event.username} followed!`, ts: Date.now() });
        engine.say('welcome', { priority: 1 });
        engine.emitLeaderboard();
        // Real follower, real name: the hosts acknowledge them immediately.
        aiCohost.observeFollow(event).catch(() => {});
        break;
      }
      case 'join': {
        engine.emit('feed', { kind: 'join', username: event.username, text: `${event.username} joined the room!`, ts: Date.now() });
        engine.say('welcome', { priority: 1 });
        break;
      }
      case 'subscribe': {
        engine.emit('feed', {
          kind: 'subscribe',
          username: event.username,
          text: `${event.username} subscribed! Thank you!`,
          ts: Date.now(),
        });
        engine.say('gift', { priority: 2 });
        break;
      }
      case 'like': {
        const now = Date.now();
        // Every like is recorded; the co-host aggregates them into one window so
        // a like storm never becomes one AI request per like.
        aiCohost.observeLike(event);
        if (now - lastLikeFeedAt > 8000) {
          lastLikeFeedAt = now;
          engine.emit('feed', {
            kind: 'like',
            username: event.username,
            text: `${event.username} liked x${event.likeCount}`,
            ts: now,
          });
        }
        break;
      }
      case 'share': {
        engine.emit('feed', { kind: 'share', username: event.username, text: `${event.username} shared the LIVE!`, ts: Date.now() });
        aiCohost.observeShare(event).catch(() => {});
        break;
      }
      case 'viewers':
        aiCohost.setViewers(event.viewerCount);
        hub.broadcast('viewers', { count: event.viewerCount, ts: Date.now() });
        break;
      case 'streamEnd':
        engine.emit('feed', { kind: 'system', text: 'The TikTok LIVE stream ended.', ts: Date.now() });
        store.log({ category: 'tiktok', message: 'Stream end event received.' });
        break;
      case 'unknown':
        logger.debug('Unhandled TikTok event:', event.event);
        break;
      default:
        break;
    }
  } catch (error) {
    logger.error(`Event handling failed (${origin}/${event.kind}):`, error.message);
    store.log({ category: 'error', level: 'error', message: `Event handling failed: ${error.message}` });
  }
}

tikfinity.on('event', (event) => ingest(event, 'tikfinity'));
tikfinity.on('status', (status) => {
  hub.broadcast('tiktok', {
    connected: status.connected,
    state: status.state,
    lastError: status.lastError,
    lastEventAt: status.lastEventAt,
    eventsReceived: status.eventsReceived,
  });
  store.log({
    category: 'tiktok',
    level: status.connected ? 'info' : 'warn',
    message: `TikFinity connection: ${status.state}${status.lastError ? ` (${status.lastError})` : ''}`,
  });
});
tikfinity.on('duplicate', () => {
  logger.debug('Duplicate TikFinity event dropped.');
});

mock.on('event', (event) => ingest(event, 'mock'));
mock.on('status', (status) => hub.broadcast('mock', status));

// A simulated comment needs to know real coordinates so auto-demo clicks work.
mock.knownCells = () => {
  const snapshot = engine.snapshot();
  if (!snapshot.grid) return [];
  const labels = [];
  for (let r = 1; r <= snapshot.rows; r += 1) {
    for (let c = 1; c <= snapshot.cols; c += 1) {
      if (snapshot.grid[r][c] !== null) labels.push(`${String.fromCharCode(64 + c)}${r}`);
    }
  }
  return labels;
};

// ------------------------------------------------------------------ websocket

// Overlays report the track they actually started, so the admin's NEXT MUSIC
// skips forward from what the streamer hears instead of a stale guess.
hub.on('music-current', (message) => {
  musicTransport.noteCurrent(message.payload || {});
});

// The overlay is the only place that knows whether speech really started,
// finished or failed. Zappy's status and watchdog depend on this telemetry.
hub.on('tts-state', (message) => {
  aiCohost.reportTts(message.payload || {});
});

hub.on('click', (message) => {
  if (!config.allowMousePlay) return;
  const { a, b } = message.payload || message || {};
  if (typeof a !== 'string' || typeof b !== 'string') return;
  engine.handleChat({ userId: 'local:operator', username: 'Operator', text: `${a} ${b}` });
});

// ------------------------------------------------------------------- http app

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '256kb' }));

app.use(
  '/api',
  createApiRouter({
    engine,
    store,
    tikfinity,
    mock,
    hub,
    ingest,
    music,
    transport: musicTransport,
    ai: aiService,
    cohost: aiCohost,
    logger,
  })
);

const clientDir = path.join(config.root, 'client');

// App assets are revalidated on every load (ETag/304). OBS browser sources and
// long-lived stream tabs must never keep running yesterday's overlay code.
const noCache = { maxAge: 0, etag: true, lastModified: true };
app.use('/css', express.static(path.join(clientDir, 'game', 'css'), noCache));
app.use('/js', express.static(path.join(clientDir, 'game', 'js'), noCache));
app.use('/shared', express.static(path.join(config.root, 'shared'), noCache));
// Streamer-owned music lives outside client/ so it is never bundled as app code.
app.use('/assets/music', express.static(config.music.dir, noCache));
app.use('/assets/gift_icon', express.static(config.giftIconDir, noCache));
app.use('/assets', express.static(path.join(clientDir, 'assets'), noCache));
app.use('/admin-assets', express.static(path.join(clientDir, 'admin'), noCache));

app.get('/vendor/phaser.min.js', (req, res) => {
  res.sendFile(path.join(config.root, 'node_modules', 'phaser', 'dist', 'phaser.min.js'));
});

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(clientDir, 'game', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(clientDir, 'admin', 'index.html'));
});

app.get('/obs', (req, res) => {
  // Explicit OBS entry point: identical overlay, transparent background.
  res.set('Cache-Control', 'no-store');
  res.redirect('/?obs=1');
});

app.use((req, res) => res.status(404).send('Not found'));

// --------------------------------------------------------------------- runtime

const tickHandle = setInterval(() => {
  try {
    engine.tick();
  } catch (error) {
    logger.error('Tick failed:', error.message);
  }
}, 1000);

logger.info(`Storage driver: ${store.driver}`);
logger.info(`Admin token: ${config.adminTokenIsDefault ? 'DEFAULT (change ADMIN_TOKEN in .env!)' : 'custom'}`);

const playlist = music.snapshot();
logger.info(
  `Music: ${playlist.tracks.length} track(s) in ${path.relative(config.root, config.music.dir) || config.music.dir}` +
    `${config.music.enabled ? '' : ' (MUSIC_ENABLED=false)'}`
);

const aiProviders = aiService.list();
const activeAi = aiProviders.find((provider) => provider.isActive);
logger.info(
  `AI providers: ${aiProviders.length} saved, active: ${activeAi ? activeAi.name : 'none'}` +
    `${aiService.encryptionWarning() ? ' (AI_SECRET not set)' : ''}`
);
logger.info(
  `AI co-host: ${aiCohost.enabled() ? 'enabled' : 'disabled'}, ` +
    `${aiCohost.alwaysActive() ? 'always active' : 'chat driven'}, ` +
    `watchdog ${aiCohost.watchdogOn() ? 'on' : 'off'}, ` +
    `${activeAi ? `${activeAi.name} · ${activeAi.model}` : 'no active provider'}`
);

engine.start();

if (config.tikfinity.enabled) {
  tikfinity.connect();
} else {
  logger.info('TikFinity connection disabled by TIKFINITY_ENABLED=false');
}

if (config.mock.simulate) mock.startSimulation();

server.listen(config.port, config.host, () => {
  const boundPort = server.address().port;
  logger.info('------------------------------------------------------------');
  logger.info(`PIKACHU LIVE US V1 running on port ${boundPort}`);
  logger.info(`  Overlay (OBS)   : http://localhost:${boundPort}/`);
  logger.info(`  Admin dashboard : http://localhost:${boundPort}/admin`);
  logger.info(`  WebSocket       : ws://localhost:${boundPort}/ws`);
  logger.info(`  TikFinity URL   : ${config.tikfinity.url}`);
  logger.info('------------------------------------------------------------');
});

// ------------------------------------------------------------------- shutdown

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down...`);
  clearInterval(tickHandle);
  mock.stop();
  tikfinity.disconnect();
  aiCohost.close();
  hub.close();
  store.log({ category: 'system', message: `Server stopped (${signal}).` });
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  store.log({ category: 'error', level: 'error', message: `Unhandled rejection: ${reason}` });
});

export { app, server, engine, store, hub, tikfinity, mock };
