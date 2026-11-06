/**
 * Zappy's AI co-host engine.
 *
 * An orchestration layer on top of the shared AI provider service:
 *  - filters and batches real TikFinity chat so not every comment costs a call;
 *  - keeps a small rolling memory of the current LIVE session;
 *  - grounds prompts in a safe, minimal game snapshot;
 *  - asks the active provider for one short line, with bounded retries so an
 *    always-active host never accepts an empty turn;
 *  - keeps a single bounded, prioritised queue of pending turns;
 *  - watches for stuck requests / busy flags / speech and recovers them;
 *  - schedules autonomous topics when the LIVE goes quiet;
 *  - broadcasts lines through the existing mascot bubble/TTS path and tracks
 *    the real speech outcome reported by the overlay.
 *
 * There is no canned dialogue here. If the provider fails, Zappy stays silent,
 * the failure is reported in Admin and a recovery attempt is scheduled later;
 * the game and TikFinity keep running.
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

/** Conversation priority. Low numbers are dropped first when the queue is full. */
export const PRIORITY = {
  autonomous: 1,
  commentary: 2,
  gift: 3,
  chat: 4,
  direct: 5,
};

export const LIMITS = {
  maxQueue: 6,
  maxSpeechMs: 45000,
  requestGraceMs: 5000,
  batchWindowMs: 1400,
  historyLines: 6,
};

const WATCHDOG_INTERVAL_MS = 1000;
const RECOVERY_BASE_MS = 8000;
const RECOVERY_MAX_MS = 120000;
const MAX_RECOVERY_ATTEMPTS = 6;
const QUEUE_TTL_MS = { 1: 20000, 2: 25000, 3: 30000, 4: 45000, 5: 60000 };

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

const normalizeLine = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Prompt text for a retry. This is an instruction to the model, never a spoken
 * fallback line: nothing from this table is ever broadcast to viewers.
 */
const RETRY_INSTRUCTION = {
  empty:
    'Your last answer was empty. A silent turn is not allowed right now. Continue in character and return one short, natural, entertaining spoken line in the required JSON object.',
  'empty-json':
    'Your last JSON object had an empty "reply". Continue in character and return one short, natural, entertaining line in the required JSON object.',
  'non-json':
    'Your last answer was not the required JSON object. Return ONLY the JSON object with a non-empty "reply" string.',
  'unsafe-or-invalid':
    'Your last answer was not usable. Return ONLY the JSON object with a short, clean, spoken "reply" string and no reasoning or markdown.',
  duplicate:
    'You already said that line recently. Say something new that fits this exact moment, in the required JSON object.',
  default: 'Return one short, natural, entertaining spoken line in the required JSON object.',
};

