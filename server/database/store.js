/**
 * Storage facade.
 *
 * The engine only talks to this interface, so the deployment can start on
 * SQLite and move to another database later without touching game logic.
 *
 *   getPlayer / ensurePlayer / addScore / addAttempt / addGift
 *   listTop / listTopGifters / listMostActive / rankOf / countPlayers
 *   resetLeaderboard / getConfig / setConfig / log / listLogs
 *
 * All methods are synchronous, which is what makes a move atomic: a move is
 * validated and applied inside one synchronous turn of the event loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SqliteStore } from './sqlite.js';

const nowTs = () => Date.now();

function blankPlayer(id, username, displayName) {
  const ts = nowTs();
  return {
    id: String(id),
    username: username || 'viewer',
    displayName: displayName || username || 'viewer',
    score: 0,
    matches: 0,
    attempts: 0,
    giftCoins: 0,
    giftCount: 0,
    joinedAt: ts,
    lastSeen: ts,
  };
}

export class MemoryStore {
  constructor() {
    this.driver = 'memory';
    this.players = new Map();
    this.configValue = null;
    this.logs = [];
    this.giftLibrary = new Map();
    this.providers = [];
    this.logSeq = 0;
  }

  init() {}

  getPlayer(id) {
    const player = this.players.get(String(id));
    return player ? { ...player } : null;
  }

  ensurePlayer({ id, username, displayName }) {
    const key = String(id);
    let player = this.players.get(key);
    if (!player) {
      player = blankPlayer(key, username, displayName);
      this.players.set(key, player);
    } else {
      if (username) player.username = username;
      if (displayName) player.displayName = displayName;
      player.lastSeen = nowTs();
    }
    return { ...player };
  }

  savePlayer(player) {
    this.players.set(String(player.id), { ...player, lastSeen: nowTs() });
    return { ...this.players.get(String(player.id)) };
  }

  addScore(id, { points = 0, matches = 0, attempts = 0 } = {}) {
    const player = this.players.get(String(id));
    if (!player) return null;
    player.score = Math.max(0, player.score + points);
    player.matches += matches;
    player.attempts += attempts;
    player.lastSeen = nowTs();
    return { ...player };
  }

  addAttempt(id) {
    const player = this.players.get(String(id));
    if (!player) return null;
    player.attempts += 1;
    player.lastSeen = nowTs();
    return { ...player };
  }

  addGift(id, { coins = 0, count = 1 } = {}) {
    const player = this.players.get(String(id));
    if (!player) return null;
    player.giftCoins += Math.max(0, Math.round(coins));
    player.giftCount += Math.max(0, Math.round(count));
    player.lastSeen = nowTs();
    return { ...player };
  }

  _sorted(metric) {
    const key = metric === 'gifts' ? 'giftCoins' : metric === 'matches' ? 'matches' : 'score';
    return [...this.players.values()]
      .filter((player) => player[key] > 0)
      .sort((a, b) => b[key] - a[key] || b.matches - a.matches || a.lastSeen - b.lastSeen);
  }

  listTop(limit = 10) {
    return this._sorted('score').slice(0, limit).map((p) => ({ ...p }));
  }

  listTopGifters(limit = 10) {
    return this._sorted('gifts').slice(0, limit).map((p) => ({ ...p }));
  }

  listMostActive(limit = 10) {
    return this._sorted('matches').slice(0, limit).map((p) => ({ ...p }));
  }

  rankOf(id, metric = 'score') {
    const list = this._sorted(metric);
    const index = list.findIndex((player) => player.id === String(id));
    return index === -1 ? null : index + 1;
  }

  countPlayers() {
    return this.players.size;
  }

  resetLeaderboard() {
    for (const player of this.players.values()) {
      player.score = 0;
      player.matches = 0;
      player.attempts = 0;
      player.giftCoins = 0;
      player.giftCount = 0;
    }
  }

  /**
   * Wipe session data for a brand new LIVE: every player row and the gift
   * statistics collected during the demo/session. Configuration (this.configValue)
   * and the audit log are deliberately kept.
   */
  resetSession() {
    this.players.clear();
    this.giftLibrary.clear();
    // Session/demo log entries (test events included). The reset entry itself is
    // written by the caller after this returns, so it survives.
    this.logs = [];
  }

  getConfig() {
    return this.configValue ? JSON.parse(JSON.stringify(this.configValue)) : null;
  }

  setConfig(value) {
    this.configValue = JSON.parse(JSON.stringify(value));
    return this.getConfig();
  }

  log({ level = 'info', category = 'general', message = '', meta = null } = {}) {
    this.logSeq += 1;
    this.logs.push({ id: this.logSeq, ts: nowTs(), level, category, message, meta });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    return this.logs[this.logs.length - 1];
  }

  listLogs(limit = 100) {
    return this.logs.slice(-limit).reverse();
  }

  recordGift({ giftId, name, coins }) {
    const key = String(giftId);
    const entry = this.giftLibrary.get(key) || { giftId: key, name: name || `Gift ${key}`, coins: 0, count: 0 };
    entry.name = name || entry.name;
    entry.coins = coins ?? entry.coins;
    entry.count += 1;
    entry.lastSeen = nowTs();
    this.giftLibrary.set(key, entry);
    return { ...entry };
  }

  listGifts(limit = 100) {
    return [...this.giftLibrary.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  }

  // ------------------------------------------------------------- ai providers

  listProviders() {
    return this.providers.map((row) => ({ ...row }));
  }

  getProvider(id) {
    const row = this.providers.find((entry) => entry.id === String(id));
    return row ? { ...row } : null;
  }

  createProvider(data) {
    const row = { ...data, id: String(data.id), isActive: false };
    this.providers.push(row);
    return { ...row };
  }

  updateProvider(id, patch = {}) {
    const row = this.providers.find((entry) => entry.id === String(id));
    if (!row) return null;
    Object.assign(row, patch, { id: row.id, updatedAt: patch.updatedAt || nowTs() });
    return { ...row };
  }

  deleteProvider(id) {
    const before = this.providers.length;
    this.providers = this.providers.filter((entry) => entry.id !== String(id));
    return this.providers.length < before;
  }

  setActiveProvider(id) {
    for (const row of this.providers) {
      row.isActive = Boolean(id) && row.id === String(id);
      if (row.isActive) row.updatedAt = nowTs();
    }
    return id ? this.getProvider(id) : null;
  }

  noteProviderTest(id, { status = null, testedAt = nowTs(), error = null } = {}) {
    const row = this.providers.find((entry) => entry.id === String(id));
    if (!row) return null;
    row.lastTestStatus = status;
    row.lastTestedAt = testedAt;
    row.lastError = error;
    row.updatedAt = nowTs();
    return { ...row };
  }

  close() {}
}

