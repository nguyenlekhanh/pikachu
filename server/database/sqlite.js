/**
 * SQLite driver for PIKACHU LIVE US V1.
 *
 * Migrations are applied by bumping `user_version`, so an existing database can
 * be upgraded in place during a livestream restart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT,
    score INTEGER NOT NULL DEFAULT 0,
    matches INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    gift_coins INTEGER NOT NULL DEFAULT 0,
    gift_count INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_players_score ON players(score DESC);
  CREATE INDEX IF NOT EXISTS idx_players_gifts ON players(gift_coins DESC);
  CREATE INDEX IF NOT EXISTS idx_players_matches ON players(matches DESC);

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT,
    category TEXT,
    message TEXT,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(ts DESC);

  CREATE TABLE IF NOT EXISTS gifts (
    gift_id TEXT PRIMARY KEY,
    name TEXT,
    coins INTEGER,
    count INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS ai_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    encrypted_api_key TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    last_test_status TEXT,
    last_tested_at INTEGER,
    last_error TEXT,
    source TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_providers_active ON ai_providers(is_active) WHERE is_active = 1;
  `,
];

function toProvider(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    model: row.model,
    encryptedApiKey: row.encrypted_api_key,
    isActive: Boolean(row.is_active),
    lastTestStatus: row.last_test_status,
    lastTestedAt: row.last_tested_at,
    lastError: row.last_error,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPlayer(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    score: row.score,
    matches: row.matches,
    attempts: row.attempts,
    giftCoins: row.gift_coins,
    giftCount: row.gift_count,
    joinedAt: row.joined_at,
    lastSeen: row.last_seen,
  };
}

export class SqliteStore {
  constructor(file) {
    this.driver = 'sqlite';
    this.file = file;
    this.insertsSincePrune = 0;
  }

  init() {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Database(this.file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.prepare();
    return this;
  }

  migrate() {
    const current = this.db.pragma('user_version', { simple: true });
    if (current < MIGRATIONS.length) {
      for (let version = current; version < MIGRATIONS.length; version += 1) {
        this.db.exec(MIGRATIONS[version]);
      }
      this.db.pragma(`user_version = ${MIGRATIONS.length}`);
    }
  }

  prepare() {
    this.stmts = {
      getPlayer: this.db.prepare('SELECT * FROM players WHERE id = ?'),
      insertPlayer: this.db.prepare(`
        INSERT INTO players (id, username, display_name, joined_at, last_seen)
        VALUES (@id, @username, @displayName, @joinedAt, @lastSeen)
      `),
      touchPlayer: this.db.prepare(
        'UPDATE players SET username = ?, display_name = ?, last_seen = ? WHERE id = ?'
      ),
      addScore: this.db.prepare(`
        UPDATE players SET score = MAX(0, score + ?), matches = matches + ?, attempts = attempts + ?, last_seen = ?
        WHERE id = ?
      `),
      addAttempt: this.db.prepare(
        'UPDATE players SET attempts = attempts + 1, last_seen = ? WHERE id = ?'
      ),
      addGift: this.db.prepare(`
        UPDATE players SET gift_coins = gift_coins + ?, gift_count = gift_count + ?, last_seen = ?
        WHERE id = ?
      `),
      top: this.db.prepare(
        'SELECT * FROM players WHERE score > 0 ORDER BY score DESC, matches DESC, last_seen ASC LIMIT ?'
      ),
      gifter: this.db.prepare(
        'SELECT * FROM players WHERE gift_coins > 0 ORDER BY gift_coins DESC, gift_count DESC, last_seen ASC LIMIT ?'
      ),
      active: this.db.prepare(
        'SELECT * FROM players WHERE matches > 0 ORDER BY matches DESC, score DESC, last_seen ASC LIMIT ?'
      ),
      rank: this.db.prepare('SELECT COUNT(*) + 1 AS rank FROM players WHERE score > ?'),
      rankGifts: this.db.prepare('SELECT COUNT(*) + 1 AS rank FROM players WHERE gift_coins > ?'),
      rankMatches: this.db.prepare('SELECT COUNT(*) + 1 AS rank FROM players WHERE matches > ?'),
      count: this.db.prepare('SELECT COUNT(*) AS total FROM players'),
      reset: this.db.prepare(
        'UPDATE players SET score = 0, matches = 0, attempts = 0, gift_coins = 0, gift_count = 0'
      ),
      deletePlayers: this.db.prepare('DELETE FROM players'),
      deleteGifts: this.db.prepare('DELETE FROM gifts'),
      deleteLogs: this.db.prepare('DELETE FROM event_log'),
      getConfig: this.db.prepare("SELECT value FROM config WHERE key = 'game'"),
      setConfig: this.db.prepare(`
        INSERT INTO config (key, value, updated_at) VALUES ('game', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `),
      log: this.db.prepare(
        'INSERT INTO event_log (ts, level, category, message, meta) VALUES (?, ?, ?, ?, ?)'
      ),
      logs: this.db.prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT ?'),
      pruneLogs: this.db.prepare(
        'DELETE FROM event_log WHERE id <= (SELECT MAX(id) - 4000 FROM event_log)'
      ),
      recordGift: this.db.prepare(`
        INSERT INTO gifts (gift_id, name, coins, count, last_seen) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(gift_id) DO UPDATE SET
          name = COALESCE(excluded.name, gifts.name),
          coins = COALESCE(excluded.coins, gifts.coins),
          count = gifts.count + 1,
          last_seen = excluded.last_seen
      `),
      listGifts: this.db.prepare('SELECT * FROM gifts ORDER BY count DESC LIMIT ?'),
      listProviders: this.db.prepare('SELECT * FROM ai_providers ORDER BY created_at ASC'),
      getProvider: this.db.prepare('SELECT * FROM ai_providers WHERE id = ?'),
      insertProvider: this.db.prepare(`
        INSERT INTO ai_providers
          (id, name, provider_type, base_url, model, encrypted_api_key, is_active,
           last_test_status, last_tested_at, last_error, source, created_at, updated_at)
        VALUES
          (@id, @name, @providerType, @baseUrl, @model, @encryptedApiKey, 0,
           NULL, NULL, NULL, @source, @createdAt, @updatedAt)
      `),
      updateProvider: this.db.prepare(`
        UPDATE ai_providers SET name = ?, provider_type = ?, base_url = ?, model = ?,
          encrypted_api_key = ?, updated_at = ? WHERE id = ?
      `),
      deleteProvider: this.db.prepare('DELETE FROM ai_providers WHERE id = ?'),
      clearActiveProviders: this.db.prepare('UPDATE ai_providers SET is_active = 0'),
      activateProvider: this.db.prepare('UPDATE ai_providers SET is_active = 1, updated_at = ? WHERE id = ?'),
      noteProviderTest: this.db.prepare(`
        UPDATE ai_providers SET last_test_status = ?, last_tested_at = ?, last_error = ?, updated_at = ? WHERE id = ?
      `),
    };
  }

  getPlayer(id) {
    return toPlayer(this.stmts.getPlayer.get(String(id)));
  }

  ensurePlayer({ id, username, displayName }) {
    const key = String(id);
    const existing = this.stmts.getPlayer.get(key);
    const ts = Date.now();
    if (!existing) {
      this.stmts.insertPlayer.run({
        id: key,
        username: username || 'viewer',
        displayName: displayName || username || 'viewer',
        joinedAt: ts,
        lastSeen: ts,
      });
      return toPlayer(this.stmts.getPlayer.get(key));
    }
    this.stmts.touchPlayer.run(username || existing.username, displayName || existing.display_name || existing.username, ts, key);
    return toPlayer(this.stmts.getPlayer.get(key));
  }

  savePlayer(player) {
    this.ensurePlayer({
      id: player.id,
      username: player.username,
      displayName: player.displayName,
    });
    return this.getPlayer(player.id);
  }

  addScore(id, { points = 0, matches = 0, attempts = 0 } = {}) {
    this.stmts.addScore.run(Math.round(points), matches, attempts, Date.now(), String(id));
    return this.getPlayer(id);
  }

  addAttempt(id) {
    this.stmts.addAttempt.run(Date.now(), String(id));
    return this.getPlayer(id);
  }

  addGift(id, { coins = 0, count = 1 } = {}) {
    this.stmts.addGift.run(Math.max(0, Math.round(coins)), Math.max(0, Math.round(count)), Date.now(), String(id));
    return this.getPlayer(id);
  }

  listTop(limit = 10) {
    return this.stmts.top.all(limit).map(toPlayer);
  }

  listTopGifters(limit = 10) {
    return this.stmts.gifter.all(limit).map(toPlayer);
  }

  listMostActive(limit = 10) {
    return this.stmts.active.all(limit).map(toPlayer);
  }

  rankOf(id, metric = 'score') {
    const player = this.getPlayer(id);
    if (!player) return null;
    const stmt = metric === 'gifts' ? this.stmts.rankGifts : metric === 'matches' ? this.stmts.rankMatches : this.stmts.rank;
    const value = metric === 'gifts' ? player.giftCoins : metric === 'matches' ? player.matches : player.score;
    return stmt.get(value).rank;
  }

  countPlayers() {
    return this.stmts.count.get().total;
  }

  resetLeaderboard() {
    this.stmts.reset.run();
  }

  /**
   * Clear all session-scoped rows in one transaction.
   *
   * `config` (game/gift/music/TikFinity settings, gift mappings, database
   * schema) is kept. Session data — players, gift statistics and the event log
   * (demo/test entries) — is removed; the caller writes the fresh reset entry
   * immediately after, so the audit trail starts with the new session.
   *
   * If any statement throws, better-sqlite3 rolls the whole transaction back and
   * the previous session survives untouched.
   */
  resetSession() {
    const run = this.db.transaction(() => {
      this.stmts.deletePlayers.run();
      this.stmts.deleteGifts.run();
      this.stmts.deleteLogs.run();
    });
    run();
  }

  getConfig() {
    const row = this.stmts.getConfig.get();
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  setConfig(value) {
    this.stmts.setConfig.run(JSON.stringify(value), Date.now());
    return this.getConfig();
  }

  log({ level = 'info', category = 'general', message = '', meta = null } = {}) {
    const info = this.stmts.log.run(Date.now(), level, category, message, meta ? JSON.stringify(meta) : null);
    this.insertsSincePrune += 1;
    if (this.insertsSincePrune > 200) {
      this.insertsSincePrune = 0;
      this.stmts.pruneLogs.run();
    }
    return { id: Number(info.lastInsertRowid), ts: Date.now(), level, category, message, meta };
  }

  listLogs(limit = 100) {
    return this.stmts.logs.all(limit).map((row) => ({
      id: row.id,
      ts: row.ts,
      level: row.level,
      category: row.category,
      message: row.message,
      meta: row.meta ? JSON.parse(row.meta) : null,
    }));
  }

  recordGift({ giftId, name, coins }) {
    this.stmts.recordGift.run(String(giftId), name || null, Number.isFinite(coins) ? coins : null, Date.now());
    return this.listGifts(200).find((gift) => gift.gift_id === String(giftId)) || null;
  }

  listGifts(limit = 100) {
    return this.stmts.listGifts.all(limit).map((row) => ({
      giftId: row.gift_id,
      name: row.name,
      coins: row.coins,
      count: row.count,
      lastSeen: row.last_seen,
    }));
  }

  // ------------------------------------------------------------- ai providers

  listProviders() {
    return this.stmts.listProviders.all().map(toProvider);
  }

  getProvider(id) {
    return toProvider(this.stmts.getProvider.get(String(id)));
  }

  createProvider(data) {
    this.stmts.insertProvider.run({
      id: String(data.id),
      name: data.name,
      providerType: data.providerType,
      baseUrl: data.baseUrl,
      model: data.model,
      encryptedApiKey: data.encryptedApiKey || null,
      source: data.source || 'manual',
      createdAt: data.createdAt || Date.now(),
      updatedAt: data.updatedAt || Date.now(),
    });
    return this.getProvider(data.id);
  }

  updateProvider(id, patch = {}) {
    this.stmts.updateProvider.run(
      patch.name,
      patch.providerType,
      patch.baseUrl,
      patch.model,
      patch.encryptedApiKey ?? null,
      patch.updatedAt || Date.now(),
      String(id)
    );
    return this.getProvider(id);
  }

  deleteProvider(id) {
    const info = this.stmts.deleteProvider.run(String(id));
    return info.changes > 0;
  }

  /** Exactly one active provider, enforced by a unique partial index too. */
  setActiveProvider(id) {
    const run = this.db.transaction(() => {
      this.stmts.clearActiveProviders.run();
      if (id) this.stmts.activateProvider.run(Date.now(), String(id));
    });
    run();
    return id ? this.getProvider(id) : null;
  }

  noteProviderTest(id, { status = null, testedAt = Date.now(), error = null } = {}) {
    this.stmts.noteProviderTest.run(status, testedAt, error, Date.now(), String(id));
    return this.getProvider(id);
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
  }
}
