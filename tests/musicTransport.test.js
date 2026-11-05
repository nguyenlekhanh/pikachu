import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MusicTransport, playlistMode } from '../server/music/transport.js';

const tracks = [
  { file: 'a.mp3', title: 'A', url: '/assets/music/a.mp3' },
  { file: 'b.mp3', title: 'B', url: '/assets/music/b.mp3' },
  { file: 'c.mp3', title: 'C', url: '/assets/music/c.mp3' },
  { file: 'd.mp3', title: 'D', url: '/assets/music/d.mp3' },
];

function build({ list = tracks, shuffle = false, startAt = 1000, throttleMs = 350 } = {}) {
  const frames = [];
  let clock = startAt;
  const transport = new MusicTransport({
    library: { snapshot: () => ({ tracks: list }) },
    broadcast: (type, payload) => frames.push({ type, payload }),
    getShuffle: () => shuffle,
    now: () => clock,
    throttleMs,
    logger: { info() {} },
  });
  return { transport, frames, advance: (ms = 1000) => (clock += ms) };
}

test('sequential mode plays the next track in file order', () => {
  const { transport, frames } = build();
  transport.noteCurrent(tracks[0]);
  const result = transport.next();

  assert.equal(result.ok, true);
  assert.equal(result.track.file, 'b.mp3');
  assert.equal(result.mode, 'loop-all');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'music');
  assert.equal(frames[0].payload.action, 'play');
  assert.equal(frames[0].payload.command, 'next');
  assert.equal(frames[0].payload.seq, 1);
  assert.equal(transport.status().current.file, 'b.mp3');
});

test('LOOP ALL wraps from the last track back to the first', () => {
  const { transport } = build();
  transport.noteCurrent(tracks[tracks.length - 1]);
  const result = transport.next();
  assert.equal(result.ok, true);
  assert.equal(result.track.file, 'a.mp3');
});

test('shuffle mode never picks the track that is playing', () => {
  const { transport, advance } = build({ shuffle: true });
  let currentFile = 'b.mp3';
  transport.noteCurrent(tracks[1]);

  for (let i = 0; i < 12; i += 1) {
    advance();
    const result = transport.next();
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'shuffle');
    assert.notEqual(result.track.file, currentFile);
    currentFile = result.track.file;
  }
});

test('an empty playlist explains itself and broadcasts nothing', () => {
  const { transport, frames } = build({ list: [] });
  const result = transport.next();
  assert.equal(result.ok, false);
  assert.equal(result.empty, true);
  assert.match(result.message, /No playable tracks/i);
  assert.equal(frames.length, 0);
});

test('a single-track playlist refuses to restart the only track', () => {
  const { transport, frames } = build({ list: [tracks[0]] });
  transport.noteCurrent(tracks[0]);
  const result = transport.next();
  assert.equal(result.ok, false);
  assert.equal(result.single, true);
  assert.match(result.message, /Only one playable track/i);
  assert.equal(frames.length, 0);
});

test('rapid clicks are throttled to one track change', () => {
  const { transport, frames, advance } = build();
  transport.noteCurrent(tracks[0]);

  const first = transport.next();
  const second = transport.next();
  advance(120);
  const third = transport.next();

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.throttled, true);
  assert.equal(third.ok, false);
  assert.equal(frames.length, 1);

  advance(400);
  assert.equal(transport.next().ok, true);
  assert.equal(frames.length, 2);
});

test('sequence numbers increase so overlays can drop stale commands', () => {
  const { transport, frames, advance } = build();
  transport.noteCurrent(tracks[0]);
  transport.next();
  advance();
  transport.next();
  assert.deepEqual(
    frames.map((frame) => frame.payload.seq),
    [1, 2]
  );
  assert.notEqual(frames[0].payload.track.file, frames[1].payload.track.file);
});

test('playlist mode label reflects the shuffle setting', () => {
  assert.equal(playlistMode(false), 'loop-all');
  assert.equal(playlistMode(true), 'shuffle');
  assert.equal(build({ shuffle: false }).transport.status().mode, 'loop-all');
  assert.equal(build({ shuffle: true }).transport.status().mode, 'shuffle');
});

test('an overlay report updates the current track shown in admin', () => {
  const { transport } = build();
  assert.equal(transport.noteCurrent({ file: '', title: 'broken' }), false);
  assert.equal(transport.noteCurrent(tracks[2]), true);
  assert.deepEqual(transport.status().current, {
    file: 'c.mp3',
    title: 'C',
    artist: '',
    url: '/assets/music/c.mp3',
    volume: 1,
  });
  // NEXT now moves on from the reported track, not from a stale one.
  assert.equal(transport.next().track.file, 'd.mp3');
});
