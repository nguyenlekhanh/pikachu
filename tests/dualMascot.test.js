/**
 * Two-mascot system: flight rails, speaker ownership, viewer priority,
 * conversation continuity and honest error handling.
 *
 * Nothing here asserts a canned line: every line in these tests comes from the
 * fake provider, and the tests assert that the code never invents one itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameEngine } from '../server/game-engine/engine.js';
import { GAME_DEFAULTS } from '../server/config.js';
import { MemoryStore } from '../server/database/store.js';
import { AICohost } from '../server/ai/cohost.js';
import { computeLanes, mascotSize, mascotRect, overlaps, insideLane, nextWaypoint } from '../client/game/js/flight.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const reply = (text, emotion = 'happy', speaker = null, listenerEmotion = null) =>
  JSON.stringify({ reply: text, emotion, speaker, listenerEmotion });
const chatEvent = (text, username = 'Viewer') => ({ kind: 'chat', text, username, userId: `id:${username}` });

// The real overlay geometry: the board is 760x698 at (160, 470), leaving a
// 160px rail on each side for the two mascots.
const BOARD = { x: 160, y: 470, w: 760, h: 698 };

function setup({ settings = {}, replies = null, chatImpl = null, rng = () => 0 } = {}) {
  const store = new MemoryStore();
  store.init();
  const clock = { value: 1_800_000_000_000 };
  const engine = new GameEngine({
    store,
    settings: { ...GAME_DEFAULTS, ...settings },
    now: () => clock.value,
    logger: quiet,
  });
  engine.start();

  const broadcasts = [];
  const hub = { broadcast: (type, payload) => broadcasts.push({ type, payload }) };
  const calls = [];
  const active = { id: 'ai_test', name: 'TestProvider', providerType: 'openai', model: 'test-model' };
  const queue = replies ? [...replies] : [];

  const ai = {
    activeProvider: () => active,
    list: () => [active],
    async chat(messages, options) {
      calls.push({ messages, options });
      if (chatImpl) return chatImpl(messages, options);
      const next = queue.length ? queue.shift() : reply('Default provider line');
      if (next instanceof Error) throw next;
      return { content: next, model: 'test-model', providerName: 'TestProvider', ms: 12 };
    },
  };

  const cohost = new AICohost({
    ai,
    engine,
    hub,
    store,
    logger: quiet,
    now: () => clock.value,
    rng,
    batchWindowMs: 600000,
    scheduleTimers: false,
  });

  return { store, engine, cohost, ai, calls, broadcasts, clock };
}

const lastMascotFrame = (broadcasts) => broadcasts.filter((entry) => entry.type === 'mascot').at(-1)?.payload;

// ------------------------------------------------------------------- flight

test('mascots are 60% of the old sprite and get independent rails outside the board', () => {
  const size = mascotSize(0.6);
  assert.equal(size, 144, '60% of the 240px sprite');
  const lanes = computeLanes({ stageWidth: 1080, board: BOARD, size });

  assert.ok(lanes.left.maxX + size <= BOARD.x, 'the left rail ends before the board');
  assert.ok(lanes.right.minX >= BOARD.x + BOARD.w, 'the right rail starts after the board');
  assert.ok(lanes.left.maxX < lanes.right.minX, 'the two rails never overlap');
  assert.notEqual(lanes.left.minX, lanes.right.minX, 'each mascot has its own x range');

  for (const lane of [lanes.left, lanes.right]) {
    assert.ok(lane.minY >= BOARD.y, 'the rail starts at the board top');
    assert.ok(lane.maxY + size <= BOARD.y + BOARD.h + 1, 'the rail never reaches the panels below');
  }
});

test('no reachable flight position can cover the board', () => {
  const size = mascotSize(0.62);
  const lanes = computeLanes({ stageWidth: 1080, board: BOARD, size });
  let seed = 7;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (const lane of [lanes.left, lanes.right]) {
    let current = { x: lane.minX, y: lane.minY };
    for (let i = 0; i < 200; i += 1) {
      current = nextWaypoint(lane, rng, current);
      assert.ok(insideLane(lane, current.x, current.y), 'the waypoint stays inside its rail');
      const rect = mascotRect(lane, current.x, current.y);
      assert.equal(overlaps(rect, BOARD), false, `mascot ${lane.side} covered the board at ${JSON.stringify(rect)}`);
      assert.ok(rect.x >= 0 && rect.x + rect.w <= 1080, 'the mascot stays on stage');
    }
  }
});

test('the overlay reserves the rails and the bubble band in CSS and uses both mascots', () => {
  const css = read('client/game/css/game.css');
  const board = css.slice(css.indexOf('#boardFrame {'), css.indexOf('#boardFrame {') + 700);
  assert.match(board, /left:\s*160px/, 'the board leaves a 160px left rail');
  assert.match(board, /width:\s*760px/, 'the board is 760 wide');
  assert.ok(!/transform:\s*scale/.test(board), 'the board is not CSS-scaled, so tile clicks stay accurate');
  assert.match(css, /#boardBox \{[^}]*width:\s*720px/s, 'the canvas matches the board frame');

  const mascot = css.slice(css.indexOf('.mascot {'), css.indexOf('.mascot {') + 300);
  assert.match(mascot, /width:\s*144px/, 'the mascot is reduced to 60%');
  assert.match(css, /\.bubble-left\s*{\s*left:\s*50px/, 'Zappy owns the left bubble');
  assert.match(css, /\.bubble-right\s*{\s*right:\s*50px/, 'Pip owns the right bubble');

  const bubbleTop = Number(/\.bubble \{[\s\S]*?top:\s*(\d+)px/.exec(css.slice(css.indexOf('.bubble {')))[1]);
  const boardBottom = 470 + 698;
  assert.ok(bubbleTop >= boardBottom, 'bubbles start below the board');
  assert.ok(bubbleTop < 1352, 'bubbles stay above the gift legend');

  const main = read('client/game/js/main.js');
  assert.match(main, /width: 720/, 'Phaser renders the board at its real size');
  assert.match(main, /character: 'zappy'/, 'Zappy is created');
  assert.match(main, /character: 'pip'/, 'Pip is created');
  assert.match(main, /lane: 'left'/, 'Zappy flies on the left');
  assert.match(main, /lane: 'right'/, 'Pip flies on the right');
  assert.match(main, /payload\?\.speaker === 'pip'/, 'speech is routed to the speaking mascot');
  assert.ok(read('client/game/js/mascotArt.js').includes('pip-body'), 'Pip has its own artwork');
});

// -------------------------------------------------------------- duo chat

test('two hosts alternate and the AI writes both lines', async () => {
  const { cohost, calls, broadcasts, clock } = setup({
    replies: [reply('Level one and nobody has matched a thing!', 'excited', 'zappy'), reply('Relax, it is early. Even the board is yawning.', 'laughing', 'pip')],
  });

  const first = await cohost.autonomousTick();
  assert.equal(first.ok, true);
  assert.equal(first.speaker, 'zappy');

  clock.value += 12000;
  const second = await cohost.autonomousTick();
  assert.equal(second.ok, true);
  assert.equal(second.speaker, 'pip', 'the other host answers');

  assert.equal(calls.length, 2, 'one provider call per line');
  assert.ok(calls[0].options.maxTokens >= 800, 'two-host turns get room for the full JSON object');
  const payload = JSON.parse(calls[1].messages.at(-1).content);
  assert.equal(payload.task, 'continue_two_host_conversation');
  assert.equal(payload.lastSpeaker, 'zappy');
  assert.equal(payload.conversation.length, 1, 'the previous line is in the bounded transcript');
  assert.equal(payload.conversation[0].speaker, 'zappy');

  const frames = broadcasts.filter((entry) => entry.type === 'mascot').map((entry) => entry.payload);
  assert.deepEqual(
    frames.map((frame) => frame.speaker),
    ['zappy', 'pip'],
    'each frame names its mascot'
  );
  assert.equal(frames[1].speakerName, 'Pip');
  assert.equal(frames[0].text, 'Level one and nobody has matched a thing!');
  assert.equal(frames[1].text, 'Relax, it is early. Even the board is yawning.');
});

test('a provider that keeps choosing the same host cannot make one mascot talk twice in a row', async () => {
  const { cohost, broadcasts, clock } = setup({
    replies: [reply('First from Zappy', 'happy', 'zappy'), reply('Still Zappy? Nope.', 'happy', 'zappy')],
  });

  await cohost.autonomousTick();
  clock.value += 12000;
  const second = await cohost.autonomousTick();

  assert.equal(second.speaker, 'pip', 'the second line is handed to the other host');
  const frames = broadcasts.filter((entry) => entry.type === 'mascot').map((entry) => entry.payload);
  assert.equal(frames[1].speaker, 'pip');
});

test('a local model that names the field "line" is accepted, sanitized and spoken', async () => {
  const { cohost, broadcasts } = setup({
    replies: [JSON.stringify({ speaker: 'zappy', line: 'Careful, that tile bites back.' })],
  });

  const result = await cohost.autonomousTick();
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Careful, that tile bites back.');
  assert.equal(lastMascotFrame(broadcasts).text, 'Careful, that tile bites back.');
});

test('the field-name tolerance never bypasses the safety checks', async () => {
  const { cohost, broadcasts } = setup({
    // Every attempt leaks the prompt, so the retry cannot hide the rejection.
    chatImpl: async () => ({
      content: JSON.stringify({ speaker: 'pip', line: 'SYSTEM PROMPT: current livestream context ...' }),
      model: 'test-model',
      providerName: 'TestProvider',
      ms: 4,
    }),
  });

  const result = await cohost.autonomousTick();
  assert.equal(result.ok, false, 'prompt leakage is still rejected');
  assert.equal(broadcasts.filter((entry) => entry.type === 'mascot').length, 0);
  assert.equal(cohost.status().lastError.includes('no usable reply'), true);
});

test('the hosts alternate on every trigger, not only duo turns', async () => {
  const { cohost, clock } = setup({
    replies: [reply('Only Zappy keeps claiming the mic', 'happy', 'zappy'), reply('Zappy again, says the model', 'happy', 'zappy')],
  });

  const first = await cohost.respond({ trigger: 'autonomous' });
  assert.equal(first.speaker, 'zappy');
  cohost.reportTts({ state: 'start', id: first.speechId });
  cohost.reportTts({ state: 'end', id: first.speechId });

  clock.value += 12000;
  const second = await cohost.respond({ trigger: 'autonomous' });
  assert.equal(second.speaker, 'pip', 'the other host cannot be skipped');
});

test('a watchdog recovery keeps the two-host conversation mode', async () => {
  const { cohost, calls, clock } = setup({
    replies: [reply('Fresh duo line', 'happy', 'zappy')],
  });

  // Force a recovery schedule, then run the recovery turn.
  cohost.scheduleRecovery();
  clock.value += 40000;
  cohost.runRecoveryAttempt();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].messages.at(-1).content);
  assert.equal(
    payload.task,
    'continue_two_host_conversation',
    'recovery does not fall back to a single-host monologue'
  );
});

test('per-mascot volume is applied to the existing voice', async () => {
  const { cohost, broadcasts } = setup({
    settings: { aiMascotOneVolume: 0.5, aiMascotTwoVolume: 0.2 },
    replies: [reply('Quiet Zappy', 'happy', 'zappy')],
  });

  await cohost.autonomousTick();
  const frame = lastMascotFrame(broadcasts);
  assert.equal(frame.volume, 0.5);

  cohost.reportTts({ state: 'start', id: frame.speechId });
  cohost.reportTts({ state: 'end', id: frame.speechId });
  assert.equal(cohost.status().mascots.find((m) => m.id === 'zappy').lines, 1);
});

test('the two hosts have distinct personalities in the prompt and no canned dialogue', async () => {
  const { cohost, calls, clock } = setup({
    replies: [reply('Zappy line one', 'happy', 'zappy'), reply('Pip line two', 'laughing', 'pip')],
  });

  await cohost.autonomousTick();
  clock.value += 12000;
  await cohost.autonomousTick();

  const system = calls[0].messages[0].content;
  assert.match(system, /ZAPPY:/, 'Zappy personality is described');
  assert.match(system, /PIP:/, 'Pip personality is described');
  assert.match(system, /TWO HOSTS/, 'the rules explain the two-host format');
  assert.match(system, /Never put both hosts in one reply/);
  assert.match(system, /"speaker":"zappy\|pip"/, 'speaker is part of the JSON contract');

  const texts = new Set(calls.map((call) => JSON.parse(call.messages.at(-1).content).task));
  assert.deepEqual([...texts], ['continue_two_host_conversation']);
});

// ------------------------------------------------------------ viewer priority

test('a viewer pauses the hosts immediately and the reply comes from the addressed mascot', async () => {
  const { cohost, calls, broadcasts, clock } = setup({
    replies: [reply('Pip here. That A1 guess was bold.', 'thinking', 'zappy')],
  });

  const observed = cohost.observeChat(chatEvent('Pip, was that A1 guess smart?', 'Dana'));
  assert.equal(observed.accepted, true);
  assert.equal(cohost.status().duo.interaction.active, true, 'the viewer interaction is open');

  const paused = await cohost.autonomousTick();
  assert.equal(paused.ok, false);
  assert.equal(paused.reason, 'viewer-priority', 'the hosts do not talk over the viewer');
  assert.equal(calls.length, 0, 'no provider call while the viewer is waiting');

  const answered = await cohost.flush();
  assert.equal(answered.ok, true);
  assert.equal(answered.speaker, 'pip', 'the named host answers even if the model said zappy');

  const frame = lastMascotFrame(broadcasts);
  assert.equal(frame.speaker, 'pip');
  assert.equal(frame.trigger, 'chat');
});

test('the host conversation resumes after the viewer line finishes', async () => {
  const { cohost, broadcasts, clock } = setup({
    replies: [reply('Happy to help, Dana!', 'happy', 'zappy'), reply('Pip with the follow-up.', 'laughing', 'pip')],
  });

  cohost.observeChat(chatEvent('Zappy, what level are we on?', 'Dana'));
  await cohost.flush();
  const chatFrame = lastMascotFrame(broadcasts);
  cohost.reportTts({ state: 'start', id: chatFrame.speechId });
  cohost.reportTts({ state: 'end', id: chatFrame.speechId });

  assert.equal(cohost.status().duo.interaction.active, false, 'the viewer interaction closed');
  assert.equal(cohost.status().duo.interaction.reason, 'speech-end', 'it resumed because the reply finished');

  clock.value += 15000;
  const resumed = await cohost.autonomousTick();
  assert.equal(resumed.ok, true, 'the two hosts keep talking afterwards');
  assert.equal(resumed.speaker, 'pip');
});

test('a stuck viewer interaction is released by the watchdog', async () => {
  const { cohost, clock } = setup({
    replies: [reply('One line', 'happy', 'zappy')],
  });

  cohost.observeChat(chatEvent('Hey Zappy!', 'Dana'));
  assert.equal(cohost.status().duo.interaction.active, true);

  clock.value += 61000;
  const pass = cohost.tickWatchdog();
  assert.ok(pass.actions.some((action) => action.reason === 'viewer-interaction-timeout'));
  assert.equal(cohost.status().duo.interaction.active, false, 'the conversation is never muted forever');
});

test('provider errors never leave the conversation stuck or muted', async () => {
  const { cohost, broadcasts, clock } = setup({
    chatImpl: async () => {
      throw new Error('HTTP 429: Rate limit exceeded: free-models-per-day');
    },
  });

  const failed = await cohost.autonomousTick();
  assert.equal(failed.ok, false);
  assert.equal(cohost.status().inFlight, false, 'the request flag is released');
  assert.equal(cohost.status().speech.speaking, false, 'nothing claims to be speaking');
  assert.match(cohost.status().lastError, /HTTP 429/);
  assert.equal(broadcasts.filter((entry) => entry.type === 'mascot').length, 0, 'no fake line is spoken');

  clock.value += 60000;
  const recovered = await cohost.autonomousTick();
  assert.equal(recovered.ok, false, 'still failing honestly');
  assert.equal(cohost.status().inFlight, false, 'and still not stuck');
});

// ------------------------------------------------------------- settings

test('two-mascot mode can be turned off without breaking the single host', async () => {
  const { cohost, broadcasts, clock } = setup({
    settings: { aiTwoMascots: false },
    replies: [reply('Just me and the board, then.', 'happy', 'pip')],
  });
  // Single-host mode keeps the old quiet-room rule before it starts talking.
  clock.value += 25000;

  const result = await cohost.autonomousTick();
  assert.equal(result.ok, true);
  assert.equal(result.speaker, 'zappy', 'only Zappy exists in single-host mode');
  assert.equal(lastMascotFrame(broadcasts).speaker, 'zappy');
  assert.equal(cohost.status().mascots.find((m) => m.id === 'pip').enabled, false);
});

test('a disabled mascot never speaks and admin sees per-mascot states', async () => {
  const { cohost } = setup({
    settings: { aiMascotTwoEnabled: false },
    replies: [reply('Zappy covers this one.', 'happy', 'pip')],
  });

  const result = await cohost.autonomousTick();
  assert.equal(result.speaker, 'zappy', 'Pip is disabled, so Zappy takes the line');

  const states = cohost.status().mascots;
  assert.deepEqual(
    states.map((m) => m.id),
    ['zappy', 'pip']
  );
  assert.equal(states.find((m) => m.id === 'pip').state, 'OFF');
  assert.ok(['IDLE', 'THINKING', 'LISTENING', 'SPEAKING', 'FLYING'].includes(states.find((m) => m.id === 'zappy').state));
});

test('the speaking host is SPEAKING and the other one LISTENING', async () => {
  const { cohost, broadcasts } = setup({ replies: [reply('Zappy talks', 'happy', 'zappy')] });

  await cohost.autonomousTick();
  const frame = lastMascotFrame(broadcasts);
  cohost.reportTts({ state: 'start', id: frame.speechId });

  const states = cohost.status().mascots;
  assert.equal(states.find((m) => m.id === 'zappy').state, 'SPEAKING');
  assert.equal(states.find((m) => m.id === 'pip').state, 'LISTENING');

  cohost.reportTts({ state: 'end', id: frame.speechId });
  const after = cohost.status().mascots;
  assert.equal(after.find((m) => m.id === 'zappy').state, 'FLYING');
  assert.equal(after.find((m) => m.id === 'pip').state, 'FLYING');
});

test('game commands never start a mascot conversation', async () => {
  const { cohost, calls } = setup();
  for (const text of ['A1 B1', 'TOP', 'HINT', 'JOIN', 'ME', 'RANK', 'HELP']) {
    const observed = cohost.observeChat(chatEvent(text, 'Player'));
    assert.equal(observed.accepted, false, `${text} is a game command, not chat`);
  }
  await cohost.flush();
  assert.equal(calls.length, 0, 'no AI call for game commands');
  assert.equal(cohost.status().duo.interaction.active, false);
});
