/**
 * Streamer-side music transport.
 *
 * The overlay player is still autonomous (it picks a track, plays it and moves
 * on when it ends). This module adds the one thing only the server can do:
 * a *shared* command that every open overlay follows. Admin → Music "NEXT
 * MUSIC" asks this module for the next track and it broadcasts a single
 * `music` frame, so two OBS sources switch together instead of drifting.
 *
 * Playlist order comes from the same pure helper the overlay uses
 * (shared/musicQueue.js), so the button and the automatic advance always agree:
 *   - sequential / LOOP ALL : next in file order, wrapping after the last track
 *   - shuffle               : another random track, never the one playing now
 *
 * Nothing here touches volume, ducking or the game: it only chooses a track and
 * announces it.
 */

import { nextTrack } from '../../shared/musicQueue.js';

export const SKIP_THROTTLE_MS = 350;

/** Playlist mode label for a shuffle flag. */
export function playlistMode(shuffle) {
  return shuffle ? 'shuffle' : 'loop-all';
}

const cleanTrack = (track) => {
  if (!track || typeof track !== 'object' || typeof track.file !== 'string' || !track.file) return null;
  return {
    file: track.file,
    title: typeof track.title === 'string' ? track.title : '',
    artist: typeof track.artist === 'string' ? track.artist : '',
    url: typeof track.url === 'string' ? track.url : `/assets/music/${encodeURIComponent(track.file)}`,
    volume: Number.isFinite(Number(track.volume)) ? Number(track.volume) : 1,
  };
};

export class MusicTransport {
  constructor({
    library,
    broadcast,
    logger = null,
    store = null,
    getShuffle = () => false,
    now = () => Date.now(),
    throttleMs = SKIP_THROTTLE_MS,
  } = {}) {
    this.library = library;
    this.broadcast = typeof broadcast === 'function' ? broadcast : () => {};
    this.logger = logger;
    this.store = store;
    this.getShuffle = getShuffle;
    this.now = now;
    this.throttleMs = throttleMs;
    this.current = null;
    this.startedAt = null;
    this.seq = 0;
    this.lastCommandAt = 0;
  }

  tracks() {
    return this.library?.snapshot?.()?.tracks || [];
  }

  status() {
    const tracks = this.tracks();
    return {
      current: this.current ? { ...this.current } : null,
      mode: playlistMode(Boolean(this.getShuffle())),
      shuffle: Boolean(this.getShuffle()),
      seq: this.seq,
      startedAt: this.startedAt,
      tracks: tracks.length,
    };
  }

  /**
   * An overlay reports the track it is actually playing (its own automatic
   * advance, or a command it just followed). Keeping this fresh means NEXT
   * skips forward from what the streamer hears, not from a stale guess.
   */
  noteCurrent(track) {
    const clean = cleanTrack(track);
    if (!clean) return false;
    this.current = clean;
    if (!this.startedAt) this.startedAt = this.now();
    return true;
  }

  /**
   * Stop the current track everywhere and start the next one.
   *
   * @returns {{ok: boolean, message?: string} & Record<string, unknown>}
   */
  next({ reason = 'admin' } = {}) {
    const now = this.now();
    if (now - this.lastCommandAt < this.throttleMs) {
      return {
        ok: false,
        throttled: true,
        message: 'Hold on a moment — the previous skip is still applying.',
        ...this.status(),
      };
    }

    const tracks = this.tracks();
    const shuffle = Boolean(this.getShuffle());
    const mode = playlistMode(shuffle);

    if (!tracks.length) {
      return {
        ok: false,
        empty: true,
        message: 'No playable tracks. Add audio files to assets/music/ and list them in playlist.json, then reload the playlist.',
        ...this.status(),
      };
    }

    if (tracks.length === 1) {
      return {
        ok: false,
        single: true,
        message: `Only one playable track (${tracks[0].title || tracks[0].file}) — there is nothing else to skip to.`,
        ...this.status(),
      };
    }

    const track = nextTrack({
      tracks,
      currentFile: this.current ? this.current.file : null,
      shuffle,
    });

    if (!track) {
      return {
        ok: false,
        empty: true,
        message: 'No playable tracks left to skip to.',
        ...this.status(),
      };
    }

    this.lastCommandAt = now;
    this.seq += 1;
    this.current = {
      file: track.file,
      title: track.title || '',
      artist: track.artist || '',
      url: track.url || `/assets/music/${encodeURIComponent(track.file)}`,
      volume: Number.isFinite(Number(track.volume)) ? Number(track.volume) : 1,
    };
    this.startedAt = now;

    const payload = {
      action: 'play',
      command: 'next',
      reason,
      track: this.current,
      index: tracks.findIndex((entry) => entry && entry.file === track.file),
      mode,
      shuffle,
      seq: this.seq,
      startedAt: now,
      total: tracks.length,
    };

    // One frame for every client: the overlays stop whatever they are playing
    // and start this track, the admin panel reads it from the same message.
    this.broadcast('music', payload);

    const label = track.title || track.file;
    this.logger?.info?.(`Music: next track "${label}" (${mode}, #${this.seq}).`);
    try {
      this.store?.log?.({
        category: 'system',
        message: `Music: next track "${label}" (${mode}).`,
      });
    } catch {
      /* logging must never break playback */
    }

    return { ok: true, message: `Now playing ${label}.`, ...payload };
  }
}
