/**
 * Authoritative game engine.
 *
 * Everything that mutates the board happens synchronously inside this class, so
 * two chat comments arriving in the same millisecond can never both claim the
 * same tile: the first call removes the tiles, the second sees empty cells.
 *
 * The engine is transport-agnostic. It emits plain events and the WebSocket hub
 * forwards them to the overlay.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { GAME_DEFAULTS } from '../config.js';
import {
  clearDownTo,
  findMove,
  generateBoard,
  isBoardCleared,
  labelOf,
  occupiedCells,
  parseCoordinate,
  remainingTiles,
  removeAll,
  removePair,
  shuffleRemaining,
} from './board.js';
import { findPath } from './matching.js';
import { levelConfig } from './levels.js';
import { mascotLine } from '../mascot/lines.js';
import {
  GIFT_NOTIFICATIONS,
  giftCoins,
  giftDedupeKey,
  resolveGiftAction,
} from '../gift-handler/gifts.js';

export const COMMANDS = ['TOP', 'ME', 'HELP', 'HINT', 'JOIN', 'RANK'];

const MOVE_PATTERN = /^([A-Z])\s*(\d{1,2})\s*(?:[,\s>|xX+-]+|\s)\s*([A-Z])\s*(\d{1,2})$/;
const COMPACT_MOVE_PATTERN = /^([A-Z])(\d{1,2})([A-Z])(\d{1,2})$/;

export function playerKeyFromEvent(event = {}) {
  const userId = event.userId ?? event.user_id;
  if (userId !== undefined && userId !== null && String(userId).trim() !== '') {
    return `id:${String(userId)}`;
  }
  const uniqueId = event.username || event.uniqueId || event.displayName || 'viewer';
  return `name:${String(uniqueId).trim().toLowerCase()}`;
}

export function parseCommand(rawText, cols = 10, rows = 10) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^[!/]+/, '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!cleaned) return null;

  if (COMMANDS.includes(cleaned)) return { kind: 'command', name: cleaned };

  const compact = cleaned.replace(/\s+/g, '');
  const match = MOVE_PATTERN.exec(cleaned) || COMPACT_MOVE_PATTERN.exec(compact);
  if (match) {
    const first = `${match[1]}${match[2]}`;
    const second = `${match[3]}${match[4]}`;
    const a = parseCoordinate(first, cols, rows);
    const b = parseCoordinate(second, cols, rows);
    if (!a || !b) return { kind: 'move', a: null, b: null, invalid: 'out-of-range', raw: cleaned };
    return { kind: 'move', a, b, raw: cleaned };
  }

  return null;
}

const cellPayload = (cell) => ({ c: cell.c, r: cell.r, label: labelOf(cell.c - 1, cell.r - 1) });

/** A reset cannot be repeated faster than this, even from a stuck double-click. */
export const SESSION_RESET_COOLDOWN_MS = 5000;

let sessionSeq = 0;

