/**
 * Zappy's AI co-host engine.
 *
 * A thin orchestration layer on top of the shared AI provider service:
 *  - filters and batches real TikFinity chat so not every comment costs a call;
 *  - keeps a small rolling memory of the current LIVE session;
 *  - grounds prompts in a safe, minimal game snapshot;
 *  - asks the active provider to decide whether a reply is worthwhile;
 *  - broadcasts the generated line to the existing mascot bubble/TTS path.
 *
 * There is no canned dialogue here. If the provider fails, Zappy stays silent
 * and the failure is reported in Admin; the game and TikFinity keep running.
 */

import { parseCommand } from '../game-engine/engine.js';
import { redactSecret } from './adapter.js';
import {
  buildSystemPrompt,
  buildUserPayload,
  parseAIReply,
  sanitizeSpeech,
  sanitizeViewerText,
} from './personality.js';

const FREQUENCY = {
  low: { windowMs: 2400, cooldownFactor: 1.6, eventChance: 0.12, quietAfterMs: 240000 },
  normal: { windowMs: 1400, cooldownFactor: 1, eventChance: 0.25, quietAfterMs: 150000 },
  high: { windowMs: 800, cooldownFactor: 0.65, eventChance: 0.45, quietAfterMs: 90000 },
};

const clamp = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unref = (timer) => {
  timer?.unref?.();
  return timer;
};

export class AICohost {
  constructor({
    ai,
    engine,
    hub = null,
    store = null,
    logger = null,
    now = () => Date.now(),
    rng = Math.random,
    batchWindowMs = null,
    timeoutMs = null,
  } = {}) {
    this.ai = ai;
    this.engine = engine;
    this.hub = hub;
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.rng = rng;
    this.batchWindowMs = batchWindowMs;

    this.memory = {
      chats: [],
      replies: [],
      turns: [],
      lastUser: new Map(),
      seenTexts: new Map(),
    };
    this.pending = null;
    this.queuedCandidates = null;
    this.inFlight = false;
    this.lastReplyAt = 0;
    this.lastChatReplyAt = 0;
    this.lastEventReplyAt = 0;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastResponse = null;
    this.lastChatAt = now();
    this.lastMatch = null;
    this.lastGift = null;
    this.viewerCount = 0;
    this.counters = { requests: 0, replies: 0, skipped: 0, filtered: 0, errors: 0, retries: 0 };
    this.closed = false;

    this.onSession = () => this.resetSessionMemory();
    this.onFx = (fx) => {
      if (!fx) return;
      if (fx.kind === 'match' && !fx.auto) this.observeGameEvent('match', fx);
      else if (fx.kind === 'gameover') this.observeGameEvent('gameover', fx);
    };
    this.onFeed = (entry) => {
      if (!entry) return;
      if (entry.kind === 'gift') this.observeGameEvent('gift', entry);
      else if (entry.kind === 'level') this.observeGameEvent('level', entry);
      else if (entry.kind === 'gameover') this.observeGameEvent('gameover', entry);
    };
    engine?.on?.('session', this.onSession);
    engine?.on?.('fx', this.onFx);
    engine?.on?.('feed', this.onFeed);

    // Unsolicited chatter is optional and always rate limited.
    this.randomTimer = unref(setInterval(() => this.maybeRandom(), 30000));
  }

  get settings() {
    return this.engine?.settings || {};
  }

  enabled() {
    return this.settings.aiMascotEnabled !== false;
  }

  frequency() {
    return FREQUENCY[this.settings.aiFrequency] || FREQUENCY.normal;
  }

  cooldownMs() {
    return Math.max(3000, clamp(this.settings.aiCooldownSec, 3, 180, 8) * 1000);
  }

  maxChars() {
    return clamp(this.settings.aiMaxChars, 60, 400, 180);
  }

  temperature() {
    return clamp(this.settings.aiTemperature, 0, 1.5, 0.8);
  }

  timeout() {
    return Math.max(2000, Number(this.timeoutMs) || 8000);
  }

  setViewers(count) {
    const value = Number(count);
    if (Number.isFinite(value) && value >= 0) this.viewerCount = Math.floor(value);
  }

  // --------------------------------------------------------------- chat input

