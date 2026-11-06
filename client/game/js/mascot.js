/**
 * One flying mascot.
 *
 * The artwork, face set and flight rail are injected, so the overlay can host
 * two visually different characters (Zappy and Pip) with the same behaviour:
 * expression changes, an own speech bubble, one shared TTS voice (only one
 * mascot speaks at a time) and a patrol inside its own rail.
 *
 * No image assets: the character is inline SVG from mascotArt.js.
 */

import { CHARACTERS, resolveFace } from './mascotArt.js';
import { computeLanes, insideLane, mascotRect, nextWaypoint } from './flight.js';

export class Mascot {
  constructor({ layer, voice, character = 'zappy', lane = 'left', size = 144, boardRect = null, speed = 1, rng = Math.random }) {
    this.layer = layer;
    this.voice = voice;
    this.char = CHARACTERS[character] ? character : 'zappy';
    this.art = CHARACTERS[this.char];
    this.side = lane === 'right' ? 'right' : 'left';
    this.size = size;
    this.rng = rng;
    this.enabled = true;
    this.speed = speed;
    this.emotion = 'neutral';
    this.speaking = false;

    this.lanes = computeLanes({
      stageWidth: 1080,
      board: boardRect || { x: 160, y: 470, w: 760, h: 698 },
      size,
    });
    this.lane = this.lanes[this.side];

    this.el = document.createElement('div');
    this.el.className = `mascot mascot-${this.char} lane-${this.side}`;
    this.el.style.width = `${size}px`;
    this.el.style.height = `${size}px`;
    this.el.innerHTML = `<div class="mascot-aura"></div>${this.art.body}`;
    this.layer.appendChild(this.el);

    this.bubble = document.createElement('div');
    this.bubble.className = `bubble ${this.art.bubbleClass} bubble-${this.side}`;
    this.bubble.innerHTML = `<span class="bubble-name">${this.art.name}</span><span class="bubble-text"></span>`;
    this.layer.appendChild(this.bubble);
    this.bubbleText = this.bubble.querySelector('.bubble-text');

    // Reaction layer for TikTok interactions (hearts, stars, sparkles, wave).
    this.fxLayer = document.createElement('div');
    this.fxLayer.className = 'mascot-fx-layer';
    this.el.appendChild(this.fxLayer);
    this.fxTimer = null;

    this.eyes = this.el.querySelector('.face-eyes');
    this.mouth = this.el.querySelector('.face-mouth');
    this.extra = this.el.querySelector('.face-extra');
    this.core = this.el.querySelector(`.${this.art.bodyClass}`);

    this.x = this.lane.minX;
    this.y = this.lane.minY + (this.lane.maxY - this.lane.minY) * (this.side === 'left' ? 0.2 : 0.7);
    this.target = nextWaypoint(this.lane, this.rng, { x: this.x, y: this.y });
    this.pauseUntil = 0;
    this.lastFrame = 0;
    this.frameHandle = null;
    this.bubbleTimer = null;
    this.emotionTimer = null;

    this.applyEmotion('neutral');
    this.el.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
    this.animate = this.animate.bind(this);
    this.start();
  }

  // ---------------------------------------------------------------- settings

  setSettings(settings = {}, enabledKey = null) {
    const flag = enabledKey ? settings[enabledKey] !== false : true;
    this.enabled = settings.mascotEnabled !== false && flag;
    this.speed = Math.max(0.3, Number(settings.mascotSpeed) || 1);
    this.el.classList.toggle('mascot-disabled', !this.enabled);
    this.el.style.display = this.enabled ? '' : 'none';
    if (!this.enabled) this.hideBubble();
  }

  /** Re-measure the rail after a resize (the stage itself is scaled by CSS). */
  setRail(boardRect) {
    this.lanes = computeLanes({ stageWidth: 1080, board: boardRect, size: this.size });
    this.lane = this.lanes[this.side];
    if (!insideLane(this.lane, this.x, this.y, 12)) {
      this.x = this.lane.minX;
      this.y = this.lane.minY;
    }
    this.target = nextWaypoint(this.lane, this.rng, { x: this.x, y: this.y });
  }

  // -------------------------------------------------------------- expressions

  applyEmotion(emotion) {
    const { resolved, face } = resolveFace(this.char, emotion);
    this.emotion = emotion;
    this.el.classList.remove(
      'neutral', 'happy', 'excited', 'surprised', 'sad', 'sleepy', 'angry', 'laughing', 'celebrating', 'thinking', 'listening'
    );
    if (resolved !== 'neutral') this.el.classList.add(resolved);
    this.el.classList.toggle('is-speaking', resolved === 'happy' && this.speaking);
    if (this.eyes) this.eyes.innerHTML = face.eyes;
    if (this.mouth) this.mouth.innerHTML = face.mouth;
    if (this.extra) this.extra.innerHTML = face.extra || '';
  }

  setEmotion(emotion, { hold = 6000 } = {}) {
    this.applyEmotion(emotion);
    clearTimeout(this.emotionTimer);
    if (emotion !== 'neutral' && hold > 0) {
      this.emotionTimer = setTimeout(() => this.applyEmotion('neutral'), hold);
    }
  }

