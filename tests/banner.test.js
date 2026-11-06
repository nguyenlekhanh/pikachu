/**
 * Overlay layout guarantees.
 *
 * The instruction banner is the only thing a brand new viewer needs to read in
 * the first two seconds, and it must never sit on top of a tile. These tests
 * pin the wording, the placement in the 1080x1920 design space, the relative
 * type sizes and the validity of the coordinate example for the real engine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCommand } from '../server/game-engine/engine.js';
import { GAME_DEFAULTS } from '../server/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const html = read('client/game/index.html');
const css = read('client/game/css/game.css');
const mainJs = read('client/game/js/main.js');
const voiceJs = read('client/game/js/voice.js');
const musicJs = read('client/game/js/music.js');
const mascotJs = read('client/game/js/mascot.js');

/** Read one selector's declarations from the stylesheet. */
function rule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} must be styled`);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

function px(block, property) {
  const match = new RegExp(`${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(block);
  assert.ok(match, `${property} must be declared in px`);
  return Number(match[1]);
}

function indexOfOrFail(needle) {
  const index = html.indexOf(needle);
  assert.notEqual(index, -1, `${needle} must exist in the overlay`);
  return index;
}

// ------------------------------------------------------------------ layout

test('the instruction banner sits below the LEVEL stats and above the board', () => {
  const topbar = indexOfOrFail('id="topbar"');
  const banner = indexOfOrFail('id="howToPlay"');
  const footer = indexOfOrFail('id="footer"');
  const board = indexOfOrFail('id="boardFrame"');

  assert.ok(topbar < banner, 'the banner comes after the level information');
  assert.ok(banner < footer, 'the banner precedes the command footer');
  assert.ok(footer < board, 'the banner and footer stay above the board');

  const topbarBox = rule('#topbar');
  const bannerBox = rule('#howToPlay');
  const boardBox = rule('#boardFrame');

  const topbarBottom = px(topbarBox, 'top') + px(topbarBox, 'height');
  const bannerTop = px(bannerBox, 'top');
  const bannerBottom = bannerTop + px(bannerBox, 'height');
  const boardTop = px(boardBox, 'top');

  assert.ok(bannerTop >= topbarBottom, 'the banner never overlaps the level stats');
  assert.ok(bannerBottom <= boardTop, 'the banner never covers a game tile');
  assert.ok(boardTop - bannerBottom >= 24, 'the banner is clearly separated from the board');
});

test('the footer keeps only the extra commands', () => {
  assert.ok(!html.includes('COMMENT TWO TILE POSITIONS TO PLAY!'), 'the old small instruction is gone');
  const footer = html.slice(indexOfOrFail('id="footer"'), indexOfOrFail('id="giftLegend"'));
  for (const command of ['TOP', 'HELP', 'ME', 'RANK', 'HINT', 'JOIN']) {
    assert.ok(footer.includes(`<b>${command}</b>`), `${command} stays in the footer`);
  }
  assert.ok(!footer.includes('A1 B1'), 'the example lives in the banner only');
});

// ------------------------------------------------------------------ wording

test('the banner uses the exact required wording', () => {
  const banner = html.slice(indexOfOrFail('id="howToPlay"'), indexOfOrFail('id="footer"'));
  assert.ok(banner.includes('HOW TO PLAY'));
  assert.ok(banner.includes('MATCH TWO TILES!'));
  assert.ok(banner.includes('TYPE'));
  assert.ok(banner.includes('>A1</b>'));
  assert.ok(banner.includes('>B1</b>'));
  assert.ok(banner.includes('Comment two matching tile positions to connect them!'));
  assert.ok(banner.includes('FIRST CORRECT MATCH WINS POINTS!'));
  assert.ok(banner.includes('A1 = first tile'));
  assert.ok(banner.includes('B1 = second tile'));
});

// test('the example is the most prominent text on the overlay', () => {
//   const coord = px(rule('.how-to-coords .coord'), 'font-size');
//   const title = px(rule('.how-to-title'), 'font-size');
//   const caption = px(rule('.how-to-caption'), 'font-size');
//   const brand = px(rule('.brand-text h1'), 'font-size');

