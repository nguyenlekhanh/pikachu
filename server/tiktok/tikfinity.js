/**
 * TikFinity Event API adapter.
 *
 * Documented endpoint: ws://localhost:21213/ (TikFinity Desktop App must run on
 * the same computer). Messages arrive as:
 *   { "event": "chat" | "gift" | "share" | "follow" | "like" | "roomUser" | "subscribe",
 *     "data": { ...TikTok-Live-Connector shaped payload... } }
 *
 * We never invent a different protocol and we never report "connected" until the
 * socket is actually open.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { chatDedupeKey, normalizeEvent } from './normalize.js';
import { giftDedupeKey } from '../gift-handler/gifts.js';

const BACKOFF = [2000, 4000, 8000, 15000, 30000];

/**
 * Stable dedupe key for one delivered event. TikTok/TikFinity redelivers follows
 * and shares after a reconnect, and a redelivered interaction must not become a
 * second welcome or a second thank-you. Likes are deduplicated by the AI
 * tracker instead, because the same viewer may legitimately like repeatedly.
 */
const interactionDedupeKey = (event) =>
  `${event.kind}|${event.userId || event.username || ''}|${event.createTime || ''}`;

const dedupeKeyFor = (event) => {
  if (event.kind === 'chat') return chatDedupeKey(event);
  if (event.kind === 'gift') return giftDedupeKey(event);
  if (event.kind === 'follow' || event.kind === 'share') return interactionDedupeKey(event);
  return null;
};

export class TikFinityAdapter extends EventEmitter {
  constructor({ url = 'ws://127.0.0.1:21213/', reconnect = true, logger = null } = {}) {
    super();
    this.url = url;
    this.reconnect = reconnect;
    this.logger = logger;
    this.ws = null;
    this.shouldRun = false;
    this.state = 'idle';
    this.attempt = 0;
    this.reconnectTimer = null;
    this.connectedAt = null;
    this.lastEventAt = null;
    this.lastError = null;
    this.eventsReceived = 0;
    this.eventsDropped = 0;
    this.lastEvent = null;
    this.seen = new Map();
  }

  status() {
    return {
      source: 'tikfinity',
      state: this.state,
      url: this.url,
      connected: this.state === 'connected',
      reconnect: this.reconnect,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      eventsReceived: this.eventsReceived,
      eventsDropped: this.eventsDropped,
      lastError: this.lastError,
      lastEvent: this.lastEvent,
      attempt: this.attempt,
    };
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.emit('status', { ...this.status(), ...extra });
  }

  connect() {
    this.shouldRun = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this.status();
    }
    this._open();
    return this.status();
  }

  _open() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._setState(this.attempt > 0 ? 'reconnecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 6000 });
    } catch (error) {
      this.lastError = error.message;
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.connectedAt = Date.now();
      this.lastError = null;
      this.logger?.info?.(`TikFinity connected: ${this.url}`);
      this._setState('connected');
    });

    ws.on('message', (buffer) => {
      this._handlePayload(buffer);
    });

    ws.on('error', (error) => {
      this.lastError = error.message;
      this.logger?.warn?.(`TikFinity socket error: ${error.message}`);
    });

    ws.on('close', (code) => {
      this.ws = null;
      this.connectedAt = null;
      if (!this.shouldRun) {
        this._setState('disconnected');
        return;
      }
      this.lastError = this.lastError || `Connection closed (code ${code})`;
      this.logger?.warn?.('TikFinity disconnected, retrying...');
      this._setState('reconnecting');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (!this.shouldRun || !this.reconnect) {
      if (!this.reconnect) this._setState('disconnected');
      return;
    }
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  _handlePayload(buffer) {
    let parsed;
    try {
      const text = typeof buffer === 'string' ? buffer : buffer.toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      this.eventsDropped += 1;
      this.emit('invalid', { reason: 'not-json' });
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      const event = normalizeEvent(message);
      if (!event) {
        this.eventsDropped += 1;
        continue;
      }

      const key = dedupeKeyFor(event);
      if (key) {
        const now = Date.now();
        const seenAt = this.seen.get(key);
        if (seenAt && now - seenAt < 5 * 60 * 1000) {
          this.eventsDropped += 1;
          this.emit('duplicate', event);
          continue;
        }
        this.seen.set(key, now);
        if (this.seen.size > 4000) {
          for (const [k, ts] of this.seen) if (now - ts > 5 * 60 * 1000) this.seen.delete(k);
        }
      }

      this.eventsReceived += 1;
      this.lastEventAt = Date.now();
      this.lastEvent = { kind: event.kind, at: this.lastEventAt, summary: this._summary(event) };
      this.emit('event', event);
    }
  }

  _summary(event) {
    if (event.kind === 'chat') return `${event.username}: ${event.text}`;
    if (event.kind === 'gift') return `${event.username} sent ${event.giftName} x${event.repeatCount}`;
    return `${event.kind}${event.username ? `: ${event.username}` : ''}`;
  }

  injectRaw(message) {
    this._handlePayload(typeof message === 'string' ? message : JSON.stringify(message));
  }

  setUrl(url) {
    this.url = url;
    this.disconnect();
    if (this.shouldRun) this.connect();
    return this.status();
  }

  disconnect() {
    this.shouldRun = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connectedAt = null;
    this._setState('disconnected');
    return this.status();
  }
}
