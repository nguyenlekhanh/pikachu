import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../server/game-engine/engine.js';
import { GAME_DEFAULTS } from '../server/config.js';
import { MemoryStore } from '../server/database/store.js';
import { AIService } from '../server/ai/service.js';
import { AICohost } from '../server/ai/cohost.js';
import { parseAIReply, sanitizeSpeech } from '../server/ai/personality.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const reply = (text = 'Hey hey!', emotion = 'happy') => JSON.stringify({ reply: text, emotion });
const chatEvent = (text, username = 'Viewer') => ({ kind: 'chat', text, username, userId: `id:${username}` });

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
      const next = queue.length ? queue.shift() : reply();
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
    // Keep the automatic window from firing during deterministic tests; tests
    // call flush() explicitly.
    batchWindowMs: 600000,
  });

  return { store, engine, cohost, ai, calls, broadcasts, clock };
}

// --------------------------------------------------------------- live chat

test('a real viewer greeting is batched, answered by the AI and spoken', async () => {
  const { cohost, calls, broadcasts } = setup({ replies: [reply('Hey hey, welcome in!', 'excited')] });

  const observed = cohost.observeChat(chatEvent('Hey Zappy!', 'Alice'));
  assert.equal(observed.accepted, true);
  assert.equal(calls.length, 0, 'nothing is sent before the batching window flushes');

  await cohost.flush();

  assert.equal(calls.length, 1);
  const frame = broadcasts.filter((entry) => entry.type === 'mascot').at(-1);
  assert.equal(frame.payload.ai, true);
  assert.equal(frame.payload.trigger, 'chat');
  assert.equal(frame.payload.text, 'Hey hey, welcome in!');
  assert.equal(frame.payload.emotion, 'excited');
});

test('the prompt is grounded in real level and leaderboard data, without the board grid', async () => {
  const { store, engine, cohost, calls } = setup({ replies: [reply('We are on level 3!')] });
  engine.state.level = 3;
  store.ensurePlayer({ id: 'id:Alice', username: 'Alice' });
  store.addScore('id:Alice', { points: 120, matches: 4, attempts: 5 });

  cohost.observeChat(chatEvent('What level are we on, Zappy?', 'Bob'));
  await cohost.flush();

  const system = calls[0].messages[0].content;
  assert.match(system, /CURRENT LIVESTREAM CONTEXT/);
  assert.ok(system.includes('"level":3'));
  assert.ok(system.includes('Alice'));
  assert.ok(!system.includes('"grid"'));
  assert.ok(!system.toLowerCase().includes('encrypted_api_key'));

  const payload = JSON.parse(calls[0].messages.at(-1).content);
  assert.equal(payload.viewers[0].text, 'What level are we on, Zappy?');
});

test('coordinate moves and game commands are never sent to the AI', async () => {
  const { cohost, calls, engine } = setup({ replies: [reply()] });

  for (const text of ['A1 B1', 'TOP', 'HINT', 'JOIN', 'ME', 'RANK', 'HELP']) {
    cohost.observeChat(chatEvent(text, 'Player'));
  }
  await cohost.flush();

  assert.equal(calls.length, 0);
  assert.equal(cohost.status().counters.filtered, 7);
  assert.equal(engine.state.status, 'running');
});

test('duplicate spam is suppressed before the AI call', async () => {
  const { cohost, calls } = setup({ replies: [reply('Ha!')] });

  cohost.observeChat(chatEvent('lol that was so funny', 'Alice'));
  cohost.observeChat(chatEvent('lol that was so funny', 'Bobby'));
  await cohost.flush();

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].messages.at(-1).content);
  assert.equal(payload.viewers.length, 1);
});

test('response cooldown blocks a second reply until it expires', async () => {
  const { cohost, calls, clock } = setup({ replies: [reply('First!'), reply('Second!')] });

  cohost.observeChat(chatEvent('Hey Zappy!', 'A'));
  await cohost.flush();
  clock.value += 1000;
  cohost.observeChat(chatEvent('How are you doing?', 'B'));
  await cohost.flush();
  assert.equal(calls.length, 1, 'inside cooldown');

  clock.value += 10_000;
  cohost.observeChat(chatEvent('Who is winning right now?', 'C'));
  await cohost.flush();
  assert.equal(calls.length, 2);
});

