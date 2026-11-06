/**
 * TikTok interaction tracking for the two AI hosts: likes, follows and shares.
 *
 * This module holds no timers, never calls the AI and never touches the overlay.
 * It only aggregates real TikFinity events, deduplicates redeliveries and
 * decides when a like milestone is due, so the co-host owns all scheduling and
 * every decision here is deterministic and cheap to unit test.
 */

/** Milestones are fixed points; the Admin "minimum" setting filters them. */
export const LIKE_MILESTONES = [100, 500, 1000, 5000, 10000];

/** Probability that one interaction earns an AI line. */
export const EVENT_FREQUENCY = { low: 0.15, normal: 0.35, high: 0.6 };

export const LIKE_WINDOW = { minSec: 2, maxSec: 120, fallbackSec: 5 };
export const LIKE_MIN_MILESTONE = { min: 10, max: 100000, fallback: 100 };

const LIKE_DEDUPE_MS = 60000;
const FOLLOW_DEDUPE_MS = 30 * 60 * 1000;
const SHARE_DEDUPE_MS = 60000;
const MAX_TRACKED = 2000;

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Milestones at or above the configured minimum, oldest first. */
export function milestonesFor(minMilestone = LIKE_MIN_MILESTONE.fallback) {
  const floor = num(minMilestone, LIKE_MIN_MILESTONE.fallback);
  return LIKE_MILESTONES.filter((value) => value >= floor);
}

export class InteractionTracker {
  constructor({ now = () => Date.now(), windowMs = 5000, minMilestone = 100 } = {}) {
    this.now = now;
    this.windowMs = Math.max(1000, num(windowMs, 5000));
    this.minMilestone = Math.max(1, num(minMilestone, 100));
    this.pending = null;
    this.sessionLikes = 0;
    this.roomTotal = 0;
    this.celebrated = new Set();
    this.likeSeen = new Map();
    this.followSeen = new Map();
    this.shareSeen = new Map();
    this.lastBatch = null;
    this.counters = {
      likeEvents: 0,
      likes: 0,
      batches: 0,
      followEvents: 0,
      shareEvents: 0,
      duplicates: 0,
      milestones: 0,
    };
  }

  setOptions({ windowMs, minMilestone } = {}) {
    if (Number.isFinite(Number(windowMs)) && Number(windowMs) >= 1000) this.windowMs = Number(windowMs);
    if (Number.isFinite(Number(minMilestone)) && Number(minMilestone) > 0) this.minMilestone = Number(minMilestone);
  }

  /** TikTok's room total when it is reported, otherwise what we have counted. */
  get totalLikes() {
    return Math.max(this.sessionLikes, this.roomTotal);
  }

  /** Milliseconds until the current like window closes, or null when empty. */
  dueInMs() {
    if (!this.pending) return null;
    return Math.max(0, this.pending.firstAt + this.windowMs - this.now());
  }

  prune(map, ttlMs, now) {
    if (map.size <= MAX_TRACKED) return;
    for (const [key, at] of map) {
      if (now - at > ttlMs) map.delete(key);
    }
  }

  /**
   * Record one real like event. Returns immediately: the caller only schedules a
   * flush, so a burst of likes can never reach the AI one call at a time.
   */
  addLike(event = {}) {
    const now = this.now();
    const count = Math.max(1, Math.floor(num(event.likeCount, 1)));
    const user = String(event.userId || event.username || '').slice(0, 64);
    // Deduplicate only what the event can actually identify. A like event with
    // no message id or timestamp is a legitimate new like: TikTok sends many of
    // them per viewer, and dropping them would under-count the milestone.
    const explicitId = String(event.msgId || event.eventId || event.messageId || '');
    const fingerprint = explicitId
      ? `id|${explicitId}`
      : num(event.createTime) > 0
        ? `t|${num(event.createTime)}|${count}|${num(event.totalLikeCount)}`
        : '';
    const key = fingerprint ? `${user}|${fingerprint}` : '';

    if (key) {
      this.prune(this.likeSeen, LIKE_DEDUPE_MS, now);
      const seenAt = this.likeSeen.get(key);
      if (seenAt && now - seenAt < LIKE_DEDUPE_MS) {
        this.counters.duplicates += 1;
        return { accepted: false, duplicate: true };
      }
      this.likeSeen.set(key, now);
    }

    this.counters.likeEvents += 1;
    this.counters.likes += count;
    this.sessionLikes += count;
    const roomTotal = num(event.totalLikeCount);
    if (roomTotal > this.roomTotal) this.roomTotal = roomTotal;

    if (!this.pending) {
      this.pending = { count: 0, users: new Set(), firstAt: now, lastAt: now, lastUser: null };
    }
    this.pending.count += count;
    this.pending.lastAt = now;
    const name = String(event.username || '').slice(0, 24);
    if (name) {
      this.pending.users.add(name);
      this.pending.lastUser = name;
    }

    return { accepted: true, pending: this.pending.count, totalLikes: this.totalLikes, windowMs: this.windowMs };
  }