/** Short, human-readable id for one LIVE session (monotonic + random). */
export function createSessionId(now = Date.now()) {
  sessionSeq = (sessionSeq + 1) % 1_000_000;
  const stamp = Math.floor(now).toString(36).toUpperCase();
  const seq = sessionSeq.toString(36).toUpperCase();
  return `LIVE-${stamp}-${seq}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

export class GameEngine extends EventEmitter {
  constructor({ store, settings = {}, logger = null, rng = Math.random, now = () => Date.now() }) {
    super();
    this.setMaxListeners(64);
    this.store = store;
    this.logger = logger;
    this.rng = rng;
    this.now = now;

    this.sessionId = createSessionId(this.now());
    this.sessionStartedAt = this.now();
    this.suspended = false;
    this.lastResetAt = 0;

    this.settings = { ...GAME_DEFAULTS, ...settings };
    this.state = {
      status: 'idle',
      level: 1,
      rev: 0,
      totalMatches: 0,
      levelMatches: 0,
      startedAt: null,
      autoPlay: false,
      gameOverAt: null,
      gameOverReason: null,
    };

    this.board = null;
    this.currentLevelConfig = null;
    this.runtimePlayers = new Map();
    this.pendingLevelAt = null;
    this.levelCompletePending = false;
    this.lastHumanAt = now();
    this.idleStage = 0;
    this.nextAutoMoveAt = 0;
    this.lastSayAt = 0;
    this.lastSaidKind = null;
    this.autoMoveCount = 0;

    this.recentCommands = new Map();
    this.seenGifts = new Map();
  }

  // ---------------------------------------------------------------- lifecycle

  get running() {
    return this.state.status === 'running';
  }

  start() {
    if (this.state.status === 'running') return this.snapshot();
    if (this.state.status === 'gameover') return this.restart();
    if (!this.board) this.buildLevel();
    this.state.status = 'running';
    this.state.startedAt = this.state.startedAt || this.now();
    this.lastHumanAt = this.now();
    this.idleStage = 0;
    this.pendingLevelAt = null;
    this.levelCompletePending = false;
    this.say('gameStart');
    this.emit('feed', { kind: 'system', text: 'Game started!', ts: this.now() });
    this.bumpState();
    return this.snapshot();
  }

  pause() {
    if (this.state.status !== 'running') return this.snapshot();
    this.state.status = 'paused';
    this.state.autoPlay = false;
    this.say('paused');
    this.emit('feed', { kind: 'system', text: 'Game paused.', ts: this.now() });
    this.bumpState();
    return this.snapshot();
  }

  resume() {
    if (this.state.status !== 'paused') return this.snapshot();
    this.state.status = 'running';
    this.lastHumanAt = this.now();
    this.idleStage = 0;
    this.say('resumed');
    this.emit('feed', { kind: 'system', text: 'Game resumed.', ts: this.now() });
    this.bumpState();
    return this.snapshot();
  }

  restart() {
    this.state.status = 'running';
    this.state.level = 1;
    this.state.totalMatches = 0;
    this.state.levelMatches = 0;
    this.state.startedAt = this.now();
    this.state.gameOverAt = null;
    this.state.gameOverReason = null;
    this.state.autoPlay = false;
    this.pendingLevelAt = null;
    this.levelCompletePending = false;
    this.autoMoveCount = 0;
    this.runtimePlayers.clear();
    this.recentCommands.clear();
    this.buildLevel();
    this.lastHumanAt = this.now();
    this.idleStage = 0;
    this.say('gameStart');
    this.emit('feed', { kind: 'system', text: 'New game started at level 1!', ts: this.now() });
    this.bumpState();
    return this.snapshot();
  }

  stopGame(reason = 'Super large gift') {
    if (this.state.status === 'gameover') return this.snapshot();
    this.state.status = 'gameover';
    this.state.autoPlay = false;
    this.state.gameOverAt = this.now();
    this.state.gameOverReason = reason;
    this.pendingLevelAt = null;
    this.say('gameOver');
    this.emit('fx', { kind: 'gameover', reason, ts: this.now() });
    this.emit('feed', { kind: 'gameover', text: `GAME OVER - ${reason}`, ts: this.now() });
    this.bumpState();
    return this.snapshot();
  }

  setAutoPlay(enabled) {
    this.settings.autoPlayEnabled = Boolean(enabled);
    if (!this.settings.autoPlayEnabled) {
      this.state.autoPlay = false;
    } else {
      this.lastHumanAt = this.now();
      this.idleStage = 0;
    }
    this.bumpState();
    return this.snapshot();
  }

  resetLeaderboard() {
    this.store.resetLeaderboard();
    for (const rt of this.runtimePlayers.values()) rt.combo = 0;
    this.emit('feed', { kind: 'system', text: 'Leaderboard reset.', ts: this.now() });
    this.emitLeaderboard();
    return this.leaderboard();
  }

  /**
   * True when an event cannot belong to the session that is running now.
   *
   * TikTok/TikFinity events carry a timestamp in milliseconds for some kinds and
   * seconds for others, so only plausible epoch-millisecond values are compared.
   * An explicit mismatched sessionId is always stale.
   */
  isStaleEvent(event = {}) {
    if (!event || typeof event !== 'object') return false;
    if (event.sessionId && event.sessionId !== this.sessionId) return true;
    const raw = Number(event.ts ?? event.timestamp ?? event.receivedAt);
    if (Number.isFinite(raw) && raw > 1e11 && raw < this.sessionStartedAt - 5000) return true;
    return false;
  }

  /**
   * Reset everything the streamer does not want on a real LIVE, atomically.
   *
   * Order matters: the database transaction runs first, so a storage failure
   * leaves the in-memory session untouched (players, board, timers, level).
   * While the reset runs, `suspended` rejects comments, gifts, moves and ticks,
   * and any event that still belongs to the old session is dropped afterwards.
   *
   * Configuration is never touched here: settings live in `this.settings` and in
   * the store's `config` row, and neither is written or cleared by this method.
   */
  resetSession({ reason = 'admin', actor = 'admin' } = {}) {
    const now = this.now();
    if (this.suspended) {
      return { ok: false, reason: 'reset-in-progress', error: 'A reset is already running.' };
    }
    if (this.lastResetAt && now - this.lastResetAt < SESSION_RESET_COOLDOWN_MS) {
      return {
        ok: false,
        reason: 'too-soon',
        error: 'A reset just finished. Give it a few seconds before resetting again.',
        retryInMs: SESSION_RESET_COOLDOWN_MS - (now - this.lastResetAt),
      };
    }

    this.suspended = true;
    try {
      this.store.resetSession();
    } catch (error) {
      this.suspended = false;
      this.logger?.error?.('Session reset failed, previous session kept:', error.message);
      return {
        ok: false,
        reason: 'storage-failed',
        error: 'Database reset failed, so the previous session was kept.',
      };
    }

    const previousSessionId = this.sessionId;
    this.sessionId = createSessionId(now);
    this.sessionStartedAt = now;
    this.lastResetAt = now;

    // Game progress and counters.
    this.state.status = 'running';
    this.state.level = 1;
    this.state.totalMatches = 0;
    this.state.levelMatches = 0;
    this.state.startedAt = now;
    this.state.gameOverAt = null;
    this.state.gameOverReason = null;
    this.state.autoPlay = false;

    // Pending work: level transition, auto play schedule and speech cooldowns.
    this.pendingLevelAt = null;
    this.levelCompletePending = false;
    this.nextAutoMoveAt = 0;
    this.autoMoveCount = 0;
    this.idleStage = 0;
    this.lastHumanAt = now;
    this.lastSayAt = 0;
    this.lastSaidKind = null;
    this.saidAt?.clear();

    // Temporary per-player state: combos, cooldowns, hint/dedupe caches.
    this.runtimePlayers.clear();
    this.recentCommands.clear();
    this.seenGifts.clear();

    // Fresh, solvable Level 1 board.
    this.buildLevel();
    this.bumpRev();

    const payload = {
      action: 'reset',
      sessionId: this.sessionId,
      previousSessionId,
      startedAt: now,
      level: this.state.level,
      ts: now,
      actor,
      reason,
    };

    this.emit('session', payload);
    this.emit('feed', { kind: 'system', text: 'New LIVE session started - fresh Level 1 board!', ts: now });
    this.emit('leaderboard', this.leaderboard());
    this.emit('state', this.snapshot());
    this.emit('mascot', { text: "Fresh game! Let's play!", emotion: 'excited', priority: 3, ts: now });

    this.suspended = false;
    return { ok: true, ...payload, game: this.snapshot(), leaderboard: this.leaderboard() };
  }

  // ------------------------------------------------------------------- levels

  buildLevel() {
    const cfg = levelConfig(this.state.level, this.settings);
    this.currentLevelConfig = cfg;
    this.board = generateBoard({ cols: cfg.cols, rows: cfg.rows, types: cfg.types, rng: this.rng });
    this.state.levelMatches = 0;
    this.levelCompletePending = false;
    this.pendingLevelAt = null;
    this.bumpRev();
  }

  advanceLevel() {
    this.pendingLevelAt = null;
    this.levelCompletePending = false;
    this.state.level += 1;
    this.buildLevel();
    this.emit('fx', { kind: 'newLevel', level: this.state.level, ts: this.now() });
    this.say('newLevel');
    this.emit('feed', { kind: 'level', text: `Level ${this.state.level} started!`, ts: this.now() });
    this.bumpState();
  }

  completeLevel({ playerId = null, via = 'cleared' } = {}) {
    if (this.levelCompletePending) return;
    this.levelCompletePending = true;
    this.pendingLevelAt = this.now() + (via === 'gift' ? 1800 : 3000);
    this.state.autoPlay = false;

    if (playerId) {
      this.store.addScore(playerId, { points: 50, matches: 0, attempts: 0 });
      this.emit('feed', {
        kind: 'bonus',
        username: this.runtimePlayers.get(playerId)?.username || 'player',
        text: 'Level clear bonus +50',
        ts: this.now(),
      });
    }

    this.emit('fx', { kind: 'levelComplete', level: this.state.level, ts: this.now() });
    this.say('levelComplete');
    this.emit('feed', { kind: 'level', text: `Level ${this.state.level} cleared!`, ts: this.now() });
    this.emitLeaderboard();
    this.bumpState();
  }

  afterBoardChange() {
    if (isBoardCleared(this.board)) {
      this.completeLevel();
      return;
    }
    if (!findMove(this.board)) {
      this.shuffleBoard('no-moves-left');
    }
  }

  shuffleBoard(reason = 'manual') {
    if (!this.board || isBoardCleared(this.board)) return;
    shuffleRemaining(this.board, this.rng);
    this.emit('fx', { kind: 'shuffle', reason, ts: this.now() });
    this.say('shuffle');
    this.emit('feed', { kind: 'shuffle', text: 'No moves left - board reshuffled!', ts: this.now() });
    this.bumpRev();
    this.emit('state', this.snapshot());
  }

  // ------------------------------------------------------------------- input

  runtime(playerId, username) {
    let rt = this.runtimePlayers.get(playerId);
    if (!rt) {
      rt = { playerId, username, combo: 0, bestCombo: 0, lastCommandAt: 0, lastMoveAt: 0, misses: 0 };
      this.runtimePlayers.set(playerId, rt);
    }
    if (username) rt.username = username;
    return rt;
  }

  markHumanActivity() {
    this.lastHumanAt = this.now();
    this.idleStage = 0;
    if (this.state.autoPlay) {
      this.state.autoPlay = false;
      this.emit('feed', { kind: 'system', text: 'Human player took over!', ts: this.now() });
      this.bumpState();
    }
  }

  /**
   * Handle one normalized chat event.
   * @returns {{ok:boolean, reason?:string, type?:string}}
   */
  handleChat(event = {}) {
    if (this.suspended) return { ok: false, reason: 'reset-in-progress' };
    if (this.isStaleEvent(event)) return { ok: false, reason: 'stale-session' };
    const text = String(event.text ?? event.comment ?? '').trim();
    if (!text) return { ok: false, reason: 'empty' };

    const cols = this.board ? this.board.cols : 10;
    const rows = this.board ? this.board.rows : 10;
    const cmd = parseCommand(text, cols, rows);
    if (!cmd) return { ok: false, reason: 'not-a-command' };

    const now = this.now();
    const playerId = playerKeyFromEvent(event);
    const username = String(event.username || event.uniqueId || event.displayName || 'viewer').slice(0, 32);

    // Identical command from the same user inside 4s is a duplicate delivery or
    // an impatient double-send: process it exactly once.
    const dedupeKey = `${playerId}|${text.toLowerCase().replace(/\s+/g, ' ')}`;
    const seenAt = this.recentCommands.get(dedupeKey);
    if (seenAt && now - seenAt < 4000) {
      return { ok: false, reason: 'duplicate' };
    }

    const rt = this.runtime(playerId, username);
    const isBoardCommand = cmd.kind === 'move' || (cmd.kind === 'command' && cmd.name === 'HINT');
    const gap = isBoardCommand ? this.settings.cooldownMs : Math.max(800, Math.floor(this.settings.cooldownMs / 2));
    if (now - rt.lastCommandAt < gap) {
      this.notify(playerId, username, 'Easy there! Give it a couple of seconds.');
      return { ok: false, reason: 'cooldown' };
    }
    rt.lastCommandAt = now;
    this.markHumanActivity();

    this.store.ensurePlayer({ id: playerId, username, displayName: event.displayName || username });

    let outcome;
    if (cmd.kind === 'move') {
      if (cmd.invalid) {
        this.notify(playerId, username, 'Those coordinates are outside the board.');
        outcome = { ok: false, reason: 'out-of-range' };
      } else {
        outcome = this.performMove(playerId, username, cmd.a, cmd.b);
      }
    } else {
      outcome = this.handleNamedCommand(cmd.name, playerId, username);
    }

    // Remember handled commands so a redelivered TikTok message is not played
    // twice. A command the game could not accept (paused, game over, level
    // transition) is NOT remembered, so the player's honest retry still works.
    const deferrable = ['paused', 'gameover', 'level-transition', 'no-board'];
    if (!deferrable.includes(outcome.reason)) {
      if (this.recentCommands.size > 800) this.recentCommands.clear();
      this.recentCommands.set(dedupeKey, now);
    }

    return outcome;
  }

  handleNamedCommand(name, playerId, username) {
    switch (name) {
      case 'JOIN': {
        const player = this.store.ensurePlayer({ id: playerId, username });
        this.say('join');
        this.notify(playerId, username, `You're in! ${player.score} points, type A1 B1 to play.`);
        this.emitLeaderboard();
        return { ok: true, type: 'join' };
      }
      case 'HELP': {
        this.notify(playerId, username, 'Comment two tiles like A1 B1. Commands: TOP ME RANK JOIN HINT.');
        this.emit('overlay', { mode: 'help', username, ts: this.now() });
        return { ok: true, type: 'help' };
      }
      case 'TOP': {
        const top = this.store.listTop(5);
        if (!top.length) this.notify(playerId, username, 'No scores yet - be the first!');
        else {
          const list = top.map((p, i) => `${i + 1}. ${p.username} ${p.score}`).join(' | ');
          this.notify(playerId, username, list);
        }
        this.emit('overlay', { mode: 'leaderboard', username, ts: this.now() });
        this.emitLeaderboard();
        return { ok: true, type: 'top' };
      }
      case 'ME': {
        const player = this.store.getPlayer(playerId);
        if (!player) this.notify(playerId, username, 'You are not on the board yet. Type JOIN!');
        else this.notify(playerId, username, `${player.username}: ${player.score} points, ${player.matches} matches.`);
        return { ok: true, type: 'me' };
      }
      case 'RANK': {
        const rank = this.store.rankOf(playerId, 'score');
        if (!rank) this.notify(playerId, username, 'No rank yet. Type JOIN and start matching!');
        else this.notify(playerId, username, `Your rank is #${rank} with ${this.store.getPlayer(playerId)?.score ?? 0} points.`);
        return { ok: true, type: 'rank' };
      }
      case 'HINT': {
        if (!this.running) {
          this.notify(playerId, username, 'The game is not running right now.');
          return { ok: false, reason: 'not-running' };
        }
        const move = this.board ? findMove(this.board) : null;
        if (!move) {
          this.notify(playerId, username, 'No hint available - shuffling!');
          if (this.board) this.shuffleBoard('hint');
          return { ok: true, type: 'hint-shuffle' };
        }
        this.emitHint(move, { username, kind: 'hint' });
        this.say('hint');
        this.notify(playerId, username, `Try ${labelOf(move.a.c - 1, move.a.r - 1)} and ${labelOf(move.b.c - 1, move.b.r - 1)}!`);
        return { ok: true, type: 'hint' };
      }
      default:
        return { ok: false, reason: 'unknown-command' };
    }
  }

  emitHint(move, extra = {}) {
    this.emit('fx', {
      kind: 'hint',
      a: cellPayload(move.a),
      b: cellPayload(move.b),
      path: move.path,
      ts: this.now(),
      ...extra,
    });
  }

  /**
   * Validate and apply a move. Board mutation is synchronous and atomic.
   */
  performMove(playerId, username, a, b) {
    if (this.suspended) return { ok: false, reason: 'reset-in-progress' };
    const now = this.now();
    if (this.state.status === 'gameover') {
      this.notify(playerId, username, 'The game is over. Waiting for a restart!');
      return { ok: false, reason: 'gameover' };
    }
    if (this.state.status !== 'running') {
      this.notify(playerId, username, 'The game is paused right now.');
      return { ok: false, reason: 'paused' };
    }
    if (!this.board) return { ok: false, reason: 'no-board' };
    if (this.pendingLevelAt || this.levelCompletePending) {
      this.notify(playerId, username, 'Next level is loading - hold on!');
      return { ok: false, reason: 'level-transition' };
    }

    const grid = this.board.grid;
    const typeA = grid[a.r]?.[a.c];
    const typeB = grid[b.r]?.[b.c];

    if (typeA === undefined || typeA === null || typeB === undefined || typeB === null) {
      this.store.ensurePlayer({ id: playerId, username });
      this.store.addAttempt(playerId);
      this.emit('fx', { kind: 'attempt', a: cellPayload(a), b: cellPayload(b), ok: false, username, reason: 'empty', ts: now });
      this.emit('feed', { kind: 'invalid', username, text: `${a.label} / ${b.label}: tiles are already gone.`, ts: now });
      return { ok: false, reason: 'empty-tile' };
    }

    const path = a.c === b.c && a.r === b.r ? null : findPath(grid, a, b);
    if (!path) {
      const rt = this.runtime(playerId, username);
      rt.combo = 0;
      rt.misses += 1;
      this.store.ensurePlayer({ id: playerId, username });
      this.store.addAttempt(playerId);
      this.emit('fx', { kind: 'attempt', a: cellPayload(a), b: cellPayload(b), ok: false, username, ts: now });
      this.emit('feed', {
        kind: 'invalid',
        username,
        text: typeA === typeB ? `${a.label} / ${b.label}: no clear path.` : `${a.label} / ${b.label}: not a matching pair.`,
        ts: now,
      });
      this.maybeSay('invalid', 1, 9000);
      return { ok: false, reason: typeA === typeB ? 'blocked' : 'mismatch' };
    }

    // --- valid move
    removePair(this.board, a, b);
    this.state.totalMatches += 1;
    this.state.levelMatches += 1;

    const rt = this.runtime(playerId, username);
    rt.combo += 1;
    rt.bestCombo = Math.max(rt.bestCombo, rt.combo);
    rt.lastMoveAt = now;

    let bonus = 0;
    if (rt.combo >= 2) bonus += Math.min(rt.combo - 1, 8) * 2;
    if (rt.combo === 5) bonus += 25;
    const points = 10 + bonus;

    const beforeLeader = this.store.listTop(1)[0] || null;
    this.store.ensurePlayer({ id: playerId, username });
    this.store.addScore(playerId, { points, matches: 1, attempts: 1 });
    const afterLeader = this.store.listTop(1)[0] || null;

    this.emit('fx', {
      kind: 'match',
      a: cellPayload(a),
      b: cellPayload(b),
      path: path.points,
      turns: path.turns,
      username,
      points,
      combo: rt.combo,
      ts: now,
    });
    this.emit('feed', {
      kind: 'match',
      username,
      text: `${a.label} + ${b.label}  +${points}${rt.combo > 1 ? ` (combo x${rt.combo})` : ''}`,
      ts: now,
    });

    if (rt.combo === 5) {
      this.say('bigCombo');
      this.emit('feed', { kind: 'combo', username, text: `${username} is on a 5 match streak!`, ts: now });
    } else {
      this.maybeSay('match', 1, 2200);
    }

    if (afterLeader && afterLeader.score > 0 && (!beforeLeader || beforeLeader.id !== afterLeader.id)) {
      this.say('newChampion');
      this.emit('feed', { kind: 'champion', username: afterLeader.username, text: `${afterLeader.username} takes the lead!`, ts: now });
    }

    this.bumpRev();
    this.emit('state', this.snapshot());
    this.emitLeaderboard();
    this.afterBoardChange();
    if (isBoardCleared(this.board)) this.emit('state', this.snapshot());

    return { ok: true, reason: 'matched', points, combo: rt.combo, label: `${a.label} ${b.label}` };
  }

  // -------------------------------------------------------------------- gifts

  /**
   * Handle one normalized gift event. Streak parts are acknowledged but only
   * the completed streak triggers a game action.
   */
  handleGift(event = {}) {
    if (this.suspended) return { ok: false, reason: 'reset-in-progress' };
    if (this.isStaleEvent(event)) return { ok: false, reason: 'stale-session' };
    const now = this.now();
    const giftId = event.giftId ?? event.gift_id;
    if (giftId === undefined || giftId === null || String(giftId) === '') {
      return { ok: false, reason: 'invalid-gift' };
    }

    const dedupeKey = giftDedupeKey(event);
    if (this.seenGifts.has(dedupeKey)) {
      this.store.log({ category: 'gift', level: 'debug', message: `Duplicate gift ignored (${event.giftName || giftId})`, meta: { dedupeKey } });
      return { ok: false, reason: 'duplicate' };
    }
    this.seenGifts.set(dedupeKey, now);
    if (this.seenGifts.size > 2000) {
      for (const [key, ts] of this.seenGifts) {
        if (now - ts > 15 * 60 * 1000) this.seenGifts.delete(key);
      }
    }

    const playerId = playerKeyFromEvent(event);
    const username = String(event.username || event.uniqueId || event.displayName || 'viewer').slice(0, 32);

    if (event.repeatEnd === false) {
      this.emit('feed', {
        kind: 'gift-streak',
        username,
        text: `${username} is sending ${event.giftName || 'a gift'}...`,
        ts: now,
      });
      return { ok: true, deferred: true, reason: 'streak-in-progress' };
    }

    const coins = giftCoins(event);
    const count = Math.max(1, Number(event.repeatCount ?? event.count ?? 1));

    this.store.ensurePlayer({ id: playerId, username, displayName: event.displayName || username });
    this.store.addGift(playerId, { coins, count });
    try {
      this.store.recordGift({ giftId: String(giftId), name: event.giftName, coins: Number(event.diamondCount ?? coins) });
    } catch (error) {
      this.logger?.warn?.('Could not record gift metadata:', error.message);
    }

    const resolution = resolveGiftAction({ ...event, coins }, this.settings);

    this.emit('feed', {
      kind: 'gift',
      username,
      text: `${username} sent ${event.giftName || 'a gift'} (${coins} coins) -> ${resolution.action}`,
      ts: now,
      meta: { giftId: String(giftId), coins, action: resolution.action, tier: resolution.tier },
    });

    if (!resolution.enabled || resolution.action === 'NONE') {
      this.notify(playerId, username, `Gift received! ${resolution.reason || 'No game effect is mapped to it yet.'}`);
      this.emit('fx', { kind: 'gift', username, giftName: event.giftName, coins, action: 'NONE', ts: now });
      this.emitLeaderboard();
      return { ok: true, action: 'NONE', reason: resolution.reason };
    }

    const effectiveAction = this.executeGiftAction(resolution.action, {
      playerId,
      username,
      event,
      resolution,
      coins,
      count,
    });
    this.emitLeaderboard();
    return { ok: true, action: effectiveAction, requestedAction: resolution.action, tier: resolution.tier, coins };
  }

  executeGiftAction(action, { playerId, username, event, resolution, coins }) {
    if (!this.board) {
      this.notify(playerId, username, 'Gift received! The game is not ready yet.');
      return 'NONE';
    }

    const notifications = {
      ...GIFT_NOTIFICATIONS,
    };

    if (this.state.status === 'gameover' && action !== 'STOP_GAME') {
      this.emit('fx', { kind: 'gift', username, giftName: event.giftName, coins, action, ts: this.now() });
      this.notify(playerId, username, 'Thanks for the gift! The game is over until the streamer restarts it.');
      return 'NONE';
    }

    switch (action) {
      case 'HINT':
      case 'REVEAL_PAIR': {
        const move = findMove(this.board);
        if (!move) {
          this.shuffleBoard('gift-no-moves');
          return 'NONE';
        }
        this.emit('fx', {
          kind: action === 'HINT' ? 'hint' : 'reveal',
          a: cellPayload(move.a),
          b: cellPayload(move.b),
          path: move.path,
          username,
          giftName: event.giftName,
          ts: this.now(),
        });
        this.say(action === 'HINT' ? 'hint' : 'reveal');
        this.notify(playerId, username, notifications[action]);
        this.emit('feed', { kind: 'gift-effect', username, text: notifications[action], ts: this.now() });
        return action;
      }
      case 'CLEAR_HALF_BOARD': {
        if (this.state.status !== 'running') {
          this.notify(playerId, username, 'Thanks for the gift! The game is paused right now.');
          return 'NONE';
        }
        const before = remainingTiles(this.board);
        const target = Math.max(0, Math.ceil(before / 2));
        const removed = clearDownTo(this.board, target, this.rng);
        this.state.totalMatches += removed.length;
        this.state.levelMatches += removed.length;
        this.emit('fx', {
          kind: 'clearHalf',
          pairs: removed.map((move) => ({ a: cellPayload(move.a), b: cellPayload(move.b), path: move.path })),
          removed: removed.length * 2,
          username,
          ts: this.now(),
        });
        this.say('halfBoard');
        this.notify(playerId, username, notifications.CLEAR_HALF_BOARD);
        this.emit('feed', {
          kind: 'gift-effect',
          username,
          text: `${notifications.CLEAR_HALF_BOARD} (${removed.length * 2} tiles)`,
          ts: this.now(),
        });
        this.bumpRev();
        this.emit('state', this.snapshot());
        this.afterBoardChange();
        return 'CLEAR_HALF_BOARD';
      }
      case 'COMPLETE_LEVEL': {
        if (this.state.status !== 'running') {
          this.notify(playerId, username, 'Thanks for the gift! The game is paused right now.');
          return 'NONE';
        }
        const cells = occupiedCells(this.board);
        removeAll(this.board);
        this.state.totalMatches += Math.floor(cells.length / 2);
        this.emit('fx', {
          kind: 'clearAll',
          cells: cells.map(cellPayload),
          username,
          ts: this.now(),
        });
        this.say('complete');
        this.notify(playerId, username, notifications.COMPLETE_LEVEL);
        this.emit('feed', { kind: 'gift-effect', username, text: notifications.COMPLETE_LEVEL, ts: this.now() });
        this.bumpRev();
        this.emit('state', this.snapshot());
        this.completeLevel({ via: 'gift' });
        return 'COMPLETE_LEVEL';
      }
      case 'STOP_GAME': {
        if (!this.settings.stopGameEnabled) {
          this.store.log({
            category: 'gift',
            level: 'warn',
            message: 'STOP_GAME gift received but the feature is disabled in the admin dashboard.',
            meta: { giftId: event.giftId, username },
          });
          this.notify(playerId, username, 'Gift received! The game-over gift is turned off, so here is a free pair instead.');
          return this.executeGiftAction('REVEAL_PAIR', { playerId, username, event, resolution, coins });
        }
        this.stopGame(`Super large gift from ${username}`);
        return 'STOP_GAME';
      }
      default:
        this.notify(playerId, username, 'Gift received!');
        return action;
    }
  }

  // --------------------------------------------------------------------- tick

  tick() {
    if (this.suspended) return;
    const now = this.now();

    if (this.seenGifts.size > 0) {
      for (const [key, ts] of this.seenGifts) {
        if (now - ts > 15 * 60 * 1000) this.seenGifts.delete(key);
      }
    }

    if (this.state.status !== 'running') return;
    if (this.pendingLevelAt !== null && now >= this.pendingLevelAt) {
      this.advanceLevel();
      return;
    }
    if (!this.board || this.pendingLevelAt !== null) return;
    if (isBoardCleared(this.board)) return;

    const idle = now - this.lastHumanAt;

    if (!this.settings.autoPlayEnabled) return;

    if (!this.state.autoPlay) {
      if (idle >= 15000 && this.idleStage < 1) {
        this.idleStage = 1;
        this.maybeSay('idle15', 2, 0);
      }
      if (idle >= 30000 && this.idleStage < 2) {
        this.idleStage = 2;
        this.maybeSay('idle30', 2, 0);
      }
      if (idle >= this.settings.autoPlayIdleMs && this.idleStage < 3) {
        this.idleStage = 3;
        this.state.autoPlay = true;
        this.nextAutoMoveAt = now + 700;
        this.maybeSay('idle60', 3, 0);
        this.emit('feed', { kind: 'system', text: 'Auto play is on.', ts: now });
        this.bumpState();
      }
      return;
    }

    if (now >= this.nextAutoMoveAt) this.autoMove(now);
  }

  autoMove(now) {
    if (!this.board) return;
    const move = findMove(this.board);
    if (!move) {
      this.shuffleBoard('auto-no-moves');
      this.nextAutoMoveAt = now + 1200;
      return;
    }

    removePair(this.board, move.a, move.b);
    this.state.totalMatches += 1;
    this.state.levelMatches += 1;
    this.autoMoveCount += 1;

    this.emit('fx', {
      kind: 'match',
      a: cellPayload(move.a),
      b: cellPayload(move.b),
      path: move.path,
      turns: move.turns,
      username: 'Zappy',
      points: 0,
      auto: true,
      ts: now,
    });
    this.emit('feed', {
      kind: 'auto',
      text: `Auto play: ${labelOf(move.a.c - 1, move.a.r - 1)} + ${labelOf(move.b.c - 1, move.b.r - 1)}`,
      ts: now,
    });

    this.nextAutoMoveAt = now + Math.max(600, this.settings.autoPlayMoveMs);
    this.bumpRev();
    this.emit('state', this.snapshot());
    this.afterBoardChange();
    if (this.autoMoveCount % 4 === 0 && !isBoardCleared(this.board)) this.say('autoPlay');
  }

  // ------------------------------------------------------------------ effects

  say(kind, override = {}) {
    if (!this.settings.mascotEnabled) return;
    const line = mascotLine(kind, this.rng);
    const priority = override.priority ?? line.priority;
    const now = this.now();
    const gap = priority >= 2 ? 0 : 1500;
    if (now - this.lastSayAt < gap) return;
    this.lastSayAt = now;
    this.lastSaidKind = kind;
    this.emit('mascot', { ...line, ...override, ts: now });
  }

  /** Same as say() but with a per-kind cooldown so reactions never spam. */
  maybeSay(kind, priority = 1, minGapMs = 4000) {
    const now = this.now();
    this.saidAt = this.saidAt || new Map();
    const last = this.saidAt.get(kind) || 0;
    if (now - last < minGapMs) return;
    this.saidAt.set(kind, now);
    this.say(kind, { priority });
  }

  notify(userId, username, text) {
    this.emit('notice', { userId, username, text, ts: this.now() });
  }

  emitLeaderboard() {
    this.emit('leaderboard', this.leaderboard());
  }

  leaderboard() {
    const map = (list) =>
      list.map((player) => ({
        id: player.id,
        username: player.username,
        displayName: player.displayName,
        score: player.score,
        matches: player.matches,
        giftCoins: player.giftCoins,
        giftCount: player.giftCount,
      }));
    return {
      top: map(this.store.listTop(10)),
      gifters: map(this.store.listTopGifters(5)),
      active: map(this.store.listMostActive(5)),
      totalPlayers: this.store.countPlayers(),
      ts: this.now(),
    };
  }

  bumpRev() {
    this.state.rev += 1;
  }

  bumpState() {
    this.bumpRev();
    this.emit('state', this.snapshot());
  }

  snapshot() {
    const remaining = this.board ? remainingTiles(this.board) : 0;
    return {
      rev: this.state.rev,
      sessionId: this.sessionId,
      sessionStartedAt: this.sessionStartedAt,
      status: this.state.status,
      level: this.state.level,
      cols: this.board?.cols ?? this.settings.cols,
      rows: this.board?.rows ?? this.settings.rows,
      grid: this.board ? this.board.grid : null,
      remaining,
      totalMatches: this.state.totalMatches,
      levelMatches: this.state.levelMatches,
      autoPlay: this.state.autoPlay,
      autoPlayEnabled: this.settings.autoPlayEnabled,
      cooldownMs: this.settings.cooldownMs,
      startedAt: this.state.startedAt,
      gameOverAt: this.state.gameOverAt,
      gameOverReason: this.state.gameOverReason,
      levelTransition: this.pendingLevelAt !== null,
      levelConfig: this.currentLevelConfig,
      music: {
        enabled: this.settings.musicEnabled,
        volume: this.settings.musicVolume,
        shuffle: this.settings.musicShuffle,
      },
      ts: this.now(),
    };
  }

  publicSettings() {
    return {
      mascotEnabled: this.settings.mascotEnabled,
      voiceEnabled: this.settings.voiceEnabled,
      voiceVolume: this.settings.voiceVolume,
      speechFrequency: this.settings.speechFrequency,
      mascotSpeed: this.settings.mascotSpeed,
      musicEnabled: this.settings.musicEnabled,
      musicVolume: this.settings.musicVolume,
      musicShuffle: this.settings.musicShuffle,
      moveSpeed: this.settings.moveSpeed,
      cooldownMs: this.settings.cooldownMs,
      autoPlayEnabled: this.settings.autoPlayEnabled,
      autoPlayIdleMs: this.settings.autoPlayIdleMs,
      stopGameEnabled: this.settings.stopGameEnabled,
      aiMascotEnabled: this.settings.aiMascotEnabled !== false,
      aiChatResponses: this.settings.aiChatResponses !== false,
      aiGameCommentary: this.settings.aiGameCommentary !== false,
      aiGiftReactions: this.settings.aiGiftReactions !== false,
      aiAlwaysActive: this.settings.aiAlwaysActive !== false,
      aiAutonomous: this.settings.aiAutonomous !== false,
      aiWatchdog: this.settings.aiWatchdog !== false,
      aiTwoMascots: this.settings.aiTwoMascots !== false,
      aiMascotConversation: this.settings.aiMascotConversation !== false,
      aiMascotOneEnabled: this.settings.aiMascotOneEnabled !== false,
      aiMascotTwoEnabled: this.settings.aiMascotTwoEnabled !== false,
      aiViewerPriority: this.settings.aiViewerPriority !== false,
    };
  }

  applySettings(patch = {}) {
    const numeric = (value, fallback, min, max) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, parsed));
    };

    const next = { ...this.settings };
    if (patch.cols !== undefined) next.cols = numeric(patch.cols, next.cols, 4, 10);
    if (patch.rows !== undefined) next.rows = numeric(patch.rows, next.rows, 4, 10);
    if (patch.boardSizeMode === 'auto' || patch.boardSizeMode === 'fixed') next.boardSizeMode = patch.boardSizeMode;
    if (['easy', 'normal', 'hard'].includes(patch.difficulty)) next.difficulty = patch.difficulty;
    if (patch.tileTypes !== undefined) next.tileTypes = numeric(patch.tileTypes, next.tileTypes, 0, 15);
    if (patch.cooldownMs !== undefined) next.cooldownMs = numeric(patch.cooldownMs, next.cooldownMs, 500, 30000);
    if (patch.autoPlayIdleMs !== undefined) next.autoPlayIdleMs = numeric(patch.autoPlayIdleMs, next.autoPlayIdleMs, 5000, 600000);
    if (patch.autoPlayMoveMs !== undefined) next.autoPlayMoveMs = numeric(patch.autoPlayMoveMs, next.autoPlayMoveMs, 500, 20000);
    if (patch.moveSpeed !== undefined) next.moveSpeed = numeric(patch.moveSpeed, next.moveSpeed, 0.25, 3);
    if (patch.mascotSpeed !== undefined) next.mascotSpeed = numeric(patch.mascotSpeed, next.mascotSpeed, 0.25, 3);
    if (patch.voiceVolume !== undefined) next.voiceVolume = numeric(patch.voiceVolume, next.voiceVolume, 0, 1);
    if (patch.musicVolume !== undefined) next.musicVolume = numeric(patch.musicVolume, next.musicVolume, 0, 1);
    if (patch.aiCooldownSec !== undefined) next.aiCooldownSec = numeric(patch.aiCooldownSec, next.aiCooldownSec, 3, 180);
    if (patch.aiMaxChars !== undefined) next.aiMaxChars = numeric(patch.aiMaxChars, next.aiMaxChars, 60, 400);
    if (patch.aiTemperature !== undefined) next.aiTemperature = numeric(patch.aiTemperature, next.aiTemperature, 0, 1.5);
    if (patch.aiMinIdleSec !== undefined) next.aiMinIdleSec = numeric(patch.aiMinIdleSec, next.aiMinIdleSec, 5, 600);
    if (patch.aiMaxIdleSec !== undefined) next.aiMaxIdleSec = numeric(patch.aiMaxIdleSec, next.aiMaxIdleSec, 5, 600);
    if (patch.aiTimeoutSec !== undefined) next.aiTimeoutSec = numeric(patch.aiTimeoutSec, next.aiTimeoutSec, 5, 90);
    if (patch.aiMaxRetries !== undefined)
      next.aiMaxRetries = Math.round(numeric(patch.aiMaxRetries, next.aiMaxRetries, 1, 4));
    if (patch.aiMascotOneVolume !== undefined)
      next.aiMascotOneVolume = numeric(patch.aiMascotOneVolume, next.aiMascotOneVolume, 0, 1);
    if (patch.aiMascotTwoVolume !== undefined)
      next.aiMascotTwoVolume = numeric(patch.aiMascotTwoVolume, next.aiMascotTwoVolume, 0, 1);
    if (['low', 'normal', 'high'].includes(patch.speechFrequency)) next.speechFrequency = patch.speechFrequency;
    if (['low', 'normal', 'high'].includes(patch.aiFrequency)) next.aiFrequency = patch.aiFrequency;
    for (const key of [
      'autoPlayEnabled',
      'mascotEnabled',
      'voiceEnabled',
      'musicEnabled',
      'musicShuffle',
      'stopGameEnabled',
      'aiMascotEnabled',
      'aiChatResponses',
      'aiGameCommentary',
      'aiGiftReactions',
      'aiAlwaysActive',
      'aiAutonomous',
      'aiWatchdog',
      'aiTwoMascots',
      'aiMascotConversation',
      'aiViewerPriority',
      'aiMascotOneEnabled',
      'aiMascotTwoEnabled',
    ]) {
      if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
    }
    // Pre-rename key: the autonomous conversation toggle replaced it.
    delete next.aiRandomConversation;
    if (Array.isArray(patch.giftTiers)) next.giftTiers = patch.giftTiers;
    if (Array.isArray(patch.giftRules)) next.giftRules = patch.giftRules;

    const shapeChanged =
      next.boardSizeMode !== this.settings.boardSizeMode ||
      next.cols !== this.settings.cols ||
      next.rows !== this.settings.rows ||
      next.tileTypes !== this.settings.tileTypes ||
      next.difficulty !== this.settings.difficulty;

    this.settings = next;

    if (!this.settings.autoPlayEnabled) this.state.autoPlay = false;

    if (shapeChanged && this.board && this.state.status !== 'gameover') {
      this.buildLevel();
      this.emit('fx', { kind: 'newLevel', level: this.state.level, reason: 'settings', ts: this.now() });
    }

    this.bumpState();
    return this.settings;
  }
}