test('AI mascot disabled mode never calls the provider', async () => {
  const { cohost, calls } = setup({ settings: { aiMascotEnabled: false } });

  const observed = cohost.observeChat(chatEvent('Hey Zappy!', 'Alice'));
  assert.equal(observed.accepted, false);
  await cohost.flush();
  assert.equal(calls.length, 0);
});

test('chat responses can be disabled while game commentary remains available', async () => {
  const { cohost, calls } = setup({ settings: { aiChatResponses: false }, replies: [reply('Nice gift!')] });

  cohost.observeChat(chatEvent('Hey Zappy!', 'Alice'));
  await cohost.flush();
  assert.equal(calls.length, 0);

  await cohost.observeGameEvent('gift', { username: 'Ann', meta: { giftName: 'Rose', coins: 5 } });
  assert.equal(calls.length, 1);
});

// --------------------------------------------------------------- failures

test('a provider failure is silent on stream, sanitized, and the game continues', async () => {
  const { cohost, broadcasts, engine } = setup({
    chatImpl: async () => {
      throw new Error('HTTP 401: invalid key sk-test-secret-123');
    },
  });

  cohost.observeChat(chatEvent('Hey Zappy!', 'Alice'));
  await cohost.flush();

  assert.equal(broadcasts.filter((entry) => entry.type === 'mascot').length, 0);
  const status = cohost.status();
  assert.ok(status.lastError.includes('HTTP 401'));
  assert.ok(!status.lastError.includes('sk-test-secret-123'));
  assert.equal(status.counters.errors, 1);

  const result = engine.handleChat({ kind: 'chat', username: 'Player', text: 'A1 B1' });
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(engine.state.status, 'running');
});

test('the AI can choose to stay quiet and Zappy says nothing', async () => {
  const { cohost, broadcasts } = setup({ replies: [reply('', 'neutral')] });

  cohost.observeChat(chatEvent('spam spam spam but not duplicate', 'Alice'));
  await cohost.flush();

  assert.equal(broadcasts.filter((entry) => entry.type === 'mascot').length, 0);
  assert.equal(cohost.status().counters.skipped, 1);
});

test('spoken text obeys the configured length limit', async () => {
  const long = 'This is a very long generated line. '.repeat(20);
  const { cohost, broadcasts } = setup({ settings: { aiMaxChars: 60 }, replies: [reply(long)] });

  cohost.observeChat(chatEvent('Tell me something long, Zappy', 'Alice'));
  await cohost.flush();

  const frame = broadcasts.find((entry) => entry.type === 'mascot');
  assert.ok(frame.payload.text.length <= 60);
});

