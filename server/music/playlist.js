/**
 * Background music playlist.
 *
 * The streamer owns the music: tracks live in `assets/music/` next to a
 * `playlist.json`. This module only reads that file and validates it, so a
 * broken or hand-edited playlist can never crash the game or serve a file from
 * outside the music folder.
 *
 * Everything here is synchronous on purpose: the playlist is small, it is read
 * once at boot and only re-read when the file changes or the admin asks for a
 * reload.
 */

import fs from 'node:fs';
import path from 'node:path';

export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'ogg', 'oga', 'wav', 'flac', 'opus', 'webm'];
export const MAX_TRACKS = 100;

const SAFE_FILE = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9 ._'()\\[\\]-]{0,140}\\.(${AUDIO_EXTENSIONS.join('|')})$`,
  'i'
);

const clamp = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const cleanText = (value, max = 120) => {
  if (value === undefined || value === null) return '';
  // Strip control characters: this text ends up in the admin table and logs.
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
};

const titleFromFile = (file) =>
  file
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A track filename must be a plain basename with an audio extension. */
export function isSafeAudioFile(file) {
  if (typeof file !== 'string') return false;
  const name = file.trim();
  if (!name || name.length > 160) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return SAFE_FILE.test(name);
}

export const EMPTY_PLAYLIST = {
  name: '',
  shuffle: true,
  volume: 0.35,
  fadeMs: 1200,
  tracks: [],
  skipped: [],
  warnings: [],
};

/**
 * Validate a parsed playlist.json.
 *
 * @param {unknown} raw parsed JSON
 * @param {{ exists?: (file: string) => boolean, maxTracks?: number }} options
 *   `exists` lets tests run without touching the filesystem; the library passes
 *   a real fs check so missing files are reported instead of 404-ing mid-stream.
 */
export function sanitizePlaylist(raw, { exists = () => true, maxTracks = MAX_TRACKS } = {}) {
  const warnings = [];
  const skipped = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ...EMPTY_PLAYLIST,
      warnings: ['playlist.json must contain a JSON object with a "tracks" array.'],
    };
  }

  const list = Array.isArray(raw.tracks) ? raw.tracks : [];
  if (!Array.isArray(raw.tracks)) warnings.push('"tracks" must be an array.');
  if (list.length > maxTracks) warnings.push(`Only the first ${maxTracks} tracks are used.`);

  const seen = new Set();
  const tracks = [];

  for (const entry of list) {
    if (tracks.length >= maxTracks) break;

    const item = typeof entry === 'string' ? { file: entry } : entry;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped.push({ file: String(entry).slice(0, 160), reason: 'invalid-entry' });
      continue;
    }

    const file = cleanText(item.file, 160);
    if (!isSafeAudioFile(file)) {
      skipped.push({ file: file || '(empty)', reason: 'unsafe-filename' });
      continue;
    }

    const key = file.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ file, reason: 'duplicate' });
      continue;
    }
    seen.add(key);

    if (!exists(file)) {
      skipped.push({ file, reason: 'missing-file' });
      continue;
    }

    tracks.push({
      file,
      title: cleanText(item.title) || titleFromFile(file),
      artist: cleanText(item.artist),
      license: cleanText(item.license),
      volume: clamp(item.volume, 0, 1, 1),
    });
  }

  return {
    name: cleanText(raw.name) || 'Stream music',
    shuffle: typeof raw.shuffle === 'boolean' ? raw.shuffle : true,
    volume: clamp(raw.volume, 0, 1, 0.35),
    fadeMs: clamp(raw.fadeMs, 0, 5000, 1200),
    tracks,
    skipped,
    warnings,
  };
}

/**
 * Reads `playlist.json` from the music folder and caches the result until the
 * file changes on disk (mtime + size), so the overlay can ask for the playlist
 * on every reload without re-reading it each time.
 */
export class MusicLibrary {
  constructor({ dir, logger = null, now = () => Date.now() }) {
    this.dir = dir;
    this.logger = logger;
    this.now = now;
    this.playlistFile = path.join(dir, 'playlist.json');
    this.cache = null;
    this.cacheKey = null;
  }

  reload() {
    this.cache = null;
    this.cacheKey = null;
    return this.snapshot();
  }

  snapshot() {
    let stat;
    try {
      stat = fs.statSync(this.playlistFile);
    } catch {
      this.cache = {
        ...EMPTY_PLAYLIST,
        dir: this.dir,
        playlistFile: this.playlistFile,
        present: false,
        updatedAt: null,
        warnings: [
          'No playlist.json found. Add one to assets/music/ and drop your tracks in the same folder.',
        ],
      };
      this.cacheKey = null;
      return this.cache;
    }

    const key = `${stat.mtimeMs}:${stat.size}`;
    if (this.cache && this.cacheKey === key) return this.cache;

    let sanitized;
    try {
      const raw = JSON.parse(fs.readFileSync(this.playlistFile, 'utf8'));
      sanitized = sanitizePlaylist(raw, {
        exists: (file) => fs.existsSync(path.join(this.dir, file)),
      });
    } catch (error) {
      sanitized = {
        ...EMPTY_PLAYLIST,
        name: 'Stream music',
        warnings: [`playlist.json could not be read: ${error.message}`],
      };
    }

    this.cache = {
      ...sanitized,
      dir: this.dir,
      playlistFile: this.playlistFile,
      present: true,
      updatedAt: stat.mtimeMs,
      tracks: sanitized.tracks.map((track) => ({
        ...track,
        url: `/assets/music/${encodeURIComponent(track.file)}`,
      })),
    };
    this.cacheKey = key;

    if (sanitized.warnings.length || sanitized.skipped.length) {
      this.logger?.warn?.(
        `Music playlist: ${sanitized.tracks.length} playable track(s), ${sanitized.skipped.length} skipped.`
      );
      for (const warning of sanitized.warnings) this.logger?.warn?.(`  ${warning}`);
      for (const entry of sanitized.skipped) this.logger?.warn?.(`  skipped ${entry.file} (${entry.reason})`);
    }

    return this.cache;
  }
}
