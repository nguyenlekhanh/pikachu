import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextTrack } from '../shared/musicQueue.js';

const tracks = [
  { file: 'a.mp3', title: 'A' },
  { file: 'b.mp3', title: 'B' },
  { file: 'c.mp3', title: 'C' },
];

test('sequential playback starts at the first track', () => {
  assert.equal(nextTrack({ tracks, shuffle: false }).file, 'a.mp3');
});

test('sequential playback advances in order and loops back to the first track', () => {
  assert.equal(nextTrack({ tracks, currentFile: 'a.mp3', shuffle: false }).file, 'b.mp3');
  assert.equal(nextTrack({ tracks, currentFile: 'b.mp3', shuffle: false }).file, 'c.mp3');
  // LOOP ALL: after the last track the first one plays again.
  assert.equal(nextTrack({ tracks, currentFile: 'c.mp3', shuffle: false }).file, 'a.mp3');
});

test('a failed track is skipped but the queue still loops', () => {
  assert.equal(nextTrack({ tracks, currentFile: 'a.mp3', shuffle: false, failed: ['b.mp3'] }).file, 'c.mp3');
  assert.equal(nextTrack({ tracks, currentFile: 'c.mp3', shuffle: false, failed: ['a.mp3'] }).file, 'b.mp3');
  assert.equal(nextTrack({ tracks, currentFile: 'c.mp3', shuffle: false, failed: ['a.mp3', 'b.mp3', 'c.mp3'] }), null);
});

test('shuffle never repeats the current track while alternatives exist', () => {
  for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
    const pick = nextTrack({ tracks, currentFile: 'b.mp3', shuffle: true, random: () => random });
    assert.notEqual(pick.file, 'b.mp3');
  }
  assert.equal(nextTrack({ tracks, currentFile: 'b.mp3', shuffle: true, random: () => 0 }).file, 'a.mp3');
  assert.equal(nextTrack({ tracks, currentFile: 'b.mp3', shuffle: true, random: () => 0.999 }).file, 'c.mp3');
});

test('shuffle falls back to the current track when it is the only one left', () => {
  assert.equal(nextTrack({ tracks, currentFile: 'a.mp3', shuffle: true, failed: ['b.mp3', 'c.mp3'] }).file, 'a.mp3');
});

test('an empty playlist yields nothing instead of throwing', () => {
  assert.equal(nextTrack({ tracks: [], shuffle: false }), null);
  assert.equal(nextTrack({}), null);
});