const retryInstruction = (reason) => RETRY_INSTRUCTION[reason] || RETRY_INSTRUCTION.default;

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
    watchdogIntervalMs = WATCHDOG_INTERVAL_MS,
    speechStuckMs = LIMITS.maxSpeechMs,
    scheduleTimers = true,
  } = {}) {
    this.ai = ai;
    this.engine = engine;
    this.hub = hub;
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.rng = rng;
    this.batchWindowMs = batchWindowMs;
    this.timeoutMsOverride = timeoutMs;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.speechStuckMs = speechStuckMs;
    this.scheduleTimers = scheduleTimers !== false;

    this.memory = {
      chats: [],
      replies: [],
      turns: [],
      lastUser: new Map(),
      seenTexts: new Map(),
    };
    this.pending = null;
    this.queue = [];
    this.queueSeq = 0;
    this.activeRequest = null;
    this.requestSeq = 0;
    /** Bumped whenever in-flight work must be invalidated (reset/recovery). */
    this.epoch = 0;
    this.sessionSeq = 0;
    this.sessionId = 'live-0';
    this.sessionStartedAt = now();
    this.inFlight = false;
    this.drainTimer = null;
    this.lastDrainAt = 0;
    this.lastReplyAt = 0;
    this.lastChatReplyAt = 0;
    this.lastEventReplyAt = 0;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastSuccessAt = 0;
    this.lastRequestAt = 0;
    this.lastResponse = null;
    this.lastSpeechSentAt = 0;
    this.lastChatAt = now();
    this.lastMatch = null;
    this.lastGift = null;
    this.viewerCount = 0;
    this.autonomousAt = null;
    this.autonomousTimer = null;
    // Admin → MAKE ZAPPY TALK: one operator-triggered line at a time.
    this.manual = { active: false, startedAt: null, id: null, topic: null, error: null };

    this.tts = {
      state: 'idle', // idle | pending | speaking | error
      activeId: null,
      text: '',
      startedAt: null,
      lastStartedAt: null,
      lastSpokenAt: null,
      lastSpokenText: '',
      error: null,
      errorAt: null,
      skipped: 0,
      voicesAvailable: null,
      voiceCount: null,
    };
    this.speaking = false;
    this.speakingId = null;
    this.speechSeq = 0;

    this.recovery = {
      attempts: 0,
      count: 0,
      lastAt: null,
      lastReason: null,
      lastDetail: null,
      nextAt: null,
    };
    this.lastRecovery = null;

    this.counters = {
      requests: 0,
      replies: 0,
      spoken: 0,
      skipped: 0,
      filtered: 0,
      errors: 0,
      retries: 0,
      emptyTurns: 0,
      autonomous: 0,
      recoveries: 0,
    };
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

    if (this.scheduleTimers && this.watchdogIntervalMs > 0) {
      this.watchdogTimer = unref(setInterval(() => this.tickWatchdog(), this.watchdogIntervalMs));
    } else {
      this.watchdogTimer = null;
    }
    this.scheduleAutonomous();
  }

  // ---------------------------------------------------------------- settings

  get settings() {
    return this.engine?.settings || {};
  }

  enabled() {
    return this.settings.aiMascotEnabled !== false;
  }

  alwaysActive() {
    return this.settings.aiAlwaysActive !== false;
  }

  autonomousOn() {
    return this.settings.aiAutonomous !== false;
  }

  watchdogOn() {
    return this.settings.aiWatchdog !== false;
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
    if (Number.isFinite(Number(this.timeoutMsOverride)) && Number(this.timeoutMsOverride) > 0) {
      return Number(this.timeoutMsOverride);
    }
    return Math.max(5000, clamp(this.settings.aiTimeoutSec, 5, 90, 20) * 1000);
  }

  maxRetries() {
    return Math.round(clamp(this.settings.aiMaxRetries, 1, 4, 1));
  }

  minIdleMs() {
    return Math.max(5000, clamp(this.settings.aiMinIdleSec, 5, 600, 20) * 1000);
  }

  maxIdleMs() {
    const max = Math.max(5000, clamp(this.settings.aiMaxIdleSec, 5, 600, 35) * 1000);
    return Math.max(max, this.minIdleMs() + 1000);
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
      direct: false,
    };
    candidate.direct = candidate.score >= 6;

    this.lastChatAt = now;
    this.memory.chats.push({ username: candidate.username, text, ts: now });
    if (this.memory.chats.length > 20) this.memory.chats.shift();

    this.enqueueCandidate(candidate);
    return { accepted: true, score: candidate.score };
  }

  /** Heuristic priority only; the AI decides what to actually say. */
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
    const candidates = this.pickBatch(pending.candidates);
    return this.respond({
      trigger: 'chat',
      candidates,
      priority: candidates[0]?.direct ? PRIORITY.direct : PRIORITY.chat,
    });
  }

  // ---------------------------------------------------------------- priority

  priorityFor(trigger, candidates = []) {
    if (trigger === 'chat') return candidates[0]?.direct ? PRIORITY.direct : PRIORITY.chat;
    if (trigger === 'gift') return PRIORITY.gift;
    if (trigger === 'autonomous' || trigger === 'random') return PRIORITY.autonomous;
    if (trigger === 'test') return PRIORITY.direct;
    return PRIORITY.commentary;
  }

  /**
   * Single entry point for every conversational turn. It either runs now or is
   * appended to the bounded priority queue.
   */
  async respond({ trigger, candidates = [], event = null, priority = null } = {}) {
    if (!this.enabled()) return { ok: false, reason: 'disabled' };
    if (this.closed) return { ok: false, reason: 'closed' };
    if (trigger === 'chat' && this.settings.aiChatResponses === false) return { ok: false, reason: 'chat-disabled' };
    if ((trigger === 'autonomous' || trigger === 'random') && !this.autonomousOn()) {
      return { ok: false, reason: 'autonomous-disabled' };
    }
    if (['match', 'level', 'gameover'].includes(trigger) && this.settings.aiGameCommentary === false) {
      return { ok: false, reason: 'commentary-disabled' };
    }
    if (trigger === 'gift' && this.settings.aiGiftReactions === false) {
      return { ok: false, reason: 'gift-disabled' };
    }

    const itemPriority = priority ?? this.priorityFor(trigger, candidates);
    // Viewer chat has its own cooldown: an AI game/gift reaction must never
    // silence a real viewer reply. Direct questions to Zappy get a shorter one.
    const last = trigger === 'chat' ? this.lastChatReplyAt : this.lastReplyAt;
    const cooldown = itemPriority >= PRIORITY.direct ? Math.round(this.cooldownMs() * 0.5) : this.cooldownMs();
    if (trigger !== 'test' && this.now() - last < cooldown) {
      return { ok: false, reason: 'cooldown' };
    }

    if (this.inFlight || this.isSpeaking()) {
      this.enqueue({ trigger, candidates, event, priority: itemPriority });
      return { ok: false, reason: 'busy', queued: true, queueLength: this.queue.length };
    }
    return this.runTurn({ trigger, candidates, event, priority: itemPriority });
  }

  enqueue({ trigger, candidates = [], event = null, priority = PRIORITY.commentary }) {
    const item = {
      id: ++this.queueSeq,
      trigger,
      candidates,
      event,
      priority,
      queuedAt: this.now(),
    };
    this.queue.push(item);

    // Bounded queue: drop the least valuable, oldest item first. A direct
    // question is never discarded to make room.
    while (this.queue.length > LIMITS.maxQueue) {
      const victims = this.queue
        .filter((entry) => entry.priority < PRIORITY.direct)
        .sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
      if (!victims.length) break;
      this.queue = this.queue.filter((entry) => entry !== victims[0]);
      this.counters.filtered += 1;
    }
    this.drainQueue();
    return item;
  }

  pruneQueue() {
    const now = this.now();
    this.queue = this.queue.filter((item) => now - item.queuedAt < (QUEUE_TTL_MS[item.priority] || 30000));
  }

  nextQueueItem() {
    return [...this.queue].sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt)[0] || null;
  }

  drainQueue() {
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
    if (this.closed) return;
    this.pruneQueue();
    this.lastDrainAt = this.now();
    if (!this.queue.length || this.inFlight || this.isSpeaking()) return;

    const item = this.nextQueueItem();
    if (!item) return;
    const last = item.trigger === 'chat' ? this.lastChatReplyAt : this.lastReplyAt;
    const cooldown = item.priority >= PRIORITY.direct ? Math.round(this.cooldownMs() * 0.5) : this.cooldownMs();
    if (this.now() - last < cooldown) {
      const wait = Math.max(250, cooldown - (this.now() - last));
      this.drainTimer = unref(setTimeout(() => this.drainQueue(), wait));
      return;
    }
    this.queue = this.queue.filter((entry) => entry !== item);
    this.runTurn({
      trigger: item.trigger,
      candidates: item.candidates,
      event: item.event,
      priority: item.priority,
    }).catch(() => {});
  }

  // ------------------------------------------------------------- AI request

  async runTurn({ trigger, candidates = [], event = null, priority = PRIORITY.chat }) {
    const request = {
      id: ++this.requestSeq,
      trigger,
      priority,
      startedAt: this.now(),
      epoch: this.epoch,
      step: 'thinking',
    };
    this.activeRequest = request;
    this.inFlight = true;
    this.lastRequestAt = request.startedAt;
    this.counters.requests += 1;

    try {
      const messages = this.buildMessages({ trigger, candidates, event });
      const userPayload = buildUserPayload({ trigger, messages: candidates, event });
      request.step = 'generating';

      const result = await this.requestParsed(messages, { trigger });
      if (this.closed || request.epoch !== this.epoch) return { ok: false, reason: 'stale' };

      if (!result.parsed.reply) {
        this.counters.skipped += 1;
        this.counters.emptyTurns += 1;
        this.counters.errors += 1;
        const message = `The AI returned no usable reply after ${result.attempts} attempt(s) (${result.parsed.reason}).`;
        this.lastError = message;
        this.lastErrorAt = this.now();
        this.logger?.warn?.(`AI co-host ${trigger}: ${message}`);
        this.store?.log?.({ category: 'ai', level: 'warn', message: `AI co-host ${trigger}: ${message}` });
        this.scheduleRecovery();
        return { ok: false, reason: 'empty-reply', attempts: result.attempts };
      }

      const text = sanitizeSpeech(result.parsed.reply, this.maxChars());
      if (!text) {
        this.counters.skipped += 1;
        this.lastError = 'The AI reply could not be spoken after sanitizing.';
        this.lastErrorAt = this.now();
        this.scheduleRecovery();
        return { ok: false, reason: 'unusable-reply' };
      }

      this.lastSuccessAt = this.now();
      this.recovery.attempts = 0;
      this.recovery.nextAt = null;
      this.speak(
        text,
        {
          ...result.parsed,
          providerName: result.response?.providerName || null,
          model: result.response?.model || null,
          ms: Number.isFinite(result.response?.ms)
            ? result.response.ms
            : Math.max(0, this.now() - request.startedAt),
        },
        trigger,
        userPayload,
        { priority }
      );
      return {
        ok: true,
        text,
        emotion: result.parsed.emotion,
        provider: result.response?.providerName || null,
        model: result.response?.model || null,
        speechId: this.speakingId,
      };
    } catch (error) {
      if (request.epoch !== this.epoch) return { ok: false, reason: 'stale' };
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
      this.scheduleRecovery();
      return { ok: false, reason: 'error', error: message };
    } finally {
      if (this.activeRequest && this.activeRequest.id === request.id) {
        this.activeRequest = null;
        this.inFlight = false;
      }
      this.drainQueue();
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
   * Bounded retries so an always-active host never accepts an empty turn.
   * Outside always-active mode a deliberate empty reply is respected, and only
   * a broken output contract (unparseable JSON) is retried once.
   */
  async requestParsed(messages, { alwaysActive = this.alwaysActive() } = {}) {
    const maxAttempts = alwaysActive ? 1 + this.maxRetries() : 2;
    let attempts = 0;
    let retries = 0;
    let response = null;
    let parsed = null;
    let conversation = messages;

    while (attempts < maxAttempts) {
      attempts += 1;
      response = await this.callWithRetry(conversation);
      parsed = parseAIReply(response?.content, this.maxChars());

      if (parsed.reply) {
        if (!this.isDuplicate(parsed.reply)) return { response, parsed, attempts, retries };
        parsed = { ...parsed, reply: '', reason: 'duplicate' };
      }

      if (!alwaysActive) {
        // A deliberate empty answer means "stay quiet" - never retry that.
        if (parsed.reason === 'empty' || parsed.reason === 'empty-json' || parsed.reason === 'duplicate') break;
        if (attempts >= maxAttempts) break;
      }
      if (attempts >= maxAttempts) break;

      retries += 1;
      this.counters.retries += 1;
      conversation = [...messages, { role: 'user', content: retryInstruction(parsed.reason) }];
    }

    return {
      response,
      parsed: parsed || { reply: '', emotion: 'neutral', reason: 'empty' },
      attempts,
      retries,
    };
  }

  /** A repeated line is never spoken twice in a row. */
  isDuplicate(text) {
    const key = normalizeLine(text);
    if (!key) return true;
    if (this.tts.lastSpokenText && normalizeLine(this.tts.lastSpokenText) === key) return true;
    return this.memory.replies.slice(-LIMITS.historyLines).some((entry) => normalizeLine(entry.text) === key);
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

  buildMessages({ trigger, candidates = [], event = null, topic = null }) {
    const system = buildSystemPrompt({
      context: this.gameContext(),
      maxChars: this.maxChars(),
      recentReplies: this.memory.replies.slice(-4).map((entry) => entry.text),
      alwaysActive: this.alwaysActive(),
    });
    const messages = [{ role: 'system', content: system }];
    for (const turn of this.memory.turns.slice(-4)) {
      messages.push({ role: 'user', content: turn.user });
      messages.push({ role: 'assistant', content: turn.reply });
    }
    messages.push({ role: 'user', content: buildUserPayload({ trigger, messages: candidates, event, topic }) });
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

  // ----------------------------------------------------------------- speech

  isSpeaking() {
    return this.tts.state === 'speaking';
  }

  speak(text, reply, trigger, userPayload, { priority = PRIORITY.chat } = {}) {
    const ts = this.now();
    const speechId = ++this.speechSeq;
    this.lastReplyAt = ts;
    if (trigger === 'chat') this.lastChatReplyAt = ts;
    this.lastSpeechSentAt = ts;

    const frame = {
      kind: 'ai',
      ai: true,
      trigger,
      text,
      emotion: reply.emotion || 'happy',
      priority: priority >= PRIORITY.direct ? 3 : 2,
      speechId,
      ts,
    };

    this.speaking = true;
    this.speakingId = speechId;
    this.tts.state = 'pending';
    this.tts.activeId = speechId;
    this.tts.text = text;
    this.tts.startedAt = ts;
    this.tts.lastStartedAt = ts;

    // Nothing can be spoken without an overlay page; never claim SPEAKING then.
    const clients = this.hub?.clientCount;
    const noOverlay = typeof clients === 'number' && clients === 0;
    this.hub?.broadcast?.('mascot', frame);
    if (noOverlay) {
      this.speaking = false;
      this.speakingId = null;
      this.tts.state = 'idle';
      this.tts.activeId = null;
      this.tts.note = 'No overlay connected, so the line was not spoken.';
    }

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
      speechId,
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
    return speechId;
  }

  /**
   * Real speech telemetry from the overlay. Only a matching speech id may
   * change the state, so a late report from an old line cannot resurrect it.
   */
  reportTts(payload = {}) {
    const state = String(payload?.state || '').toLowerCase();
    const rawId = payload?.id;
    const id = rawId === null || rawId === undefined || rawId === '' ? Number.NaN : Number(rawId);
    const now = this.now();

    if (state === 'voices') {
      this.tts.voicesAvailable = payload.available === undefined ? null : Boolean(payload.available);
      this.tts.voiceCount = Number.isFinite(Number(payload.count)) ? Number(payload.count) : null;
      return { ok: true };
    }

    if (state !== 'voices' && !Number.isFinite(id)) {
      // Mascot/game callouts also use the browser voice; only a line the AI
      // co-host issued may change the AI speech state.
      return { ok: false, reason: 'no-speech-id' };
    }
    const stale = this.speakingId !== null && id !== this.speakingId;
    if (stale) return { ok: false, reason: 'stale' };

    if (state === 'start') {
      if (!this.speaking) return { ok: false, reason: 'not-speaking' };
      this.tts.state = 'speaking';
      this.tts.startedAt = now;
      this.tts.error = null;
      return { ok: true };
    }

    if (state === 'end') {
      const text = this.tts.text;
      this.speaking = false;
      this.speakingId = null;
      this.tts.state = 'idle';
      this.tts.activeId = null;
      this.tts.lastSpokenAt = now;
      this.tts.lastSpokenText = text;
      this.counters.spoken += 1;
      this.drainQueue();
      return { ok: true };
    }

    if (state === 'error' || state === 'skipped') {
      const reason = redactSecret(payload?.error || 'speech playback failed', '').slice(0, 160);
      this.speaking = false;
      this.speakingId = null;
      this.tts.activeId = null;
      if (state === 'skipped') {
        this.tts.state = 'idle';
        this.tts.skipped += 1;
        this.tts.skipReason = reason;
      } else {
        this.tts.state = 'error';
        this.tts.error = reason;
        this.tts.errorAt = now;
        this.lastError = `Speech playback failed: ${reason}`;
        this.lastErrorAt = now;
        this.counters.errors += 1;
        this.store?.log?.({ category: 'ai', level: 'warn', message: `Speech playback failed: ${reason}` });
      }
      this.drainQueue();
      return { ok: true };
    }

    return { ok: false, reason: 'unknown-state' };
  }

  // --------------------------------------------------------------- watchdog

  /**
   * One watchdog pass. Safe to call from a timer: it only releases stuck state
   * and schedules bounded recovery, it never loops on its own.
   */
  tickWatchdog() {
    if (this.closed) return { ok: false, reason: 'closed', actions: [] };
    if (!this.watchdogOn()) return { ok: true, skipped: 'disabled', actions: [] };
    const now = this.now();
    const actions = [];

    // 1) AI request that never resolved.
    if (this.activeRequest) {
      const elapsed = now - this.activeRequest.startedAt;
      if (elapsed > this.timeout() + LIMITS.requestGraceMs) {
        actions.push(
          this.recover(
            'stuck-request',
            `AI request ${this.activeRequest.id} (${this.activeRequest.trigger}) ran ${Math.round(
              elapsed / 1000
            )}s without answering.`
          )
        );
      }
    } else if (this.inFlight) {
      // 2) Busy flag stuck with nothing behind it.
      actions.push(this.recover('stuck-busy-flag', 'The AI busy flag was set with no active request.'));
    }

    // 3) Speech that never reported completion (or was never started).
    const speechAge = this.tts.lastStartedAt ? now - this.tts.lastStartedAt : 0;
    if (this.speaking && speechAge > this.speechStuckMs) {
      actions.push(
        this.recover('stuck-speaking', `No speech completion after ${Math.round(speechAge / 1000)}s.`)
      );
    }

    // 4) A queue that stopped draining.
    if (this.queue.length && !this.inFlight && !this.isSpeaking() && now - this.lastDrainAt > 5000) {
      this.drainQueue();
      actions.push({ ok: true, reason: 'queue-resumed' });
    }

    // 5) A scheduled recovery attempt that is due.
    if (this.recovery.nextAt && now >= this.recovery.nextAt) {
      this.recovery.nextAt = null;
      this.runRecoveryAttempt();
      actions.push({ ok: true, reason: 'recovery-attempt' });
    }

    return { ok: true, actions };
  }

  recover(reason, detail) {
    const now = this.now();
    // Invalidate anything in flight: a late provider response must never be
    // spoken after a recovery or a session reset.
    this.epoch += 1;
    this.activeRequest = null;
    this.inFlight = false;
    this.speaking = false;
    this.speakingId = null;
    this.tts.state = 'idle';
    this.tts.activeId = null;

    this.recovery.count += 1;
    this.recovery.lastAt = now;
    this.recovery.lastReason = reason;
    this.recovery.lastDetail = detail;
    this.lastRecovery = { reason, detail, ts: now };
    // A stuck manual request must not leave the Admin button locked.
    this.manual.active = false;
    this.counters.recoveries += 1;

    this.logger?.warn?.(`AI watchdog recovery (${reason}): ${detail}`);
    this.store?.log?.({ category: 'ai', level: 'warn', message: `AI watchdog recovery (${reason}): ${detail}` });

    this.scheduleRecovery();
    // The turn that was in flight will never reach its own reschedule, so the
    // autonomous timer is restarted here as well.
    this.scheduleAutonomous(this.autonomousDelay());
    this.drainQueue();
    return { ok: true, reason, detail };
  }

  scheduleRecovery() {
    if (this.closed || !this.alwaysActive()) return;
    const now = this.now();
    // A long healthy stretch means the earlier failures are stale: allow the
    // full retry budget again instead of giving up for the rest of the LIVE.
    if (this.recovery.lastAt && now - this.recovery.lastAt > 600000) this.recovery.attempts = 0;
    if (this.recovery.attempts >= MAX_RECOVERY_ATTEMPTS) {
      this.recovery.nextAt = null;
      return;
    }
    const wait = Math.min(RECOVERY_MAX_MS, RECOVERY_BASE_MS * 2 ** this.recovery.attempts);
    this.recovery.attempts += 1;
    this.recovery.nextAt = now + wait;
  }

  runRecoveryAttempt() {
    if (this.closed || !this.enabled()) return;
    if (this.inFlight || this.isSpeaking()) return;
    if (this.queue.length) {
      this.drainQueue();
      return;
    }
    if (!this.alwaysActive() || !this.autonomousOn()) return;
    this.respond({ trigger: 'autonomous', priority: PRIORITY.autonomous }).catch(() => {});
  }

  // ------------------------------------------------------------- autonomous

  autonomousDelay() {
    const min = this.minIdleMs();
    const max = this.maxIdleMs();
    return Math.round(min + this.rng() * Math.max(0, max - min));
  }

  scheduleAutonomous(waitMs = null) {
    clearTimeout(this.autonomousTimer);
    this.autonomousTimer = null;
    this.autonomousAt = null;
    if (!this.scheduleTimers) return;
    if (this.closed || !this.enabled() || !this.alwaysActive() || !this.autonomousOn()) return;
    const wait = Math.max(1000, Number(waitMs) || this.autonomousDelay());
    this.autonomousAt = this.now() + wait;
    this.autonomousTimer = unref(setTimeout(() => this.autonomousTick(), wait));
  }

  /**
   * One autonomous opportunity. The content always comes from the active AI
   * provider; this method only decides whether it is a good moment to talk.
   */
  async autonomousTick() {
    if (this.closed || !this.enabled() || !this.alwaysActive() || !this.autonomousOn()) {
      return { ok: false, reason: 'disabled' };
    }
    const now = this.now();
    if (this.inFlight || this.isSpeaking()) {
      this.scheduleAutonomous(Math.round(this.minIdleMs() / 2));
      return { ok: false, reason: 'busy' };
    }
    if (this.queue.length || this.pending) {
      this.scheduleAutonomous(this.autonomousDelay());
      return { ok: false, reason: 'queue' };
    }

    const lastActivity = Math.max(this.lastChatAt, this.lastReplyAt, this.tts.lastSpokenAt || 0);
    const quietFor = now - lastActivity;
    const minIdle = this.minIdleMs();
    if (quietFor < minIdle) {
      this.scheduleAutonomous(minIdle - quietFor + 500);
      return { ok: false, reason: 'active-conversation' };
    }

    const result = await this.respond({ trigger: 'autonomous', priority: PRIORITY.autonomous });
    if (result.ok) this.counters.autonomous += 1;
    this.scheduleAutonomous(this.autonomousDelay());
    return result;
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
    if (!toggleOn) return undefined;
    // Real viewer conversation always wins over unsolicited commentary.
    if (this.inFlight || this.pending || this.isSpeaking() || this.queue.length) return undefined;

    const now = this.now();
    const cooldown = Math.max(15000, this.cooldownMs() * 3);
    if (now - this.lastEventReplyAt < cooldown) return undefined;
    if (this.rng() > this.frequency().eventChance) return undefined;

    const priority = kind === 'gift' ? PRIORITY.gift : PRIORITY.commentary;
    const result = await this.respond({ trigger: kind, event: description, priority });
    if (result.ok) this.lastEventReplyAt = this.now();
    return result;
  }

  // ------------------------------------------------------- manual (Admin button)

  /**
   * Admin → MAKE ZAPPY TALK: one real, unsolicited line generated by the active
   * provider and spoken through the existing mascot/TTS path.
   *
   * It is deliberately independent of the autonomous scheduler, so it works
   * even when autonomous conversation is off. It never interrupts a line that
   * is already being spoken and never overlaps another request, and it uses the
   * normal reply parsing/sanitizing pipeline (no canned dialogue, no bypass).
   */
  async manualTalk({ topic = null } = {}) {
    if (this.closed) return { ok: false, reason: 'closed', error: 'The server is shutting down.' };
    if (!this.enabled()) {
      return { ok: false, reason: 'disabled', error: 'The AI mascot is disabled. Enable it in AI Mascot settings first.' };
    }
    if (!this.ai?.activeProvider?.()) {
      return { ok: false, reason: 'no-provider', error: 'No active AI provider. Choose one in AI Providers.' };
    }
    if (this.speaking) {
      return { ok: false, reason: 'speaking', error: 'Zappy is already speaking. Wait for the current line to finish.' };
    }
    if (this.inFlight || this.manual.active) {
      return { ok: false, reason: 'busy', error: 'Zappy is already working on a line. Wait for it to finish.' };
    }

    const cleanTopic = sanitizeViewerText(topic, 160) || null;
    const startedAt = this.now();
    const request = {
      id: ++this.requestSeq,
      trigger: 'manual',
      priority: PRIORITY.direct,
      startedAt,
      epoch: this.epoch,
      step: 'thinking',
    };
    this.manual = { active: true, startedAt, id: request.id, topic: cleanTopic, error: null };
    this.activeRequest = request;
    this.inFlight = true;
    this.lastRequestAt = startedAt;
    this.counters.requests += 1;

    try {
      const messages = this.buildMessages({ trigger: 'manual', topic: cleanTopic });
      request.step = 'generating';
      const { response, parsed, attempts } = await this.requestParsed(messages, { alwaysActive: true });
      const providerName = response?.providerName || this.ai.activeProvider?.()?.name || null;
      const model = response?.model || null;
      const ms = Number.isFinite(response?.ms) ? response.ms : Math.max(0, this.now() - startedAt);

      if (this.closed || request.epoch !== this.epoch) {
        return { ok: false, reason: 'stale', error: 'The request was cancelled by a recovery or a new LIVE session.' };
      }
      if (!parsed.reply) {
        this.counters.errors += 1;
        this.counters.emptyTurns += 1;
        const error = `The active provider returned no usable reply after ${attempts} attempt(s). Try again or choose another provider.`;
        this.manual.error = error;
        this.lastError = error;
        this.lastErrorAt = this.now();
        this.store?.log?.({ category: 'ai', level: 'warn', message: `Manual Zappy line failed: ${error}` });
        return { ok: false, reason: 'empty-reply', error, provider: providerName, model, ms };
      }

      const text = sanitizeSpeech(parsed.reply, this.maxChars());
      if (!text) {
        this.counters.errors += 1;
        const error = 'The generated reply could not be spoken after sanitizing.';
        this.manual.error = error;
        return { ok: false, reason: 'unusable-reply', error, provider: providerName, model, ms };
      }

      this.lastSuccessAt = this.now();
      this.recovery.attempts = 0;
      this.recovery.nextAt = null;
      const speechId = this.speak(
        text,
        { ...parsed, providerName, model, ms },
        'manual',
        null,
        { priority: PRIORITY.direct }
      );

      return {
        ok: true,
        text,
        emotion: parsed.emotion || 'happy',
        speechId,
        provider: providerName,
        model,
        ms,
        topic: cleanTopic,
        speech: this.speechSummary(),
      };
    } catch (error) {
      const message = redactSecret(error?.message || 'AI provider request failed', '').slice(0, 300);
      this.manual.error = message;
      this.lastError = message;
      this.lastErrorAt = this.now();
      this.counters.errors += 1;
      this.logger?.warn?.(`Manual Zappy line failed: ${message}`);
      this.store?.log?.({ category: 'ai', level: 'warn', message: `Manual Zappy line failed: ${message}` });
      return { ok: false, reason: 'error', error: message, provider: this.ai.activeProvider?.()?.name || null };
    } finally {
      this.manual.active = false;
      if (this.activeRequest && this.activeRequest.id === request.id) {
        this.activeRequest = null;
        this.inFlight = false;
      }
      this.drainQueue();
    }
  }

  // ------------------------------------------------------------------ reset

  /** RESET FOR NEW LIVE: conversation memory belongs to one LIVE session only. */
  resetSessionMemory() {
    this.epoch += 1;
    this.sessionSeq += 1;
    this.sessionId = `live-${this.now()}-${this.sessionSeq}`;
    this.sessionStartedAt = this.now();
    clearTimeout(this.pending?.timer);
    clearTimeout(this.drainTimer);
    this.memory.chats = [];
    this.memory.replies = [];
    this.memory.turns = [];
    this.memory.lastUser.clear();
    this.memory.seenTexts.clear();
    this.pending = null;
    this.queue = [];
    this.manual = { active: false, startedAt: null, id: null, topic: null, error: null };
    this.activeRequest = null;
    this.inFlight = false;
    this.speaking = false;
    this.speakingId = null;
    this.tts.state = 'idle';
    this.tts.activeId = null;
    this.tts.text = '';
    this.tts.error = null;
    this.tts.lastSpokenAt = null;
    this.tts.lastSpokenText = '';
    this.tts.lastStartedAt = null;
    this.lastMatch = null;
    this.lastGift = null;
    this.lastReplyAt = 0;
    this.lastChatReplyAt = 0;
    this.lastEventReplyAt = 0;
    this.lastSuccessAt = 0;
    this.lastChatAt = this.now();
    this.recovery.attempts = 0;
    this.recovery.nextAt = null;
    this.scheduleAutonomous();
    this.logger?.info?.('AI co-host memory cleared for the new LIVE session.');
  }

  // ------------------------------------------------------------------ admin

  /** Real test request to the active provider; no canned or simulated line. */
  async testResponse() {
    const started = this.now();
    const messages = this.buildMessages({ trigger: 'test', candidates: [], event: null });
    try {
      // The admin test is a single diagnostic request, not a live turn: it never
      // enters the queue and never speaks.
      const { response, parsed } = await this.requestParsed(messages, { alwaysActive: false });
      if (!parsed.reply) {
        // Never surface raw model output (it can contain reasoning or prompt text).
        return {
          ok: false,
          response: '',
          error: 'The active provider did not return a usable JSON reply. Try TEST AI RESPONSE again or choose another provider.',
          provider: response?.providerName || this.ai.activeProvider?.()?.name || null,
          model: response?.model || null,
          ms: Number.isFinite(response?.ms) ? response.ms : Math.max(0, this.now() - started),
          speech: this.speechSummary(),
        };
      }
      return {
        ok: true,
        response: parsed.reply,
        emotion: parsed.emotion,
        provider: response?.providerName || this.ai.activeProvider?.()?.name || null,
        model: response?.model || null,
        ms: Number.isFinite(response?.ms) ? response.ms : Math.max(0, this.now() - started),
        speech: this.speechSummary(),
      };
    } catch (error) {
      return {
        ok: false,
        response: '',
        error: redactSecret(error?.message || 'AI request failed', '').slice(0, 300),
        provider: this.ai.activeProvider?.()?.name || null,
        speech: this.speechSummary(),
      };
    }
  }

  speechSummary() {
    const now = this.now();
    return {
      state: this.tts.state,
      speaking: this.isSpeaking(),
      pending: this.tts.state === 'pending',
      lastSpokenAt: this.tts.lastSpokenAt,
      lastSpokenText: this.tts.lastSpokenText,
      msSinceSpoken: this.tts.lastSpokenAt ? Math.max(0, now - this.tts.lastSpokenAt) : null,
      error: this.tts.error,
      errorAt: this.tts.errorAt,
      skipped: this.tts.skipped,
      voicesAvailable: this.tts.voicesAvailable,
      voiceCount: this.tts.voiceCount,
      note: this.tts.note || null,
    };
  }

  providerStatus() {
    const now = this.now();
    if (!this.ai?.activeProvider?.()) return 'NO PROVIDER';
    if (
      this.lastErrorAt &&
      (!this.lastSuccessAt || this.lastErrorAt >= this.lastSuccessAt) &&
      now - this.lastErrorAt < 120000
    ) {
      return 'ERROR';
    }
    if (this.lastSuccessAt) return 'OK';
    return 'UNTESTED';
  }

  /** Honest state: SPEAKING only once the overlay confirmed real speech. */
  stateLabel() {
    if (this.closed || !this.enabled()) return 'IDLE';
    if (this.isSpeaking()) return 'SPEAKING';
    if (this.recovery.nextAt && this.recovery.lastAt) return 'RECOVERING';
    if (this.inFlight) return this.activeRequest?.step === 'generating' ? 'GENERATING' : 'THINKING';
    if (this.queue.length) return 'QUEUED';
    const now = this.now();
    if (this.lastErrorAt && (!this.lastSuccessAt || this.lastErrorAt >= this.lastSuccessAt) && now - this.lastErrorAt < 120000) {
      return 'ERROR';
    }
    return 'IDLE';
  }

  status() {
    const active = this.ai?.activeProvider?.() || null;
    const settings = this.settings;
    const now = this.now();
    return {
      enabled: this.enabled(),
      state: this.stateLabel(),
      session: { id: this.sessionId, startedAt: this.sessionStartedAt },
      settings: {
        alwaysActive: this.alwaysActive(),
        chatResponses: settings.aiChatResponses !== false,
        gameCommentary: settings.aiGameCommentary !== false,
        giftReactions: settings.aiGiftReactions !== false,
        autonomous: this.autonomousOn(),
        watchdog: this.watchdogOn(),
        randomConversation: this.autonomousOn(),
        frequency: settings.aiFrequency || 'normal',
        cooldownSec: this.cooldownMs() / 1000,
        maxChars: this.maxChars(),
        temperature: this.temperature(),
        timeoutSec: Math.round(this.timeout() / 1000),
        maxRetries: this.maxRetries(),
        minIdleSec: Math.round(this.minIdleMs() / 1000),
        maxIdleSec: Math.round(this.maxIdleMs() / 1000),
      },
      activeProvider: active
        ? { id: active.id, name: active.name, providerType: active.providerType, model: active.model }
        : null,
      provider: {
        status: this.providerStatus(),
        name: active?.name || null,
        model: active?.model || null,
        lastSuccessAt: this.lastSuccessAt || null,
        lastErrorAt: this.lastErrorAt,
      },
      request: {
        id: this.activeRequest?.id ?? null,
        trigger: this.activeRequest?.trigger ?? null,
        step: this.activeRequest?.step || (this.inFlight ? 'thinking' : 'idle'),
        elapsedMs: this.activeRequest ? Math.max(0, now - this.activeRequest.startedAt) : 0,
        lastRequestAt: this.lastRequestAt || null,
      },
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastResponse: this.lastResponse,
      lastSuccessAt: this.lastSuccessAt || null,
      inFlight: this.inFlight,
      queued: this.queue.length > 0,
      queue: {
        length: this.queue.length,
        max: LIMITS.maxQueue,
        items: this.queue.map((item) => ({
          trigger: item.trigger,
          priority: item.priority,
          ageMs: Math.max(0, now - item.queuedAt),
        })),
      },
      speech: this.speechSummary(),
      watchdog: {
        enabled: this.watchdogOn(),
        intervalMs: this.watchdogIntervalMs,
        last: this.lastRecovery,
        recoveries: this.counters.recoveries,
        attempts: this.recovery.attempts,
        nextAttemptAt: this.recovery.nextAt,
      },
      autonomous: {
        enabled: this.autonomousOn() && this.alwaysActive(),
        minIdleSec: Math.round(this.minIdleMs() / 1000),
        maxIdleSec: Math.round(this.maxIdleMs() / 1000),
        nextInMs: this.autonomousAt ? Math.max(0, this.autonomousAt - now) : null,
        runs: this.counters.autonomous,
      },
      manual: {
        active: this.manual.active,
        startedAt: this.manual.startedAt,
        id: this.manual.id,
        topic: this.manual.topic,
        error: this.manual.error,
      },
      counters: { ...this.counters },
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
    clearTimeout(this.drainTimer);
    clearTimeout(this.autonomousTimer);
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.autonomousTimer = null;
    this.pending = null;
    this.queue = [];
    this.engine?.off?.('session', this.onSession);
    this.engine?.off?.('fx', this.onFx);
    this.engine?.off?.('feed', this.onFeed);
  }
}