  /**
   * Observe one real chat event. Never awaited by the ingest path, so a slow AI
   * provider can never block TikFinity or a game move.
   */
  observeChat(event = {}) {
    if (!this.enabled() || this.settings.aiChatResponses === false) return { accepted: false, reason: 'disabled' };
    if (!event || typeof event !== 'object') return { accepted: false, reason: 'empty' };

    const text = sanitizeViewerText(event.text ?? event.comment, 240);
    if (text.length < 2) return { accepted: false, reason: 'too-short' };

    const cols = this.engine?.board?.cols || 10;
    const rows = this.engine?.board?.rows || 10;
    // Coordinates and game commands are the engine's job, never Zappy's.
    if (parseCommand(text, cols, rows)) {
      this.counters.filtered += 1;
      return { accepted: false, reason: 'command' };
    }

    const now = this.now();
    const normalized = text.toLowerCase().replace(/[!?.,]+$/g, '');
    const seenAt = this.memory.seenTexts.get(normalized);
    if (seenAt && now - seenAt < 90000) {
      this.counters.filtered += 1;
      return { accepted: false, reason: 'duplicate' };
    }
    this.memory.seenTexts.set(normalized, now);
    if (this.memory.seenTexts.size > 400) {
      for (const [key, ts] of this.memory.seenTexts) {
        if (now - ts > 120000) this.memory.seenTexts.delete(key);
      }
    }

    const userId = String(event.userId ?? event.username ?? 'viewer').slice(0, 64);
    const recent = (this.memory.lastUser.get(userId) || []).filter((ts) => now - ts < 15000);
    if (recent.length >= 3) {
      this.counters.filtered += 1;
      return { accepted: false, reason: 'user-rate' };
    }
    recent.push(now);
    this.memory.lastUser.set(userId, recent);
    if (this.memory.lastUser.size > 300) {
      for (const [id, stamps] of this.memory.lastUser) {
        if (!stamps.some((ts) => now - ts < 15000)) this.memory.lastUser.delete(id);
      }
    }

    const candidate = {
      username: sanitizeViewerText(event.username || event.displayName || 'viewer', 24) || 'viewer',
      text,
      ts: now,
      score: this.scoreMessage(text),
    };

    this.lastChatAt = now;
    this.memory.chats.push({ username: candidate.username, text, ts: now });
    if (this.memory.chats.length > 20) this.memory.chats.shift();

    this.enqueueCandidate(candidate);
    return { accepted: true, score: candidate.score };
  }

  /** Heuristic priority only; the AI decides whether to actually speak. */
  scoreMessage(text) {
    let score = 0;
    if (/\bzappy\b|\bzap\b/i.test(text)) score += 6;
    if (/\?|^(how|what|who|why|where|when|can|do|does|is|are|will|should)\b/i.test(text)) score += 3;
    if (/(level|score|leader|winning|win|beat|board|tile|match|game|rank|points|play)/i.test(text)) score += 2;
    if (/(gift|rose|thanks|thank you|follow)/i.test(text)) score += 1;
    if (/(cute|love|funny|lol|haha|awesome|best)/i.test(text)) score += 1;
    if (text.length >= 8) score += 1;
    return score;
  }

  enqueueCandidate(candidate) {
    if (!this.pending) this.pending = { candidates: [], timer: null };
    if (this.pending.candidates.length < 10) this.pending.candidates.push(candidate);
    const windowMs = this.batchWindowMs ?? this.frequency().windowMs;
    clearTimeout(this.pending.timer);
    this.pending.timer = unref(setTimeout(() => this.flush(), windowMs));
  }

