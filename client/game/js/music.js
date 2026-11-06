/**
 * Background music for the overlay.
 *
 * Plays the validated playlist served by /api/music, one track after another,
 * with a short fade in/out and automatic ducking while the mascot is talking.
 *
 * Autoplay note: Chrome/Edge block audio until the page gets a user gesture, so
 * the first track may be held back. When that happens the player remembers it
 * and starts the music on the first click or key press. OBS browser sources
 * usually allow audio straight away; in a normal browser click the overlay once.
 *
 * The player is transport-only: it never talks to the game and it silently does
 * nothing when no tracks exist.
 */

import { nextTrack } from '/shared/musicQueue.js';

const DUCK_FACTOR = 0.35;
const FADE_STEP_MS = 60;

const clamp01 = (value, fallback = 0.35) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
};

export class Music {
  constructor() {
    this.tracks = [];
    this.skipped = [];
    this.warnings = [];
    this.name = '';
    this.playlistVolume = 0.35;
    this.settingVolume = null;
    this.enabled = true;
    this.shuffle = true;
    this.fadeMs = 1200;
    this.audio = null;
    this.index = -1;
    this.failed = new Set();
    this.blocked = false;
    this.duckTimer = null;
    this.fadeTimer = null;
    this.unlockArmed = false;
    this.destroyed = false;
    this.onStatus = null;
    this.current = null;
    this.ducked = false;
    // Highest server "next track" command applied, so reordered/delayed frames
    // can never restart a track the overlay already moved past.
    this.commandSeq = 0;
  }

  // ------------------------------------------------------------------ loading