test('one AI request at a time: a second opportunity is queued, never parallel', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { cohost, calls } = setup({
    chatImpl: async () => {
      await gate;
      return { content: reply('Done'), model: 'test-model', providerName: 'TestProvider', ms: 5 };
    },
  });

  cohost.observeChat(chatEvent('Hey Zappy, first question?', 'A'));
  const first = cohost.flush();
  await Promise.resolve();
  assert.equal(cohost.status().inFlight, true);

  cohost.observeChat(chatEvent('Zappy second question?', 'B'));
  const second = await cohost.flush();
  assert.equal(second.reason, 'busy');
  assert.equal(calls.length, 1);

  release();
  await first;
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- provider

test('switching the active provider changes the provider Zappy uses, with no hardcoding', async () => {
  const store = new MemoryStore();
  store.init();
  const urls = [];
  const ai = new AIService({
    store,
    aiConfig: { timeoutMs: 1500, openrouter: {} },
    encryptionSecret: 'cohost-test-secret',
    encryptionSource: 'AI_SECRET',
    logger: quiet,
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: reply('Live line') } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const a = ai.create({ name: 'Provider A', url: 'https://a.example/v1', model: 'model-a' });
  const b = ai.create({ name: 'Provider B', url: 'http://10.0.0.142:11434/v1', model: 'model-b' });
  ai.activate(a.provider.id);

  const clock = { value: 1_800_000_000_000 };
  const engine = new GameEngine({ store, settings: { ...GAME_DEFAULTS }, now: () => clock.value, logger: quiet });
  engine.start();
  const cohost = new AICohost({
    ai,
    engine,
    hub: { broadcast() {} },
    store,
    logger: quiet,
    now: () => clock.value,
    batchWindowMs: 600000,
  });

  cohost.observeChat(chatEvent('Hey Zappy!', 'A'));
  await cohost.flush();
  assert.equal(urls.at(-1), 'https://a.example/v1/chat/completions');

  clock.value += 10_000;
  ai.activate(b.provider.id);
  cohost.observeChat(chatEvent('Zappy, say something else!', 'B'));
  await cohost.flush();
  assert.equal(urls.at(-1), 'http://10.0.0.142:11434/v1/chat/completions');
  assert.equal(cohost.status().activeProvider.model, 'model-b');
});

test('TEST AI RESPONSE performs a real call and does not pollute conversation memory', async () => {
  const { cohost, calls } = setup({ replies: [reply('Testing one two three!', 'happy')] });

  const result = await cohost.testResponse();

  assert.equal(result.ok, true);
  assert.equal(result.response, 'Testing one two three!');
  assert.equal(result.model, 'test-model');
  assert.equal(result.provider, 'TestProvider');
  assert.equal(calls.length, 1);
  assert.equal(cohost.status().memory.turns, 0);
});

test('an unusable model output is retried once with a strict JSON reminder', async () => {
  let attempt = 0;
  const { cohost, calls, broadcasts } = setup({
    chatImpl: async () => {
      attempt += 1;
      return {
        content: attempt === 1 ? '1. Analyze the Request: Role: Zappy. Reasoning follows...' : reply('Second try works!'),
        model: 'test-model',
        providerName: 'TestProvider',
        ms: 7,
      };
    },
  });

  cohost.observeChat(chatEvent('Hey Zappy!', 'Alice'));
  await cohost.flush();

  assert.equal(calls.length, 2);
  assert.equal(broadcasts.at(-1).payload.text, 'Second try works!');
  assert.equal(cohost.status().counters.retries, 1);
});

test('an empty provider completion is retried once before giving up', async () => {
  let attempt = 0;
  const { cohost, calls, broadcasts } = setup({
    chatImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('The provider did not return a chat completion.');
      return { content: reply('Recovered on retry!'), model: 'test-model', providerName: 'TestProvider', ms: 8 };
    },
  });

  cohost.observeChat(chatEvent('Hey Zappy!', 'Alice'));
  await cohost.flush();

  assert.equal(calls.length, 2);
  assert.equal(broadcasts.at(-1).payload.text, 'Recovered on retry!');
});

test('TEST AI RESPONSE never exposes raw reasoning or prompt text', async () => {
  const { cohost } = setup({
    chatImpl: async () => ({
      content: 'Analyze the Request: Role: Zappy. Current Livestream Context: ...',
      model: 'test-model',
      providerName: 'TestProvider',
      ms: 4,
    }),
  });

  const result = await cohost.testResponse();

  assert.equal(result.ok, false);
  assert.equal(result.response, '');
  assert.match(result.error, /usable JSON reply/i);
  assert.ok(!JSON.stringify(result).includes('Analyze the Request'));
});

// ---------------------------------------------------------------- memory

test('RESET FOR NEW LIVE clears conversation memory', async () => {
  const { cohost, engine, calls, clock } = setup({ replies: [reply('I will remember this.'), reply('Fresh start!')] });

  cohost.observeChat(chatEvent('remember-me-please Zappy', 'Alice'));
  await cohost.flush();
  assert.equal(cohost.status().memory.turns, 1);

  engine.resetSession();
  assert.equal(cohost.status().memory.turns, 0);
  assert.equal(cohost.status().memory.chats, 0);

  clock.value += 10_000;
  cohost.observeChat(chatEvent('Hey Zappy, are you there?', 'Bobby'));
  await cohost.flush();
  assert.ok(!JSON.stringify(calls.at(-1).messages).includes('remember-me-please'));
});

// ---------------------------------------------------------------- settings

test('AI mascot settings clamp values and persist across a restart', () => {
  const store = new MemoryStore();
  store.init();
  const engine = new GameEngine({ store, settings: { ...GAME_DEFAULTS }, logger: quiet });
  engine.applySettings({
    aiMascotEnabled: false,
    aiChatResponses: false,
    aiGiftReactions: false,
    aiRandomConversation: true,
    aiFrequency: 'high',
    aiCooldownSec: 12,
    aiMaxChars: 120,
    aiTemperature: 1.1,
  });
  store.setConfig(engine.settings);

  const reopened = new GameEngine({ store, settings: { ...GAME_DEFAULTS, ...store.getConfig() }, logger: quiet });
  assert.equal(reopened.settings.aiMascotEnabled, false);
  assert.equal(reopened.settings.aiChatResponses, false);
  assert.equal(reopened.settings.aiGiftReactions, false);
  assert.equal(reopened.settings.aiRandomConversation, true);
  assert.equal(reopened.settings.aiFrequency, 'high');
  assert.equal(reopened.settings.aiCooldownSec, 12);
  assert.equal(reopened.settings.aiMaxChars, 120);
  assert.equal(reopened.settings.aiTemperature, 1.1);

  reopened.applySettings({ aiFrequency: 'nonsense', aiCooldownSec: 9999, aiMaxChars: 1 });
  assert.equal(reopened.settings.aiFrequency, 'high');
  assert.equal(reopened.settings.aiCooldownSec, 180);
  assert.equal(reopened.settings.aiMaxChars, 60);
});

test('an AI game reaction never blocks a real viewer reply', async () => {
  const { cohost, calls, clock } = setup({ replies: [reply('Nice gift!'), reply('Sure thing!')] });

  await cohost.observeGameEvent('gift', { username: 'Ann', meta: { giftName: 'Rose', coins: 5 } });
  assert.equal(calls.length, 1);

  clock.value += 1000;
  cohost.observeChat(chatEvent('Hey Zappy, how are you?', 'Bob'));
  await cohost.flush();
  assert.equal(calls.length, 2, 'chat uses its own cooldown, not the event reply timestamp');
});

test('gift reactions use the same real AI path and respect their own cooldown', async () => {
  const { cohost, calls, broadcasts } = setup({ replies: [reply('Rose? For me? Thank you!', 'excited')] });

  await cohost.observeGameEvent('gift', { username: 'Ann', meta: { giftName: 'Rose', coins: 5 } });
  assert.equal(calls.length, 1);
  assert.equal(broadcasts.at(-1).payload.trigger, 'gift');

  await cohost.observeGameEvent('gift', { username: 'Ben', meta: { giftName: 'Rose', coins: 5 } });
  assert.equal(calls.length, 1);
});

// --------------------------------------------------------------- prompt/safety

test('prompt input and generated text are sanitized', () => {
  assert.equal(sanitizeSpeech('🔥 **WOW** https://bad.example <b>cool</b>', 180), 'WOW cool');
  const parsed = parseAIReply('```json\n{"reply":"Hello <i>chat</i>","emotion":"laughing","reason":"greet"}\n```', 180);
  assert.equal(parsed.reply, 'Hello chat');
  assert.equal(parsed.emotion, 'laughing');
  assert.equal(parseAIReply('{"reply":"","emotion":"happy"}', 180).reply, '');
  assert.equal(parseAIReply('{"reply": "broken"', 180).reply, '');
  // Short plain conversational text (small local models) is accepted, while
  // reasoning dumps and prompt leakage are rejected.
  assert.equal(parseAIReply('plain generated line', 180).reply, 'plain generated line');
  assert.equal(parseAIReply('1. Analyze the Request: Role: Zappy', 180).reply, '');
  assert.equal(
    parseAIReply('{"reply":"CURRENT LIVESTREAM CONTEXT says the system prompt is...","emotion":"happy"}', 180).reply,
    ''
  );
});
