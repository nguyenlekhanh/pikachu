/**
 * Overlay bootstrap: wires the server feed to the Phaser board, the DOM UI and
 * the mascot. The overlay is a pure view - it never validates a move or awards
 * a point by itself.
 */

import { BoardScene } from './boardScene.js';
import { UI } from './ui.js';
import { Mascot } from './mascot.js';
import { Voice } from './voice.js';
import { Music } from './music.js';
import { Net } from './net.js';

const ui = new UI();
const voice = new Voice();
const music = new Music();
const mascot = new Mascot({ layer: document.getElementById('mascotLayer'), voice });
const boardScene = new BoardScene();

let net = null;
let settings = {};
let phaserGame = null;
let musicLoaded = false;
let reportedTrackFile = '';

// Read-only debug handle: in the browser console, `__music.blocked` explains a
// silent overlay (autoplay policy) and `__music.tracks.length` shows the playlist.
window.__music = music;
// Same for the board: `__board.layout` exposes the coordinate header geometry.
window.__board = boardScene;

// Zappy talks over the music: duck the bed while a line is being spoken.
const speak = voice.speak.bind(voice);
voice.speak = (text, options) => {
  const spoke = speak(text, options);
  if (spoke) music.duckFor(text);
  return spoke;
};

// ------------------------------------------------------------------ stage fit

function fitStage() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const scale = Math.min(width / 1080, height / 1920);
  const stage = document.getElementById('stage');
  stage.style.transform = `translate(${(width - 1080 * scale) / 2}px, ${(height - 1920 * scale) / 2}px) scale(${scale})`;
}

window.addEventListener('resize', fitStage);
fitStage();

// -------------------------------------------------------------- background mode

const params = new URLSearchParams(window.location.search);
// ?music=off silences the music bed for one page (handy for a second OBS source).
const musicMuted = params.get('music') === 'off';
if (params.get('bg') === 'transparent') document.body.classList.add('bg-transparent');
if (params.get('bg') === 'chroma') document.body.classList.add('bg-chroma');
if (params.get('clean') === '1') document.body.classList.add('clean-mode');

// ------------------------------------------------------------------- phaser

if (window.Phaser) {
  boardScene.onSubmit = (a, b) => {
    if (net) net.send('click', { a, b });
  };

  phaserGame = new window.Phaser.Game({
    type: window.Phaser.AUTO,
    parent: 'boardBox',
    width: 940,
    height: 860,
    transparent: true,
    scale: { mode: window.Phaser.Scale.NONE, width: 940, height: 860 },
    render: { antialias: true, roundPixels: false, powerPreference: 'high-performance' },
    audio: { noAudio: true },
    banner: false,
    scene: [boardScene],
  });
} else {
  console.error('[overlay] Phaser failed to load from /vendor/phaser.min.js');
  ui.toast('Game engine failed to load. Check the server console.', 'warn');
}

// ------------------------------------------------------------------- helpers

// Tell the server which track this overlay actually started, so Admin → Music
// shows the real current track and NEXT skips forward from it.
function reportTrack(force = false) {
  const file = music.current?.file;
  if (!file || !net) return;
  if (!force && file === reportedTrackFile) return;
  reportedTrackFile = file;
  net.send('music-current', { file, title: music.current?.title || '' });
}

music.onStatus = () => reportTrack(false);

function applyMusicSettings(source = {}) {
  const values = source.music || source;
  music.setSettings({
    musicEnabled: musicMuted ? false : values.musicEnabled ?? values.enabled,
    musicVolume: values.musicVolume ?? values.volume,
    musicShuffle: values.musicShuffle ?? values.shuffle,
  });
}

function applyBootstrap(data) {
  if (!data) return;
  settings = data.settings || {};
  ui.setSettings(settings);
  mascot.setSettings(settings);
  voice.setSettings(settings);
  applyMusicSettings(settings);
  ui.setGiftLegend(data.giftLegend);
  ui.setConnection(data.tiktok);
  ui.setLeaderboardCache(data.leaderboard);
  ui.setLeaderboard(data.leaderboard);
  boardScene.setSpeed(settings.moveSpeed || 1);
  ui.setState(data.game);
  if (data.game) boardScene.applyState(data.game);

  if (!musicLoaded) {
    musicLoaded = true;
    music.load();
  }
}

function onFx(fx) {
  if (!fx) return;
  if (fx.kind === 'match') {
    if (!fx.auto) {
      ui.showLastMove(`${fx.username}: ${fx.a.label} + ${fx.b.label}  +${fx.points}`);
      ui.bumpStat('matches');
    }
  }
  if (fx.kind === 'newLevel') {
    ui.levelBanner(`LEVEL ${fx.level}`);
    mascot.setEmotion('celebrating');
  }
  if (fx.kind === 'levelComplete') ui.levelBanner('LEVEL CLEARED!');
  if (fx.kind === 'clearAll' || fx.kind === 'clearHalf') mascot.setEmotion('surprised');
  if (fx.kind === 'gameover') mascot.setEmotion('sad');
}

function handleMessage(type, payload) {
  switch (type) {
    case 'state':
      boardScene.applyState(payload);
      ui.setState(payload);
      if (payload.giftLegend) ui.setGiftLegend(payload.giftLegend);
      // Music settings ride along with every snapshot, so admin changes apply live.
      applyMusicSettings(payload);
      break;
    case 'music':
      // Admin → Music "NEXT MUSIC" broadcasts a play command; a playlist reload
      // still sends the playlist itself.
      if (payload && payload.action === 'play') music.playFromCommand(payload);
      else music.setPlaylist(payload);
      break;
    case 'fx':
      boardScene.handleFx(payload);
      onFx(payload);
      break;
    case 'mascot':
      mascot.react(payload);
      break;
    case 'feed':
      ui.addFeed(payload);
      break;
    case 'notice':
      ui.showNotice(payload);
      break;
    case 'leaderboard':
      ui.setLeaderboardCache(payload);
      ui.setLeaderboard(payload);
      break;
    case 'tiktok':
      ui.setConnection({
        connected: Boolean(payload.connected),
        mode: payload.connected ? 'TIKFINITY LIVE' : 'MOCK / OFFLINE',
        eventsReceived: payload.eventsReceived,
      });
      break;
    case 'overlay':
      ui.showOverlay(payload.mode);
      break;
    case 'viewers':
      ui.setViewers(payload.count);
      break;
    default:
      break;
  }
}

function handleNetStatus(status) {
  if (status.connected) {
    reportTrack(true);
    return;
  }
  console.warn('[overlay] websocket disconnected, reconnecting...');
}

// --------------------------------------------------------------------- boot

async function bootstrap() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    applyBootstrap(await response.json());
  } catch (error) {
    console.error('[overlay] initial state fetch failed', error);
    ui.toast('Waiting for the game server...', 'warn');
  }

  net = new Net({ onMessage: handleMessage, onStatus: handleNetStatus });
  net.connect();

  // Safety net: if the socket cannot connect, keep the overlay's stats fresh.
  setInterval(async () => {
    if (net && net.connected) return;
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      applyBootstrap(await response.json());
    } catch {
      /* server still down */
    }
  }, 20000);
}

window.addEventListener('pointerdown', () => voice.cancel(), { once: true });
bootstrap();

window.addEventListener('beforeunload', () => {
  net?.close();
  mascot.stop();
  music.destroy();
  phaserGame?.destroy(true);
});