/** JSON file fallback used only when the SQLite driver cannot load. */
export class JsonStore extends MemoryStore {
  constructor(file) {
    super();
    this.driver = 'json';
    this.file = file;
    this._timer = null;
  }

  init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const player of data.players || []) this.players.set(String(player.id), player);
        this.configValue = data.config || null;
        this.logs = data.logs || [];
        this.logSeq = data.logSeq || this.logs.length;
        for (const gift of data.gifts || []) this.giftLibrary.set(String(gift.giftId), gift);
        this.providers = Array.isArray(data.providers) ? data.providers : [];
      } catch (error) {
        console.error('JSON store could not be read, starting fresh:', error.message);
      }
    }
    return this;
  }

  _touch() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 400);
  }

  flush() {
    const payload = {
      players: [...this.players.values()],
      config: this.configValue,
      logs: this.logs.slice(-500),
      logSeq: this.logSeq,
      gifts: [...this.giftLibrary.values()],
      providers: this.providers,
    };
    try {
      fs.writeFileSync(this.file, JSON.stringify(payload));
    } catch (error) {
      console.error('JSON store write failed:', error.message);
    }
  }

  addScore(...args) { const r = super.addScore(...args); this._touch(); return r; }
  addAttempt(...args) { const r = super.addAttempt(...args); this._touch(); return r; }
  addGift(...args) { const r = super.addGift(...args); this._touch(); return r; }
  ensurePlayer(...args) { const r = super.ensurePlayer(...args); this._touch(); return r; }
  setConfig(...args) { const r = super.setConfig(...args); this._touch(); return r; }
  resetLeaderboard(...args) { const r = super.resetLeaderboard(...args); this._touch(); return r; }
  resetSession(...args) {
    const r = super.resetSession(...args);
    this._touch();
    this.flush();
    return r;
  }
  recordGift(...args) { const r = super.recordGift(...args); this._touch(); return r; }
  log(...args) { const r = super.log(...args); this._touch(); return r; }
  createProvider(...args) { const r = super.createProvider(...args); this._touch(); return r; }
  updateProvider(...args) { const r = super.updateProvider(...args); this._touch(); return r; }
  deleteProvider(...args) { const r = super.deleteProvider(...args); this._touch(); return r; }
  setActiveProvider(...args) { const r = super.setActiveProvider(...args); this._touch(); return r; }
  noteProviderTest(...args) { const r = super.noteProviderTest(...args); this._touch(); return r; }

  close() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.flush();
  }
}

export function createStore({ dbFile, logger } = {}) {
  if (dbFile) {
    try {
      const store = new SqliteStore(dbFile);
      store.init();
      return store;
    } catch (error) {
      logger?.warn?.('SQLite unavailable, falling back to JSON storage:', error.message);
      if (logger) logger.error('SQLite driver failed to load:', error.message);
    }
    try {
      const store = new JsonStore(`${dbFile}.json`);
      store.init();
      return store;
    } catch (error) {
      logger?.error?.('JSON storage failed too, running in memory only:', error.message);
    }
  }
  const store = new MemoryStore();
  store.init();
  return store;
}

export { blankPlayer };