  pickBatch(candidates = []) {
    const seen = new Set();
    return [...candidates]
      .sort((a, b) => b.score - a.score || b.ts - a.ts)
      .filter((candidate) => {
        const key = `${candidate.username}|${candidate.text.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);
  }

  /** Flush the short batching window and ask the AI about the best messages. */
  async flush() {
    const pending = this.pending;
    this.pending = null;
    if (pending?.timer) clearTimeout(pending.timer);
    if (!pending?.candidates?.length) return { ok: false, reason: 'empty' };
    return this.respond({ trigger: 'chat', candidates: this.pickBatch(pending.candidates) });
  }

  async respond({ trigger, candidates = [], event = null }) {
    if (!this.enabled()) return { ok: false, reason: 'disabled' };
    if (trigger === 'chat' && this.settings.aiChatResponses === false) return { ok: false, reason: 'chat-disabled' };
    if (this.closed) return { ok: false, reason: 'closed' };
    // Viewer chat has its own cooldown: an AI game/gift reaction must never
    // silence a real viewer reply.
    const lastReply = trigger === 'chat' ? this.lastChatReplyAt : this.lastReplyAt;
    if (trigger !== 'test' && this.now() - lastReply < this.cooldownMs()) {
      return { ok: false, reason: 'cooldown' };
    }
    if (this.inFlight) {
      if (trigger === 'chat') this.queuedCandidates = this.pickBatch(candidates);
      return { ok: false, reason: 'busy' };
    }

    const userPayload = buildUserPayload({ trigger, messages: candidates, event });
    const messages = this.buildMessages({ trigger, candidates, event });
    const reply = await this.requestReply(messages, trigger);
    if (!reply?.reply) {
      this.counters.skipped += 1;
      return { ok: false, reason: 'quiet' };
    }

    const text = sanitizeSpeech(reply.reply, this.maxChars());
    if (!text) {
      this.counters.skipped += 1;
      return { ok: false, reason: 'empty-reply' };
    }

    this.speak(text, reply, trigger, userPayload);
    return { ok: true, text, emotion: reply.emotion, provider: reply.providerName, model: reply.model };
  }

  buildMessages({ trigger, candidates = [], event = null }) {
    const system = buildSystemPrompt({
      context: this.gameContext(),
      maxChars: this.maxChars(),
      recentReplies: this.memory.replies.slice(-4).map((entry) => entry.text),
    });
    const messages = [{ role: 'system', content: system }];
    for (const turn of this.memory.turns.slice(-4)) {
      messages.push({ role: 'user', content: turn.user });
      messages.push({ role: 'assistant', content: turn.reply });
    }
    messages.push({ role: 'user', content: buildUserPayload({ trigger, messages: candidates, event }) });
    return messages;
  }

  /** Only safe, minimal context: no grid, no keys, no admin settings. */
  gameContext() {
    let snapshot = {};
    let leaderboard = { top: [] };
    try {
      snapshot = this.engine?.snapshot?.() || {};
      leaderboard = this.engine?.leaderboard?.() || { top: [] };
    } catch {
      /* context is best effort; conversation must not fail because of it */
    }
    return {
      game: {
        status: snapshot.status || 'unknown',
        level: snapshot.level ?? null,
        remainingTiles: snapshot.remaining ?? null,
        totalMatches: snapshot.totalMatches ?? null,
        autoPlay: Boolean(snapshot.autoPlay),
        recentMatch: this.lastMatch,
        recentGift: this.lastGift,
      },
      leaderboard: {
        top: (leaderboard.top || []).slice(0, 3).map((player) => ({
          name: sanitizeViewerText(player.username, 24),
          score: Number(player.score) || 0,
        })),
        totalPlayers: leaderboard.totalPlayers ?? null,
      },
      viewers: this.viewerCount || null,
    };
  }

  // ------------------------------------------------------------- AI request

  async requestReply(messages, trigger) {
    this.inFlight = true;
    this.counters.requests += 1;
    const started = this.now();
    try {
      const { response, parsed } = await this.requestParsed(messages);
      return {
        ...parsed,
        providerName: response?.providerName || null,
        model: response?.model || null,
        ms: Number.isFinite(response?.ms) ? response.ms : Math.max(0, this.now() - started),
      };
    } catch (error) {
      const message = redactSecret(error?.message || 'AI provider request failed', '').slice(0, 300);
      this.lastError = message;
      this.lastErrorAt = this.now();
      this.counters.errors += 1;
      this.logger?.warn?.(`AI co-host request failed (${trigger}): ${message}`);
      this.store?.log?.({
        category: 'ai',
        level: 'warn',
        message: `AI co-host ${trigger} request failed: ${message}`,
      });
      return null;
    } finally {
      this.inFlight = false;
      this.processQueue();
    }
  }

  /**
   * Ask for strict JSON mode, with one fallback for providers that do not
   * support `response_format` (some local servers return HTTP 400).
   */
  async requestCompletion(messages, { maxTokens = 500 } = {}) {
    // Reasoning-capable free models can spend most of the budget on hidden
    // analysis before the JSON; too small a cap yields an empty completion.
    const base = {
      temperature: this.temperature(),
      maxTokens,
      timeoutMs: this.timeout(),
    };
    try {
      return await this.withTimeout(
        this.ai.chat(messages, { ...base, responseFormat: { type: 'json_object' } }),
        this.timeout() + 1500
      );
    } catch (error) {
      if (!/HTTP 400|response_format|unsupported/i.test(String(error?.message || ''))) throw error;
      return this.withTimeout(this.ai.chat(messages, base), this.timeout() + 1500);
    }
  }

  /**
   * One controlled retry when the model produced no usable reply at all
   * (reasoning dump / malformed output). An intentional empty reply is never
   * retried: that is the model choosing to stay quiet.
   */
  async requestParsed(messages) {
    const parse = (response) => parseAIReply(response?.content, this.maxChars());
    let response = await this.callWithRetry(messages);
    let parsed = parse(response);

    if (!parsed.reply && ['non-json', 'unsafe-or-invalid'].includes(parsed.reason)) {
      this.counters.retries += 1;
      const reminder = [
        ...messages,
        { role: 'user', content: 'Return only the JSON object now. No reasoning, no markdown, no extra text.' },
      ];
      try {
        const retried = await this.callWithRetry(reminder);
        const retriedParsed = parse(retried);
        if (retriedParsed.reply || retriedParsed.reason === 'empty-json') {
          response = retried;
          parsed = retriedParsed;
        }
      } catch {
        /* keep the first quiet result */
      }
    }
    return { response, parsed };
  }

  async callWithRetry(messages) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.requestCompletion(messages);
      } catch (error) {
        lastError = error;
        if (attempt === 0 && this.isTransient(error)) {
          await delay(650);
          continue;
        }
        break;
      }
    }
    throw lastError;
  }

  withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI request timed out.')), ms);
      unref(timer);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  isTransient(error) {
    const message = String(error?.message || '');
    return /timed out|timeout|reachable|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|HTTP 5\d\d|did not return a chat completion|empty completion/i.test(
      message
    );
  }

  processQueue() {
    if (!this.queuedCandidates || this.closed) return;
    const queued = this.queuedCandidates;
    this.queuedCandidates = null;
    if (this.now() - this.lastChatReplyAt < this.cooldownMs()) return;
    unref(
      setTimeout(() => {
        this.respond({ trigger: 'chat', candidates: queued }).catch(() => {});
      }, 40)
    );
  }

  speak(text, reply, trigger, userPayload) {
    const ts = this.now();
    this.lastReplyAt = ts;
    if (trigger === 'chat') this.lastChatReplyAt = ts;
    const frame = {
      kind: 'ai',
      ai: true,
      trigger,
      text,
      emotion: reply.emotion || 'happy',
      priority: 2,
      ts,
    };
    this.hub?.broadcast?.('mascot', frame);

    this.memory.replies.push({ text, ts });
    if (this.memory.replies.length > 8) this.memory.replies.shift();
    if (userPayload) {
      this.memory.turns.push({ user: userPayload, reply: text });
      if (this.memory.turns.length > 4) this.memory.turns.shift();
    }
    this.lastResponse = {
      text,
      emotion: frame.emotion,
      trigger,
      providerName: reply.providerName || null,
      model: reply.model || null,
      ms: reply.ms || 0,
      ts,
    };
    this.counters.replies += 1;
    this.store?.log?.({
      category: 'ai',
      message: `AI co-host replied (${trigger}) via ${reply.providerName || 'active provider'} in ${reply.ms || 0} ms.`,
    });
  }

  // ------------------------------------------------------------- game events

  /**
   * Commentary on real game events. Limited by toggle, probability and a longer
   * cooldown so it never competes with direct viewer conversation.
   */
  async observeGameEvent(kind, payload = {}) {
    if (!this.enabled()) return;

    if (kind === 'match') {
      this.lastMatch = {
        player: sanitizeViewerText(payload.username, 24),
        tiles: `${payload.a?.label || '?'} + ${payload.b?.label || '?'}`,
        points: Number(payload.points) || 0,
        combo: Number(payload.combo) || 0,
      };
      return this.maybeEventReply('match', `A viewer matched ${this.lastMatch.tiles} for ${this.lastMatch.points} points.`);
    }

    if (kind === 'gift') {
      const coins = Number(payload.meta?.coins ?? payload.coins) || 0;
      this.lastGift = {
        player: sanitizeViewerText(payload.username, 24),
        gift: sanitizeViewerText(payload.meta?.giftName || payload.giftName || 'a gift', 40),
        coins,
      };
      return this.maybeEventReply('gift', `${this.lastGift.player} sent a gift (${coins} coins).`);
    }

    if (kind === 'level') {
      return this.maybeEventReply('level', sanitizeViewerText(payload.text, 120) || 'A new level started.');
    }

    if (kind === 'gameover') {
      return this.maybeEventReply('gameover', sanitizeViewerText(payload.reason || payload.text, 120) || 'The game just ended.');
    }
  }

  async maybeEventReply(kind, description) {
    const toggleOn = kind === 'gift' ? this.settings.aiGiftReactions !== false : this.settings.aiGameCommentary !== false;
    if (!toggleOn) return;
    // Real viewer conversation always wins over unsolicited commentary.
    if (this.inFlight || this.pending || this.queuedCandidates) return;

    const now = this.now();
    const cooldown = Math.max(15000, this.cooldownMs() * 3);
    if (now - this.lastEventReplyAt < cooldown) return;
    if (this.rng() > this.frequency().eventChance) return;

    const result = await this.respond({ trigger: kind, event: description });
    if (result.ok) this.lastEventReplyAt = this.now();
  }

  async maybeRandom() {
    if (this.closed || !this.enabled() || this.settings.aiRandomConversation !== true) return;
    if (this.inFlight || this.pending) return;
    const quietAfter = this.frequency().quietAfterMs;
    const now = this.now();
    if (now - this.lastChatAt < quietAfter || now - this.lastReplyAt < quietAfter) return;
    if (this.rng() > 0.5) return;
    await this.respond({ trigger: 'random', event: null }).catch(() => {});
  }

  // ------------------------------------------------------------------ reset

  /** RESET FOR NEW LIVE: conversation memory belongs to one LIVE session only. */
  resetSessionMemory() {
    this.memory.chats = [];
    this.memory.replies = [];
    this.memory.turns = [];
    this.memory.lastUser.clear();
    this.memory.seenTexts.clear();
    this.pending = null;
    this.queuedCandidates = null;
    this.lastMatch = null;
    this.lastGift = null;
    this.lastReplyAt = 0;
    this.lastChatReplyAt = 0;
    this.lastEventReplyAt = 0;
    this.lastChatAt = this.now();
    this.logger?.info?.('AI co-host memory cleared for the new LIVE session.');
  }

  // ------------------------------------------------------------------ admin

  /** Real test request to the active provider; no canned or simulated line. */
  async testResponse() {
    const started = this.now();
    const messages = this.buildMessages({ trigger: 'test', candidates: [], event: null });
    try {
      const { response, parsed } = await this.requestParsed(messages);
      if (!parsed.reply) {
        // Never surface raw model output (it can contain reasoning or prompt text).
        return {
          ok: false,
          response: '',
          error: 'The active provider did not return a usable JSON reply. Try TEST AI RESPONSE again or choose another provider.',
          provider: response?.providerName || this.ai.activeProvider?.()?.name || null,
          model: response?.model || null,
          ms: Number.isFinite(response?.ms) ? response.ms : Math.max(0, this.now() - started),
        };
      }
      return {
        ok: true,
        response: parsed.reply,
        emotion: parsed.emotion,
        provider: response?.providerName || this.ai.activeProvider?.()?.name || null,
        model: response?.model || null,
        ms: Number.isFinite(response?.ms) ? response.ms : Math.max(0, this.now() - started),
      };
    } catch (error) {
      return {
        ok: false,
        response: '',
        error: redactSecret(error?.message || 'AI request failed', '').slice(0, 300),
        provider: this.ai.activeProvider?.()?.name || null,
      };
    }
  }

  status() {
    const active = this.ai?.activeProvider?.() || null;
    const settings = this.settings;
    return {
      enabled: this.enabled(),
      settings: {
        chatResponses: settings.aiChatResponses !== false,
        gameCommentary: settings.aiGameCommentary !== false,
        giftReactions: settings.aiGiftReactions !== false,
        randomConversation: settings.aiRandomConversation === true,
        frequency: settings.aiFrequency || 'normal',
        cooldownSec: this.cooldownMs() / 1000,
        maxChars: this.maxChars(),
        temperature: this.temperature(),
      },
      activeProvider: active
        ? { id: active.id, name: active.name, providerType: active.providerType, model: active.model }
        : null,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastResponse: this.lastResponse,
      counters: { ...this.counters },
      inFlight: this.inFlight,
      queued: Boolean(this.queuedCandidates),
      memory: {
        chats: this.memory.chats.length,
        replies: this.memory.replies.length,
        turns: this.memory.turns.length,
      },
      batchWindowMs: this.batchWindowMs ?? this.frequency().windowMs,
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.pending?.timer);
    clearInterval(this.randomTimer);
    this.pending = null;
    this.queuedCandidates = null;
    this.engine?.off?.('session', this.onSession);
    this.engine?.off?.('fx', this.onFx);
    this.engine?.off?.('feed', this.onFeed);
  }
}