  /**
   * Close the aggregation window. The returned batch carries only real numbers:
   * no usernames or counts are ever invented here.
   */
  flushLikes() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return null;

    this.counters.batches += 1;
    const batch = {
      count: pending.count,
      users: [...pending.users].slice(0, 4),
      uniqueUsers: pending.users.size,
      lastUser: pending.lastUser,
      totalLikes: this.totalLikes,
      firstAt: pending.firstAt,
      lastAt: pending.lastAt,
      windowMs: this.windowMs,
      milestone: this.takeMilestone(this.totalLikes),
    };
    this.lastBatch = { ...batch, at: this.now() };
    return batch;
  }

  /**
   * A milestone is announced once. Crossing several at a time (a big jump)
   * celebrates the highest and quietly marks the rest as passed.
   */
  takeMilestone(total = this.totalLikes) {
    const due = milestonesFor(this.minMilestone).filter(
      (value) => value <= total && !this.celebrated.has(value)
    );
    if (!due.length) return null;
    const reached = due[due.length - 1];
    for (const value of due) this.celebrated.add(value);
    this.counters.milestones += 1;
    return reached;
  }

  /** A follow is announced once per viewer, even across a reconnect burst. */
  addFollow(event = {}) {
    const now = this.now();
    const key = String(event.userId || event.username || '').toLowerCase();
    if (!key) return { accepted: false, reason: 'no-user' };

    this.prune(this.followSeen, FOLLOW_DEDUPE_MS, now);
    const seenAt = this.followSeen.get(key);
    if (seenAt && now - seenAt < FOLLOW_DEDUPE_MS) {
      this.counters.duplicates += 1;
      return { accepted: false, duplicate: true };
    }
    this.followSeen.set(key, now);
    this.counters.followEvents += 1;
    return { accepted: true, username: String(event.displayName || event.username || '').slice(0, 24) };
  }

  /** One thank-you per viewer per minute, however many times a share is resent. */
  addShare(event = {}) {
    const now = this.now();
    const key = String(event.userId || event.username || '').toLowerCase();
    if (!key) return { accepted: false, reason: 'no-user' };

    this.prune(this.shareSeen, SHARE_DEDUPE_MS, now);
    const seenAt = this.shareSeen.get(key);
    if (seenAt && now - seenAt < SHARE_DEDUPE_MS) {
      this.counters.duplicates += 1;
      return { accepted: false, duplicate: true };
    }
    this.shareSeen.set(key, now);
    this.counters.shareEvents += 1;
    return { accepted: true, username: String(event.displayName || event.username || '').slice(0, 24) };
  }

  status() {
    return {
      ...this.counters,
      pending: this.pending ? this.pending.count : 0,
      totalLikes: this.totalLikes,
      celebrated: [...this.celebrated],
      nextMilestone: milestonesFor(this.minMilestone).find((value) => value > this.totalLikes) ?? null,
      lastBatch: this.lastBatch,
      windowMs: this.windowMs,
      minMilestone: this.minMilestone,
    };
  }

  reset() {
    this.pending = null;
    this.sessionLikes = 0;
    this.roomTotal = 0;
    this.celebrated.clear();
    this.likeSeen.clear();
    this.followSeen.clear();
    this.shareSeen.clear();
    this.lastBatch = null;
    for (const key of Object.keys(this.counters)) this.counters[key] = 0;
  }
}
