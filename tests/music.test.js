import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MusicLibrary, isSafeAudioFile, sanitizePlaylist } from '../server/music/playlist.js';

const existsAll = () => true;

test('a well formed playlist keeps its tracks in order', () => {
  const playlist = sanitizePlaylist(
    {
      name: 'Stream set',
      shuffle: false,
      volume: 0.4,
      fadeMs: 900,
      tracks: [
        { file: 'track01.mp3', title: 'Warm Up', artist: 'A', license: 'CC0' },
        { file: 'track02.mp3' },
      ],
    },
    { exists: existsAll }
  );

  assert.equal(playlist.name, 'Stream set');
  assert.equal(playlist.shuffle, false);
  assert.equal(playlist.volume, 0.4);
  assert.equal(playlist.fadeMs, 900);
  assert.equal(playlist.tracks.length, 2);
  assert.equal(playlist.tracks[0].title, 'Warm Up');
  // A missing title falls back to a readable file name.
  assert.equal(playlist.tracks[1].title, 'track02');
  assert.equal(playlist.tracks[0].volume, 1);
  assert.equal(playlist.skipped.length, 0);
});

test('plain string entries are accepted as shorthand', () => {
  const playlist = sanitizePlaylist({ tracks: ['track05.mp3'] }, { exists: existsAll });
  assert.equal(playlist.tracks.length, 1);
  assert.equal(playlist.tracks[0].file, 'track05.mp3');
});

test('missing files are skipped and reported instead of played', () => {
  const playlist = sanitizePlaylist(
    { tracks: [{ file: 'track01.mp3' }, { file: 'gone.mp3' }] },
    { exists: (file) => file === 'track01.mp3' }
  );
  assert.deepEqual(playlist.tracks.map((track) => track.file), ['track01.mp3']);
  assert.deepEqual(playlist.skipped, [{ file: 'gone.mp3', reason: 'missing-file' }]);
});

test('path traversal and non-audio files are rejected', () => {
  const playlist = sanitizePlaylist(
    {
      tracks: [
        { file: '../secret.mp3' },
        { file: '..\\secret.mp3' },
        { file: 'sub/track.mp3' },
        { file: 'notes.txt' },
        { file: '.hidden.mp3' },
        { file: '' },
        { file: 'track01.mp3' },
      ],
    },
    { exists: existsAll }
  );
  assert.deepEqual(playlist.tracks.map((track) => track.file), ['track01.mp3']);
  assert.equal(playlist.skipped.length, 6);
  assert.ok(playlist.skipped.every((entry) => entry.reason === 'unsafe-filename'));

  assert.equal(isSafeAudioFile('track 01.mp3'), true);
  assert.equal(isSafeAudioFile('Track-02.MP3'), true);
  assert.equal(isSafeAudioFile('../x.mp3'), false);
  assert.equal(isSafeAudioFile('x.mp3.exe'), false);
  assert.equal(isSafeAudioFile('/abs/x.mp3'), false);
});

test('duplicate entries are only played once', () => {
  const playlist = sanitizePlaylist(
    { tracks: [{ file: 'track01.mp3' }, { file: 'TRACK01.mp3' }] },
    { exists: existsAll }
  );
  assert.equal(playlist.tracks.length, 1);
  assert.deepEqual(playlist.skipped, [{ file: 'TRACK01.mp3', reason: 'duplicate' }]);
});

test('volume, fade and shuffle are clamped to sane values', () => {
  const playlist = sanitizePlaylist(
    { volume: 42, fadeMs: 999999, shuffle: 'yes', tracks: [{ file: 'a.mp3', volume: -3 }] },
    { exists: existsAll }
  );
  assert.equal(playlist.volume, 1);
  assert.equal(playlist.fadeMs, 5000);
  assert.equal(playlist.shuffle, true); // non-boolean falls back to the default
  assert.equal(playlist.tracks[0].volume, 0);

  const quiet = sanitizePlaylist({ volume: -1, fadeMs: -50, tracks: [] }, { exists: existsAll });
  assert.equal(quiet.volume, 0);
  assert.equal(quiet.fadeMs, 0);
});

test('junk input yields a warning, never a throw', () => {
  for (const input of [null, 'nope', 42, []]) {
    const playlist = sanitizePlaylist(input, { exists: existsAll });
    assert.deepEqual(playlist.tracks, []);
    assert.ok(playlist.warnings.length >= 1);
  }

  const noTracks = sanitizePlaylist({ name: 'x' }, { exists: existsAll });
  assert.ok(noTracks.warnings.some((warning) => warning.includes('tracks')));
});

test('the track cap is enforced', () => {
  const tracks = Array.from({ length: 12 }, (_, index) => ({ file: `t${index}.mp3` }));
  const playlist = sanitizePlaylist({ tracks }, { exists: existsAll, maxTracks: 5 });
  assert.equal(playlist.tracks.length, 5);
  assert.ok(playlist.warnings.some((warning) => warning.includes('5')));
});

test('the library serves public urls and reloads changed playlists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-music-'));
  try {
    fs.writeFileSync(path.join(dir, 'track01.mp3'), '');
    fs.writeFileSync(
      path.join(dir, 'playlist.json'),
      JSON.stringify({ name: 'Set', volume: 0.25, tracks: [{ file: 'track01.mp3' }, { file: 'track02.mp3' }] })
    );

    const library = new MusicLibrary({ dir });
    const first = library.snapshot();
    assert.equal(first.present, true);
    assert.equal(first.tracks.length, 1);
    assert.equal(first.tracks[0].url, '/assets/music/track01.mp3');
    assert.deepEqual(first.skipped, [{ file: 'track02.mp3', reason: 'missing-file' }]);
    assert.equal(first.volume, 0.25);

    // Adding the file and reloading picks it up without a restart.
    fs.writeFileSync(path.join(dir, 'track02.mp3'), '');
    const second = library.reload();
    assert.equal(second.tracks.length, 2);
    assert.equal(second.skipped.length, 0);
    assert.equal(second.tracks[1].url, '/assets/music/track02.mp3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or invalid playlist.json is reported without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-music-'));
  try {
    const library = new MusicLibrary({ dir });
    const missing = library.snapshot();
    assert.equal(missing.present, false);
    assert.deepEqual(missing.tracks, []);
    assert.ok(missing.warnings.some((warning) => warning.includes('playlist.json')));

    fs.writeFileSync(path.join(dir, 'playlist.json'), '{ this is not json');
    const broken = library.reload();
    assert.deepEqual(broken.tracks, []);
    assert.ok(broken.warnings.some((warning) => warning.includes('could not be read')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
