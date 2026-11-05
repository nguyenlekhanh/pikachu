import express from 'express';
import crypto from 'node:crypto';
import { config, GAME_DEFAULTS } from '../config.js';
import { buildGiftLegend } from '../gift-handler/legend.js';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * HTTP API.
 *
 * Public routes only expose what the overlay needs. Every /api/admin route needs
 * the admin token, which is read from the environment and never sent to the
 * public page.
 */
export function createApiRouter({ engine, store, tikfinity, mock, hub, ingest, music, transport = null, logger }) {
  const router = express.Router();
  const authAttempts = new Map();

  const publicTikTokStatus = () => {
    const tf = tikfinity.status();
    const connected = tf.connected;
    return {
      connected,
      state: tf.state,
      source: connected ? 'tikfinity' : mock.status().state === 'simulating' ? 'mock' : 'none',
      mode: connected ? 'TIKFINITY LIVE' : 'MOCK / OFFLINE',
      lastEventAt: connected ? tf.lastEventAt : mock.status().lastEventAt,
      eventsReceived: connected ? tf.eventsReceived : mock.status().eventsReceived,
    };
  };

  store.log({ category: 'system', message: 'API router ready.' });

  // -------------------------------------------------------------------- public

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      database: store.driver,
      game: engine.state.status,
      tiktok: tikfinity.status().state,
      clients: hub.clientCount,
      ts: Date.now(),
    });
  });

  router.get('/state', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      game: engine.snapshot(),
      settings: engine.publicSettings(),
      giftLegend: buildGiftLegend({ tiers: engine.settings.giftTiers, dir: config.giftIconDir }),
      leaderboard: engine.leaderboard(),
      tiktok: publicTikTokStatus(),
      stats: { players: store.countPlayers() },
      allowMousePlay: config.allowMousePlay,
      ts: Date.now(),
    });
  });

  router.get('/leaderboard', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(engine.leaderboard());
  });

  router.get('/settings', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(engine.publicSettings());
  });

  /**
   * Validated background music playlist. Missing files are already filtered
   * out here, so the overlay can never be pointed at a broken URL.
   */
  router.get('/music', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!music) return res.json({ tracks: [], skipped: [], warnings: ['Music library is not configured.'], enabled: false });
    res.json({
      ...music.snapshot(),
      enabled: config.music.enabled,
      transport: transport ? transport.status() : null,
    });
  });

  /**
   * Optional operator play: the streamer can click two tiles on the overlay
   * (or POST here) instead of commenting. Goes through the exact same engine
   * validation path as a chat move.
   */
  router.post('/operator/move', (req, res) => {
    if (!config.allowMousePlay) return res.status(403).json({ ok: false, error: 'Mouse play disabled' });
    const { a, b } = req.body || {};
    if (typeof a !== 'string' || typeof b !== 'string') {
      return res.status(400).json({ ok: false, error: 'Expected { a: \"A1\", b: \"B1\" }' });
    }
    const result = engine.handleChat({ userId: 'local:operator', username: 'Operator', text: `${a} ${b}` });
    res.json(result);
  });

  // --------------------------------------------------------------------- admin

  const requireAdmin = (req, res, next) => {
    const header = req.get('x-admin-token') || '';
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const provided = header || bearer;
    const ip = req.ip || 'local';
    const record = authAttempts.get(ip) || { count: 0, first: Date.now() };
    if (Date.now() - record.first > 60_000) {
      record.count = 0;
      record.first = Date.now();
    }
    if (record.count > 20) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a minute.' });
    }
    if (!provided || !safeEqual(provided, config.adminToken)) {
      record.count += 1;
      authAttempts.set(ip, record);
      return res.status(401).json({ ok: false, error: 'Invalid admin token' });
    }
    next();
  };

  router.post('/admin/auth', (req, res) => {
    const provided = (req.body && req.body.token) || '';
    if (!safeEqual(provided, config.adminToken)) {
      return res.status(401).json({ ok: false, error: 'Invalid admin token' });
    }
    res.json({ ok: true, defaultToken: config.adminTokenIsDefault });
  });

  router.use('/admin', requireAdmin);

  router.get('/admin/overview', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      game: engine.snapshot(),
      settings: engine.settings,
      publicSettings: engine.publicSettings(),
      leaderboard: engine.leaderboard(),
      tiktok: {
        tikfinity: tikfinity.status(),
        mock: mock.status(),
        public: publicTikTokStatus(),
      },
      gifts: store.listGifts(60),
      music: music ? { ...music.snapshot(), enabled: config.music.enabled } : null,
      musicTransport: transport ? transport.status() : null,
      logs: store.listLogs(80),
      stats: {
        players: store.countPlayers(),
        events: tikfinity.status().eventsReceived,
        clients: hub.clientCount,
        uptime: Math.round(process.uptime()),
        database: store.driver,
      },
      warnings: {
        defaultAdminToken: config.adminTokenIsDefault,
        stopGameEnabled: engine.settings.stopGameEnabled,
      },
      defaults: GAME_DEFAULTS,
    });
  });

  router.get('/admin/logs', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
    res.json({ logs: store.listLogs(limit) });
  });

  router.post('/admin/game', (req, res) => {
    const action = String((req.body && req.body.action) || '');
    let snapshot;
    switch (action) {
      case 'start':
        snapshot = engine.start();
        break;
      case 'pause':
        snapshot = engine.pause();
        break;
      case 'resume':
        snapshot = engine.resume();
        break;
      case 'restart':
        snapshot = engine.restart();
        break;
      case 'autoplay-on':
        snapshot = engine.setAutoPlay(true);
        break;
      case 'autoplay-off':
        snapshot = engine.setAutoPlay(false);
        break;
      case 'reset-leaderboard':
        engine.resetLeaderboard();
        store.log({ category: 'admin', message: 'Leaderboard reset from admin dashboard.' });
        snapshot = engine.snapshot();
        break;
      case 'reset-session': {
        // Full pre-LIVE reset: players, gift stats and progress are cleared in one
        // transaction, a new session id is issued and the fresh Level 1 board is
        // broadcast to every overlay. Settings/configuration are never touched.
        const result = engine.resetSession({ reason: 'admin' });
        if (!result.ok) {
          const status = result.reason === 'too-soon' ? 429 : 409;
          return res.status(status).json({ ok: false, error: result.error, reason: result.reason, retryInMs: result.retryInMs });
        }
        store.log({
          category: 'admin',
          message: `LIVE session reset: ${result.previousSessionId} -> ${result.sessionId}`,
          meta: {
            sessionId: result.sessionId,
            previousSessionId: result.previousSessionId,
            resetAt: result.startedAt,
            actor: result.actor,
          },
        });
        return res.json({
          ok: true,
          session: { id: result.sessionId, previousId: result.previousSessionId, startedAt: result.startedAt },
          game: result.game,
          leaderboard: result.leaderboard,
        });
      }
      case 'stop':
        snapshot = engine.stopGame('Admin stop');
        break;
      default:
        return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }
    store.log({ category: 'admin', message: `Game action: ${action}` });
    res.json({ ok: true, game: snapshot });
  });

  router.post('/admin/settings', (req, res) => {
    const patch = (req.body && req.body.settings) || {};
    const applied = engine.applySettings(patch);
    store.setConfig(applied);
    store.log({ category: 'admin', message: 'Settings updated.', meta: patch });
    res.json({ ok: true, settings: applied });
  });

  router.post('/admin/music', (req, res) => {
    const action = String((req.body && req.body.action) || 'reload');
    if (!music) return res.status(503).json({ ok: false, error: 'Music library is not configured' });

    // Skip to the next track in every overlay, respecting the playlist mode.
    if (action === 'next') {
      if (!transport) return res.status(503).json({ ok: false, error: 'Music transport is not configured' });
      const result = transport.next({ reason: 'admin' });
      if (!result.ok) {
        const status = result.empty || result.single ? 409 : 429;
        return res.status(status).json({ ...result, error: result.message });
      }
      return res.json(result);
    }

    if (action !== 'reload') return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    const playlist = music.reload();
    // Hot-swap the playlist in every open overlay without a page reload.
    hub.broadcast('music', playlist);
    store.log({
      category: 'system',
      message: `Music playlist reloaded: ${playlist.tracks.length} playable track(s), ${playlist.skipped.length} skipped.`,
    });
    res.json({ ok: true, music: playlist });
  });

  router.post('/admin/tiktok', (req, res) => {
    const action = String((req.body && req.body.action) || '');
    switch (action) {
      case 'connect':
        tikfinity.connect();
        break;
      case 'disconnect':
        tikfinity.disconnect();
        break;
      case 'set-url': {
        const url = String((req.body && req.body.url) || '').trim();
        if (!/^wss?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'URL must start with ws:// or wss://' });
        tikfinity.setUrl(url);
        tikfinity.connect();
        break;
      }
      case 'simulate-on':
        mock.startSimulation();
        store.log({ category: 'tiktok', message: 'Mock simulator started.' });
        break;
      case 'simulate-off':
        mock.stopSimulation();
        store.log({ category: 'tiktok', message: 'Mock simulator stopped.' });
        break;
      default:
        return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }
    res.json({ ok: true, tiktok: { tikfinity: tikfinity.status(), mock: mock.status() } });
  });

  router.post('/admin/test', (req, res) => {
    const body = req.body || {};
    const type = String(body.type || 'comment');
    const event = mock.injectTest({
      type,
      username: body.username || 'TestViewer',
      text: body.text,
      giftId: body.giftId,
      giftName: body.giftName,
      coins: body.coins,
      count: body.count,
    });
    if (!event) return res.status(400).json({ ok: false, error: 'Could not build test event' });
    store.log({
      category: 'test',
      message: `Test ${type} from ${body.username || 'TestViewer'}`,
      meta: { text: body.text, giftId: body.giftId, coins: body.coins },
    });
    res.json({ ok: true, event: { kind: event.kind, username: event.username, text: event.text } });
  });

  router.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    logger?.error?.('API error:', error.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  });

  return router;
}