  async load() {
    try {
      const response = await fetch('/api/music', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      this.setPlaylist(data);
      if (!this.enabled) return;

      // A page that just opened (an OBS source reconnecting) joins the track the
      // stream is already on instead of starting a different one.
      const shared = data.transport && data.transport.current;
      if (shared && typeof shared.file === 'string' && this.tracks.some((track) => track.file === shared.file)) {
        this.playFromCommand({ track: shared }, { applySeq: false });
      } else {
        this.play();
      }
    } catch (error) {
      console.warn('[music] playlist unavailable:', error.message);
    }
  }

  setPlaylist(data = {}) {
    this.tracks = Array.isArray(data.tracks) ? data.tracks : [];
    this.skipped = Array.isArray(data.skipped) ? data.skipped : [];
    this.warnings = Array.isArray(data.warnings) ? data.warnings : [];
    this.name = typeof data.name === 'string' ? data.name : '';
    if (typeof data.shuffle === 'boolean') this.shuffle = data.shuffle;
    if (data.volume !== undefined) this.playlistVolume = clamp01(data.volume, 0.35);
    if (data.fadeMs !== undefined) {
      const fade = Number(data.fadeMs);
      if (Number.isFinite(fade)) this.fadeMs = Math.min(5000, Math.max(0, fade));
    }

    // A reloaded playlist may no longer contain the track that is playing.
    if (this.current && !this.tracks.some((track) => track.file === this.current.file)) {
      this.stop();
    }
    this.failed.clear();
    if (this.audio) this.audio.volume = this.targetVolume();

    this.onStatus?.({
      tracks: this.tracks.length,
      current: this.current?.title || null,
      blocked: this.blocked,
    });
  }

  // ---------------------------------------------------------------- settings

  setSettings(settings = {}) {
    const wasEnabled = this.enabled;

    if (settings.musicEnabled !== undefined) this.enabled = Boolean(settings.musicEnabled);
    if (settings.musicVolume !== undefined) this.settingVolume = clamp01(settings.musicVolume, 0.35);
    if (settings.musicShuffle !== undefined) this.shuffle = Boolean(settings.musicShuffle);

    if (!this.audio) {
      if (this.enabled && !wasEnabled) this.play();
      return;
    }

    if (!this.enabled) {
      this.pause();
      return;
    }

    this.audio.volume = this.targetVolume();
    if (!wasEnabled) this.play();
  }

  baseVolume() {
    return clamp01(this.settingVolume ?? this.playlistVolume, 0.35);
  }

  targetVolume() {
    const trackVolume = this.current ? clamp01(this.current.volume, 1) : 1;
    return clamp01(this.baseVolume() * trackVolume, this.baseVolume());
  }

  // ---------------------------------------------------------------- playback

  createAudio() {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('ended', () => this.advance());
    audio.addEventListener('error', () => {
      const track = this.current;
      if (track) this.handleTrackError(track, new Error('media error'));
    });
    this.audio = audio;
  }

  pickTrack() {
    return nextTrack({
      tracks: this.tracks,
      currentFile: this.current ? this.current.file : null,
      shuffle: this.shuffle,
      failed: [...this.failed],
    });
  }

  play() {
    if (this.destroyed || !this.enabled) return;
    if (!this.tracks.length) return;
    if (!this.audio) this.createAudio();
    if (!this.audio.paused) return;

    const track = this.pickTrack();
    if (!track) return;

    this.current = track;
    this.index = this.tracks.indexOf(track);
    this.audio.src = track.url;
    this.audio.volume = 0;

    const started = this.audio.play();
    const begin = () => {
      this.blocked = false;
      // A track that starts while the mascot is talking stays ducked.
      this.fadeTo(this.targetVolume() * (this.ducked ? DUCK_FACTOR : 1), this.fadeMs);
      this.onStatus?.({ tracks: this.tracks.length, current: track.title, blocked: false });
    };

    if (started && typeof started.then === 'function') {
      started.then(begin).catch((error) => {
        if (error && error.name === 'NotAllowedError') {
          this.blocked = true;
          this.armUnlock();
          this.onStatus?.({ tracks: this.tracks.length, current: track.title, blocked: true });
          return;
        }
        this.handleTrackError(track, error);
      });
    } else {
      begin();
    }
  }

  /** Move to the next track without a pause. */
  advance() {
    if (this.destroyed || !this.enabled) return;
    if (!this.tracks.length) return;
    if (this.audio) this.audio.pause();
    this.play();
  }

  /**
   * Follow an Admin → Music "next track" command.
   *
   * The current track is cut immediately (one Audio element, so two tracks can
   * never overlap), the volume/duck state is preserved, and older commands are
   * ignored by sequence number.
   */
  playFromCommand(payload = {}, { applySeq = true } = {}) {
    const track = payload.track;
    if (!track || typeof track.file !== 'string' || !track.file) return false;

    const seq = Number(payload.seq);
    if (applySeq && Number.isFinite(seq)) {
      if (seq <= this.commandSeq) return false;
      this.commandSeq = seq;
    }
    if (this.destroyed) return false;

    // Never restart the track that is already playing.
    const playingNow = this.audio && !this.audio.paused && !this.audio.ended;
    if (playingNow && this.current && this.current.file === track.file) return false;

    this.current = {
      file: track.file,
      title: typeof track.title === 'string' ? track.title : '',
      artist: typeof track.artist === 'string' ? track.artist : '',
      url: track.url || `/assets/music/${encodeURIComponent(track.file)}`,
      volume: Number.isFinite(Number(track.volume)) ? Number(track.volume) : 1,
    };
    this.index = this.tracks.findIndex((entry) => entry.file === track.file);

    const status = () =>
      this.onStatus?.({ tracks: this.tracks.length, current: this.current.title || this.current.file, blocked: this.blocked });

    if (!this.enabled) {
      status();
      return true;
    }

    if (!this.audio) this.createAudio();
    const audio = this.audio;
    clearInterval(this.fadeTimer);
    audio.pause();
    audio.src = this.current.url;
    audio.volume = this.ducked ? this.targetVolume() * DUCK_FACTOR : 0;

    const started = audio.play();
    const begin = () => {
      this.blocked = false;
      this.fadeTo(this.targetVolume() * (this.ducked ? DUCK_FACTOR : 1), Math.min(500, this.fadeMs || 400));
      status();
    };

    if (started && typeof started.then === 'function') {
      started.then(begin).catch((error) => {
        if (error && error.name === 'NotAllowedError') {
          this.blocked = true;
          this.armUnlock();
          status();
          return;
        }
        this.handleTrackError(this.current, error);
      });
    } else {
      begin();
    }
    return true;
  }

  handleTrackError(track, error) {
    this.failed.add(track.file);
    console.warn(`[music] skipping ${track.file}: ${error?.message || 'playback failed'}`);
    const remaining = this.tracks.filter((entry) => !this.failed.has(entry.file));
    if (!remaining.length) {
      console.warn('[music] no playable tracks left.');
      this.current = null;
      this.stop();
      return;
    }
    this.current = null;
    if (this.audio) this.audio.pause();
    this.play();
  }

  pause() {
    if (!this.audio || this.audio.paused) return;
    const audio = this.audio;
    this.fadeTo(0, Math.min(600, this.fadeMs || 0));
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      if (this.enabled) return; // settings flipped back on meanwhile
      audio.pause();
    }, Math.min(700, (this.fadeMs || 0) + 80));
  }

  stop() {
    clearTimeout(this.pauseTimer);
    clearTimeout(this.duckTimer);
    clearInterval(this.fadeTimer);
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load?.();
    }
    this.current = null;
    this.ducked = false;
  }

  /** Lower the music while the mascot talks, then bring it back. */
  duckFor(text = '') {
    if (!this.audio || !this.enabled) return;
    const base = this.targetVolume();
    this.ducked = true;
    this.fadeTo(base * DUCK_FACTOR, 220);
    const duration = Math.min(9000, Math.max(1400, 1200 + String(text).length * 60));
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => {
      if (!this.enabled) return;
      this.ducked = false;
      this.fadeTo(this.targetVolume(), 700);
    }, duration);
  }

  /** Bring the bed back as soon as real speech finishes (or fails). */
  restore() {
    clearTimeout(this.duckTimer);
    if (!this.ducked) return;
    this.ducked = false;
    if (!this.enabled) return;
    this.fadeTo(this.targetVolume(), 700);
  }

  fadeTo(target, ms = this.fadeMs) {
    if (!this.audio) return;
    clearInterval(this.fadeTimer);
    const audio = this.audio;
    const goal = Math.min(1, Math.max(0, target));

    if (!ms || ms <= 0) {
      audio.volume = goal;
      return;
    }

    const start = audio.volume;
    const steps = Math.max(1, Math.round(ms / FADE_STEP_MS));
    let step = 0;
    this.fadeTimer = setInterval(() => {
      step += 1;
      const progress = Math.min(1, step / steps);
      audio.volume = Math.min(1, Math.max(0, start + (goal - start) * progress));
      if (progress >= 1) clearInterval(this.fadeTimer);
    }, FADE_STEP_MS);
  }

  // ------------------------------------------------------------------ unlock

  armUnlock() {
    if (this.unlockArmed || this.destroyed) return;
    this.unlockArmed = true;

    const unlock = () => {
      this.blocked = false;
      this.unlockArmed = false;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
      this.play();
    };

    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
  }

  destroy() {
    this.destroyed = true;
    this.stop();
  }
}
