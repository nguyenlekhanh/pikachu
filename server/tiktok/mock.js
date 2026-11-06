/**
 * Mock TikTok source.
 *
 * Always available so the game can be played and tested without a live stream.
 * It produces exactly the same normalized event objects as the TikFinity
 * adapter, so the engine cannot tell the difference. It is explicitly labelled
 * as mock data everywhere in the UI.
 */

import { EventEmitter } from 'node:events';
import { normalizeEvent } from './normalize.js';

const SAMPLE_USERS = [
  'LunaPlays',
  'MikeTheBoss',
  'PixelPaula',
  'CoachRay',
  'NinaStreams',
  'TurboTom',
  'ZoeZaps',
  'BigDanny',
];

const SAMPLE_GIFTS = [
  { giftId: 'mock-coin', giftName: 'Rose', diamondCount: 1 },
  { giftId: 'mock-small', giftName: 'Finger Heart', diamondCount: 5 },
  { giftId: 'mock-medium', giftName: 'Hand Hearts', diamondCount: 99 },
  { giftId: 'mock-large', giftName: 'Galaxy', diamondCount: 400 },
  { giftId: 'mock-super', giftName: 'Universe', diamondCount: 1500 },
];

let sequence = 0;
const nextId = () => {
  sequence += 1;
  return `${Date.now()}-${sequence}`;
};

export class MockAdapter extends EventEmitter {
  constructor({ logger = null, simulate = false, intervalMs = 9000, rng = Math.random } = {}) {
    super();
    this.logger = logger;
    this.rng = rng;
    this.simulate = simulate;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.eventsReceived = 0;
    this.lastEventAt = null;
    this.lastEvent = null;
    this.knownCells = () => [];
  }

  status() {
    return {
      source: 'mock',
      state: this.simulate ? 'simulating' : 'ready',
      connected: false,
      simulated: true,
      simulate: this.simulate,
      eventsReceived: this.eventsReceived,
      lastEventAt: this.lastEventAt,
      lastEvent: this.lastEvent,
    };
  }

  startSimulation() {
    this.simulate = true;
    this._schedule();
    this.emit('status', this.status());
  }

  stopSimulation() {
    this.simulate = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.emit('status', this.status());
  }

  setIntervalMs(value) {
    this.intervalMs = Math.max(3000, Number(value) || 9000);
    if (this.simulate) this._schedule();
  }

  _schedule() {
    clearTimeout(this.timer);
    if (!this.simulate) return;
    this.timer = setTimeout(() => {
      this._generate();
      this._schedule();
    }, this.intervalMs + this.rng() * 2500);
    if (this.timer.unref) this.timer.unref();
  }

  _generate() {
    const roll = this.rng();
    if (roll < 0.72) {
      const username = SAMPLE_USERS[Math.floor(this.rng() * SAMPLE_USERS.length)];
      const cells = this.knownCells();
      if (cells.length >= 2 && this.rng() < 0.8) {
        const pick = () => cells[Math.floor(this.rng() * cells.length)];
        const a = pick();
        const b = pick();
        this.comment(username, `${a} ${b}`);
      } else {
        const commands = ['TOP', 'ME', 'HELP', 'HINT', 'JOIN', 'RANK', 'A1 B1'];
        this.comment(username, commands[Math.floor(this.rng() * commands.length)]);
      }
      return;
    }
    const username = SAMPLE_USERS[Math.floor(this.rng() * SAMPLE_USERS.length)];
    const gift = SAMPLE_GIFTS[Math.floor(this.rng() * SAMPLE_GIFTS.length)];
    this.gift(username, gift);
  }

  /** Simulated chat comment using the real TikFinity envelope. */
  comment(username = 'TestViewer', text = 'A1 B1', extra = {}) {
    return this.injectRaw({
      event: 'chat',
      data: {
        comment: text,
        userId: extra.userId || `mock-${username}`,
        uniqueId: username,
        nickname: username,
        msgId: nextId(),
        createTime: Date.now(),
      },
    });
  }

  gift(username = 'TestViewer', gift = SAMPLE_GIFTS[1], extra = {}) {
    return this.injectRaw({
      event: 'gift',
      data: {
        giftId: gift.giftId,
        giftName: gift.giftName,
        diamondCount: gift.diamondCount,
        repeatCount: extra.repeatCount ?? 1,
        repeatEnd: extra.repeatEnd ?? true,
        userId: extra.userId || `mock-${username}`,
        uniqueId: username,
        nickname: username,
        msgId: nextId(),
        createTime: Date.now(),
      },
    });
  }

  follow(username = 'TestViewer') {
    return this.injectRaw({
      event: 'follow',
      data: { userId: `mock-${username}`, uniqueId: username, nickname: username },
    });
  }

  like(username = 'TestViewer', count = 5, totalLikeCount = 0) {
    return this.injectRaw({
      event: 'like',
      data: {
        userId: `mock-${username}`,
        uniqueId: username,
        nickname: username,
        likeCount: count,
        totalLikeCount,
        // Real TikFinity like events carry the room total and a timestamp.
        createTime: Date.now(),
      },
    });
  }

  share(username = 'TestViewer') {
    return this.injectRaw({
      event: 'share',
      data: { userId: `mock-${username}`, uniqueId: username, nickname: username, createTime: Date.now() },
    });
  }

  /** Inject an already-normalized admin test event through the same pipeline. */
  injectTest({ type = 'comment', username = 'TestViewer', text, giftId, giftName, coins, count, total } = {}) {
    if (type === 'gift') {
      return this.gift(
        username,
        {
          giftId: giftId || 'mock-small',
          giftName: giftName || 'Test Gift',
          diamondCount: Number(coins) || 5,
        },
        { repeatCount: Number(count) || 1 }
      );
    }
    if (type === 'follow') return this.follow(username);
    if (type === 'share') return this.share(username);
    if (type === 'like') return this.like(username, Number(count) || 5, Number(total) || 0);
    return this.comment(username, text || 'A1 B1');
  }

  injectRaw(message) {
    const event = normalizeEvent(message);
    if (!event) return null;
    this.eventsReceived += 1;
    this.lastEventAt = Date.now();
    this.lastEvent = {
      kind: event.kind,
      at: this.lastEventAt,
      summary:
        event.kind === 'chat'
          ? `${event.username}: ${event.text}`
          : event.kind === 'gift'
            ? `${event.username} sent ${event.giftName} x${event.repeatCount}`
            : event.kind,
    };
    this.emit('event', event);
    this.emit('status', this.status());
    return event;
  }

  stop() {
    this.stopSimulation();
  }
}

export { SAMPLE_GIFTS, SAMPLE_USERS };