  /** The mascot that is not talking listens actively. */
  listen(emotion = 'listening') {
    if (!this.enabled) return;
    this.speaking = false;
    this.el.classList.remove('is-speaking');
    this.setEmotion(emotion, { hold: 0 });
  }

  /**
   * TikTok reaction: a short animation on this mascot only. Likes, follows and
   * shares are celebrated without spending an AI request, and the flight
   * transform keeps running because the effect is applied to the body only.
   */
  playFx(action = 'hearts', { hold = 1800 } = {}) {
    if (!this.enabled) return false;
    const map = {
      hearts: { emotion: 'happy', glyph: '♥' },
      celebrate: { emotion: 'excited', glyph: '★' },
      sparkles: { emotion: 'surprised', glyph: '✦' },
      welcome: { emotion: 'happy', glyph: '👋' },
    };
    const key = map[action] ? action : 'hearts';
    const fx = map[key];
    this.setEmotion(fx.emotion, { hold });
    this.el.classList.remove('fx-active', 'fx-hearts', 'fx-celebrate', 'fx-sparkles', 'fx-welcome');
    // Force a reflow so the same reaction replays even when it fires twice fast.
    void this.el.offsetWidth;
    this.el.classList.add('fx-active', `fx-${key}`);
    if (this.fxLayer) this.fxLayer.textContent = fx.glyph;
    clearTimeout(this.fxTimer);
    this.fxTimer = setTimeout(() => {
      this.el.classList.remove('fx-active', 'fx-hearts', 'fx-celebrate', 'fx-sparkles', 'fx-welcome');
    }, hold);
    return true;
  }

  // ----------------------------------------------------------------- speech

  /**
   * Show this mascot's line, animate the face and speak it. The server already
   * serialises speech (one line at a time); this only reports honestly whether
   * the browser actually played it.
   */
  react(line = {}) {
    if (!this.enabled || !line.text) return false;
    this.speaking = true;
    this.applyEmotion(line.emotion || 'happy');
    this.showBubble(line.text);
    if (!this.voice) return false;
    const spoke = this.voice.speak(line.text, {
      priority: line.priority || 1,
      force: Boolean(line.ai),
      speechId: line.speechId ?? null,
      volume: Number.isFinite(Number(line.volume)) ? Number(line.volume) : 1,
      pitch: this.art.pitch,
      rate: this.art.rate,
      speaker: this.char,
    });
    if (!spoke) {
      this.speaking = false;
      // Honest reporting: a line the voice layer never played must not leave the
      // server waiting for a completion that will never arrive.
      if (line.speechId != null) this.onSpeechSkipped?.(line);
    }
    return spoke;
  }

  onSpeechEnd() {
    this.speaking = false;
    this.el.classList.remove('is-speaking');
    this.applyEmotion('happy');
    clearTimeout(this.emotionTimer);
    this.emotionTimer = setTimeout(() => this.applyEmotion('neutral'), 1200);
  }

  showBubble(text) {
    if (!this.bubbleText) return;
    this.bubbleText.textContent = text;
    this.bubble.classList.add('show');
    clearTimeout(this.bubbleTimer);
    const duration = Math.min(9000, Math.max(3400, 1600 + String(text).length * 58));
    this.bubbleTimer = setTimeout(() => this.hideBubble(), duration);
  }

  hideBubble() {
    this.bubble?.classList.remove('show');
  }

  // ----------------------------------------------------------------- flight

  animate(ts) {
    if (!this.enabled) {
      this.frameHandle = requestAnimationFrame(this.animate);
      return;
    }
    if (!this.lastFrame) this.lastFrame = ts;
    const dt = Math.min(64, ts - this.lastFrame);
    this.lastFrame = ts;

    if (ts > this.pauseUntil) {
      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      if (Math.hypot(dx, dy) < 6) {
        if (!this.target.pauseMs) {
          this.target = nextWaypoint(this.lane, this.rng, this);
        } else if (!this.pauseUntil) {
          this.pauseUntil = ts + this.target.pauseMs;
          this.target = { ...this.target, pauseMs: 0 };
        }
      }
    }

    if (ts > this.pauseUntil) {
      const ease = Math.min(0.85, 0.0016 * this.speed * dt * 1.4);
      const nx = this.x + (this.target.x - this.x) * ease;
      const ny = this.y + (this.target.y - this.y) * ease;
      if (insideLane(this.lane, nx, ny, 2)) {
        this.x = nx;
        this.y = ny;
      } else {
        this.x = this.lane.minX;
        this.y = this.lane.minY;
      }
    }

    const bob = Math.sin(ts / (this.side === 'left' ? 520 : 610)) * 8;
    const tilt = Math.sin(ts / 1050) * (this.side === 'left' ? 4 : -4);
    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px, ${(this.y + bob).toFixed(1)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
    this.frameHandle = requestAnimationFrame(this.animate);
  }

  start() {
    if (this.frameHandle) return;
    this.frameHandle = requestAnimationFrame(this.animate);
  }

  stop() {
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  /** Debug/testing helper: the rectangle this mascot currently covers. */
  rect() {
    return mascotRect(this.lane, this.x, this.y);
  }
}
