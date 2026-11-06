/**
 * Overlay bootstrap: wires the server feed to the Phaser board, the DOM UI and
 * the mascot. The overlay is a pure view - it never validates a move or awards
 * a point by itself.
 */

import { BoardScene } from './boardScene.js';
import { UI } from './ui.js';
import { Mascot } from './mascot.js';
import { mascotSize } from './flight.js';
import { Voice } from './voice.js';
import { Music } from './music.js';
import { Net } from './net.js';

const ui = new UI();
const voice = new Voice();
const music = new Music();
const mascotLayer = document.getElementById('mascotLayer');

/** The board rectangle in 1080x1920 design coordinates (used for the rails). */
function measureBoard() {
  const stage = document.getElementById('stage');
  const frame = document.getElementById('boardFrame');
  if (!stage || !frame) return { x: 160, y: 470, w: 760, h: 698 };
  const stageRect = stage.getBoundingClientRect();
  const scale = stageRect.width / 1080 || 1;
  const rect = frame.getBoundingClientRect();
  return {
    x: (rect.left - stageRect.left) / scale,
    y: (rect.top - stageRect.top) / scale,
    w: rect.width / scale,
    h: rect.height / scale,
  };
}

// Two characters, two independent rails: Zappy on the left, Pip on the right.
// Neither rail can overlap the board, so no tile can ever be hidden.
const mascots = {
  zappy: new Mascot({
    layer: mascotLayer,
    voice,
    character: 'zappy',
    lane: 'left',
    size: mascotSize(0.6),
    boardRect: measureBoard(),
  }),
  pip: new Mascot({
    layer: mascotLayer,
    voice,
    character: 'pip',
    lane: 'right',
    size: mascotSize(0.6),
    boardRect: measureBoard(),
  }),
};
const mascotList = [mascots.zappy, mascots.pip];
let activeSpeaker = 'zappy';

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
// `__mascots.zappy.rect()` reports the exact rectangle each mascot covers.
window.__mascots = mascots;

// Zappy talks over the music: duck the bed while a line is being spoken.
const speak = voice.speak.bind(voice);
voice.speak = (text, options) => {
  const spoke = speak(text, options);
  if (spoke) music.duckFor(text);
  return spoke;
};

// ------------------------------------------------------- real speech reports

// The server cannot see the browser's speech engine, so the overlay reports
// what actually happened. Without this, Admin could claim SPEAKING while the
// page is silent.
const reportTts = (state, info = {}) => {
  // Only AI co-host lines carry a speech id; game/mascot callouts use the same
  // browser voice and must not be counted as AI speech.
  if (info.speechId === null || info.speechId === undefined) return;
  net?.send('tts-state', {
    state,
    id: info.speechId,
    text: info.text || '',
    error: info.error || null,
  });
};

voice.onStart = (info) => reportTts('start', info);
voice.onEnd = (info) => {
  reportTts('end', info);
  music.restore();
  mascots[activeSpeaker]?.onSpeechEnd();
};
voice.onError = (info) => {
  reportTts('error', info);
  music.restore();
};
voice.onVoices = (info) =>
  net?.send('tts-state', { state: 'voices', available: info.available, count: info.count });
for (const mascot of mascotList) {
  mascot.onSpeechSkipped = (line) =>
    net?.send('tts-state', { state: 'skipped', id: line.speechId, error: 'overlay-cooldown' });
}

// ------------------------------------------------------------------ stage fit

function fitStage() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const scale = Math.min(width / 1080, height / 1920);
  const stage = document.getElementById('stage');
  stage.style.transform = `translate(${(width - 1080 * scale) / 2}px, ${(height - 1920 * scale) / 2}px) scale(${scale})`;
  // The stage is scaled as one unit, so re-measuring keeps the rails correct on
  // any 9:16 screen (and after a browser zoom or window resize).
  const board = measureBoard();
  for (const mascot of mascotList) mascot.setRail(board);
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
    // Matches #boardBox exactly: the mascot rails are created by making the
    // board itself narrower, not by scaling it, so pointer coordinates stay 1:1.
    width: 720,
    height: 658,
    transparent: true,
    scale: { mode: window.Phaser.Scale.NONE, width: 720, height: 658 },
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
  mascots.zappy.setSettings(settings, 'aiMascotOneEnabled');
  // Pip only appears when TWO MASCOTS is on and its own toggle is on.
  mascots.pip.setSettings(
    { ...settings, aiMascotTwoEnabled: settings.aiMascotTwoEnabled !== false && settings.aiTwoMascots !== false },
    'aiMascotTwoEnabled'
  );
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
    mascots.zappy.setEmotion('celebrating');
    mascots.pip.setEmotion('thinking');
  }
  if (fx.kind === 'levelComplete') ui.levelBanner('LEVEL CLEARED!');
  if (fx.kind === 'clearAll' || fx.kind === 'clearHalf') {
    mascots.zappy.setEmotion('surprised');
    mascots.pip.setEmotion('thinking');
  }
  if (fx.kind === 'gameover') {
    mascots.zappy.setEmotion('sad');
    mascots.pip.setEmotion('sad');
  }
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
    case 'mascot': {
      // Speech owns exactly one mascot at a time: the speaker animates and gets
      // its own bubble, the other one listens with a reaction face.
      const speaker = payload?.speaker === 'pip' ? 'pip' : 'zappy';
      const other = speaker === 'pip' ? 'zappy' : 'pip';
      activeSpeaker = speaker;
      mascots[speaker].react(payload);
      if (mascots[other].enabled) mascots[other].listen(payload?.listenerEmotion || 'listening');
      break;
    }
    case 'mascot-fx': {
      // TikTok reactions (like, milestone, follow, share). Animation only: it
      // never speaks and never moves a mascot out of its rail.
      const target = payload?.target === 'left' ? ['zappy'] : payload?.target === 'right' ? ['pip'] : ['zappy', 'pip'];
      for (const id of target) {
        if (mascots[id]?.enabled) mascots[id].playFx(payload?.action || 'hearts');
      }
      break;
    }
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
    case 'session':
      // Admin RESET FOR NEW LIVE: drop the old feed/toasts before the fresh
      // state snapshot (sent right after) repaints the board and leaderboards.
      if (payload && payload.action === 'reset') {
        ui.clearSession();
        for (const mascot of mascotList) {
          mascot.hideBubble();
          mascot.setEmotion('neutral');
        }
        ui.toast('Fresh LIVE session started', 'ok');
      }
      break;
    default:
      break;
  }
}

function handleNetStatus(status) {
  if (status.connected) {
    reportTrack(true);
    // Fresh connection: tell the server how many TTS voices this page has.
    voice.reportVoices?.();
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
  for (const mascot of mascotList) mascot.stop();
  music.destroy();
  phaserGame?.destroy(true);
});