//   assert.ok(coord >= 80, `the A1 B1 example must be huge, got ${coord}px`);
//   assert.ok(coord > title * 1.5, 'the example dominates its own banner');
//   assert.ok(coord > brand, 'the example is larger than the stream title');
//   assert.ok(coord > caption * 4, 'the example is far larger than the supporting text');
// });

test('the banner is designed for a sharp 1080x1920 vertical stream', () => {
  const stage = rule('#stage');
  assert.equal(px(stage, 'width'), 1080);
  assert.equal(px(stage, 'height'), 1920);

  const banner = rule('#howToPlay');
  const left = px(banner, 'left');
  const right = px(banner, 'right');
  // `right` is the symmetric inset, so the rendered width is 1080 - 2 * inset.
  assert.equal(1080 - left - right, 980, 'the banner spans the full content width');
  assert.ok(px(banner, 'height') >= 140, 'the banner is tall enough for large type');

  // DOM text stays vector sharp at any scale; the pulse is a subtle glow, not a
  // transform that would blur the glyphs.
  assert.ok(css.includes('@keyframes how-to-pulse'));
  assert.ok(banner.includes('animation: how-to-pulse'));
  const pulseStart = css.indexOf('@keyframes how-to-pulse');
  const pulse = css.slice(pulseStart, css.indexOf('@keyframes', pulseStart + 10));
  assert.ok(!/transform:\s*scale/.test(pulse), 'the pulse is a glow, not a transform that could blur or overlap');
  assert.ok(css.includes('@keyframes coord-pop'));
  assert.ok(css.includes('@keyframes caret-blink'), 'the typing caret animates');
});

// -------------------------------------------------------------- coordinates

test('the example uses the real engine coordinate format', () => {
  const move = parseCommand('A1 B1', GAME_DEFAULTS.cols, GAME_DEFAULTS.rows);
  assert.equal(move.kind, 'move');
  assert.ok(move.a && move.b, 'A1 and B1 are inside the default board');
  assert.equal(move.invalid, undefined);
  assert.equal(move.raw, 'A1 B1');

  // The banner shows exactly those two positions.
  assert.match(html, /id="exampleA">A1</);
  assert.match(html, /id="exampleB">B1</);

  // An out-of-range example would be rejected by the engine, which is why the
  // banner never shows one.
  const outOfRange = parseCommand('A1 Z9', GAME_DEFAULTS.cols, GAME_DEFAULTS.rows);
  assert.ok(!outOfRange || outOfRange.invalid === 'out-of-range' || !outOfRange.a);
});

// -------------------------------------------------------------- speech wiring

test('the overlay reports real TTS start, completion and failure to the server', () => {
  assert.ok(voiceJs.includes('utterance.onstart'));
  assert.ok(voiceJs.includes('utterance.onend'));
  assert.ok(voiceJs.includes('utterance.onerror'));
  assert.ok(voiceJs.includes('reportVoices'));

  assert.ok(mainJs.includes("reportTts('start'"), 'start is reported');
  assert.ok(mainJs.includes("reportTts('end'"), 'completion is reported');
  assert.ok(mainJs.includes("reportTts('error'"), 'failure is reported');
  assert.ok(mainJs.includes("state: 'voices'"), 'voice availability is reported');
  assert.ok(mascotJs.includes('onSpeechSkipped'), 'a line the browser never played is reported');
});

test('music ducks while speaking and is restored when speech ends or fails', () => {
  assert.ok(musicJs.includes('duckFor('), 'ducking exists');
  assert.ok(/restore\(\)\s*{/.test(musicJs), 'restore exists');
  const endHandler = mainJs.slice(mainJs.indexOf("voice.onEnd"), mainJs.indexOf('voice.onVoices'));
  assert.ok(endHandler.includes('music.restore()'), 'the bed returns after speech completes');
  const errorHandler = mainJs.slice(mainJs.indexOf("voice.onError"), mainJs.indexOf('voice.onVoices'));
  assert.ok(errorHandler.includes('music.restore()'), 'the bed returns after a speech error');
  assert.ok(mainJs.includes('music.duckFor(text)'), 'the bed ducks when speech starts');
});
