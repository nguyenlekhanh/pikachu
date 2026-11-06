/**
 * TikTok like / follow / share interactions for the two mascots.
 *
 * Every line in these tests comes from the fake provider: nothing here asserts
 * a canned reply, and the tests check that the code never invents a viewer,
 * a like count or a milestone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { GameEngine } from '../server/game-engine/engine.js';
import { GAME_DEFAULTS } from '../server/config.js';
import { MemoryStore } from '../server/database/store.js';
import { AICohost, PRIORITY } from '../server/ai/cohost.js';
import { InteractionTracker, LIKE_MILESTONES, milestonesFor, EVENT_FREQUENCY } from '../server/ai/interactions.js';
import { normalizeEvent } from '../server/tiktok/normalize.js';
import { MockAdapter } from '../server/tiktok/mock.js';
import { TikFinityAdapter } from '../server/tiktok/tikfinity.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const reply = (text, emotion = 'happy', speaker = null) => JSON.stringify({ reply: text, emotion, speaker });

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
  // One overlay is connected, so a pending line really can be interrupted.
  const hub = { clientCount: 1, broadcast: (type, payload) => broadcasts.push({ type, payload }) };
  const calls = [];
  const active = { id: 'ai_test', name: 'TestProvider', providerType: 'openai', model: 'test-model' };
  const queue = replies ? [...replies] : [];
  const ai = {
    activeProvider: () => active,
    list: () => [active],
    async chat(messages, options) {
      calls.push({ messages, options });
      if (chatImpl) return chatImpl(messages, options);
      const next = queue.length ? queue.shift() : reply('Provider generated line');
      if (next instanceof Error) throw next;
      return { content: next, model: 'test-model', providerName: 'TestProvider', ms: 10 };
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

const promptOf = (call) => String(call.messages.at(-1)?.content || '');
const likeEvent = (username, count = 5, extra = {}) => ({
  kind: 'like',
  userId: `id:${username}`,
  username,
  likeCount: count,
  ...extra,
});
const followEvent = (username) => ({ kind: 'follow', userId: `id:${username}`, username, displayName: username });
const shareEvent = (username) => ({ kind: 'share', userId: `id:${username}`, username });

// ------------------------------------------------------------ normalization

test('TikFinity like, follow and share payloads normalize with real data', () => {
  const like = normalizeEvent({
    event: 'like',
    data: { uniqueId: 'LunaPlays', userId: '42', likeCount: 12, totalLikeCount: 1200 },
  });
  assert.equal(like.kind, 'like');
  assert.equal(like.username, 'LunaPlays');
  assert.equal(like.likeCount, 12, 'a like event carries the real number of taps');
  assert.equal(like.totalLikeCount, 1200);

  const follow = normalizeEvent({ event: 'follow', data: { uniqueId: 'MikeTheBoss', userId: '43' } });
  assert.equal(follow.kind, 'follow');
  assert.equal(follow.username, 'MikeTheBoss');

  const share = normalizeEvent({ event: 'share', data: { uniqueId: 'PixelPaula', userId: '44' } });
  assert.equal(share.kind, 'share');
  assert.equal(share.username, 'PixelPaula');

  // TikFinity's "social" envelope carries follows too.
  assert.equal(normalizeEvent({ event: 'social', data: { uniqueId: 'x', action: 'follow' } }).kind, 'follow');
  assert.equal(normalizeEvent({ event: 'social', data: { uniqueId: 'x', action: 'share' } }), null);
});

test('the TikFinity adapter drops redelivered follows and shares', () => {
  const adapter = new TikFinityAdapter({ logger: quiet });
  const kinds = [];
  const duplicates = [];
  adapter.on('event', (event) => kinds.push(event.kind));
  adapter.on('duplicate', (event) => duplicates.push(event.kind));

  adapter.injectRaw({ event: 'follow', data: { uniqueId: 'MikeTheBoss', userId: '43', createTime: 222 } });
  adapter.injectRaw({ event: 'follow', data: { uniqueId: 'MikeTheBoss', userId: '43', createTime: 222 } });
  adapter.injectRaw({ event: 'share', data: { uniqueId: 'PixelPaula', userId: '44', createTime: 333 } });
  adapter.injectRaw({ event: 'share', data: { uniqueId: 'PixelPaula', userId: '44', createTime: 333 } });
  adapter.injectRaw({ event: 'follow', data: { uniqueId: 'CoachRay', userId: '45', createTime: 444 } });

  assert.deepEqual(kinds, ['follow', 'share', 'follow']);
  assert.deepEqual(duplicates, ['follow', 'share']);
  assert.equal(adapter.status().eventsDropped, 2);
});

test('the mock adapter injects the same normalized interaction events', () => {
  const mock = new MockAdapter({ logger: quiet, rng: () => 0 });
  const seen = [];
  mock.on('event', (event) => seen.push(event));

  mock.like('ZoeZaps', 7, 140);
  mock.follow('TurboTom');
  mock.injectRaw({ event: 'share', data: { uniqueId: 'NinaStreams', userId: 'mock-NinaStreams' } });
  // The admin test hook must reach the real share pipeline too.
  mock.injectTest({ type: 'share', username: 'CoachRay' });

  assert.deepEqual(seen.map((event) => event.kind), ['like', 'follow', 'share', 'share']);
  assert.equal(seen[0].likeCount, 7);
  assert.equal(seen[0].totalLikeCount, 140);
  assert.equal(seen[1].username, 'TurboTom');
  assert.equal(seen[2].username, 'NinaStreams');
  assert.equal(seen[3].username, 'CoachRay');
});

// -------------------------------------------------------------- aggregation

test('likes are aggregated into one batch instead of one AI request per like', async () => {
  const { cohost, calls, clock, broadcasts } = setup({ replies: [reply('Thanks for the likes, chat!')] });

  for (let i = 0; i < 40; i += 1) {
    clock.value += 50;
    // One tap per event and a total below the first milestone: this batch is
    // an ordinary thank-you, not a milestone celebration.
    cohost.observeLike(likeEvent(`viewer${i % 5}`, 1, { totalLikeCount: i + 1 }));
  }
  assert.equal(calls.length, 0, 'no AI request is made while the window is open');

  const result = await cohost.flushLikes();
  assert.equal(result.batch.count, 40, 'the batch keeps the real total of likes');
  assert.equal(result.batch.uniqueUsers, 5);
  assert.equal(calls.length, 1, 'the whole window costs a single AI request');

  const fx = broadcasts.filter((entry) => entry.type === 'mascot-fx').at(-1).payload;
  assert.equal(fx.action, 'hearts');
  assert.equal(fx.target, 'both', 'both mascots react to likes');
});

test('a like milestone is celebrated once, by both mascots', async () => {
  const { cohost, calls, broadcasts, clock } = setup({ replies: [reply('One hundred likes!'), reply('Another line')] });

  cohost.observeLike(likeEvent('LunaPlays', 5, { totalLikeCount: 100 }));
  clock.value += 6000;
  const first = await cohost.flushLikes();
  assert.equal(first.milestone, 100);
  assert.equal(calls.length, 1);
  assert.match(promptOf(calls[0]), /LIKE MILESTONE: the LIVE just passed 100 total likes/);

  const fx = broadcasts.filter((entry) => entry.type === 'mascot-fx').at(-1).payload;
  assert.equal(fx.action, 'celebrate');
  assert.equal(fx.target, 'both');

  // More likes above the same milestone must not celebrate it again.
  clock.value += 30000;
  cohost.observeLike(likeEvent('MikeTheBoss', 4, { totalLikeCount: 140 }));
  const second = await cohost.flushLikes();
  assert.equal(second.milestone, null);
  assert.equal(cohost.interactions.status().milestones, 1);
  assert.deepEqual(cohost.interactions.status().celebrated, [100]);
});

test('a big jump celebrates the highest milestone and marks the rest as passed', async () => {
  const { cohost } = setup({ replies: [reply('A thousand likes!')] });
  cohost.observeLike(likeEvent('CoachRay', 10, { totalLikeCount: 1200 }));
  const result = await cohost.flushLikes();
  assert.equal(result.milestone, 1000);
  const status = cohost.interactions.status();
  assert.deepEqual(status.celebrated.sort((a, b) => a - b), [100, 500, 1000]);
});

test('the minimum milestone setting filters which milestones are celebrated', async () => {
  const { cohost, calls, clock } = setup({ settings: { aiLikeMinMilestone: 500 }, replies: [reply('Small batch thanks'), reply('Five hundred!')] });

  cohost.observeLike(likeEvent('ZoeZaps', 5, { totalLikeCount: 100 }));
  const small = await cohost.flushLikes();
  assert.equal(small.milestone, null, '100 is below the configured minimum');

  clock.value += 30000;
  cohost.observeLike(likeEvent('ZoeZaps', 5, { totalLikeCount: 500 }));
  const big = await cohost.flushLikes();
  assert.equal(big.milestone, 500);
  assert.ok(calls.length >= 1);
});

test('like reactions off means no AI call at all', async () => {
  const { cohost, calls } = setup({ settings: { aiLikeReactions: false } });
  const observed = cohost.observeLike(likeEvent('LunaPlays', 20, { totalLikeCount: 500 }));
  assert.equal(observed.accepted, false);
  const result = await cohost.flushLikes();
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('milestones off keeps the likes but never celebrates a milestone', async () => {
  const { cohost, calls, clock } = setup({ settings: { aiLikeMilestones: false }, replies: [reply('Thanks chat')] });
  cohost.observeLike(likeEvent('LunaPlays', 5, { totalLikeCount: 1000 }));
  clock.value += 6000;
  const result = await cohost.flushLikes();
  assert.equal(result.milestone, null);
  assert.equal(result.batch.totalLikes, 1000);
  assert.equal(calls.length, 1, 'a normal thank-you is still possible');
  assert.doesNotMatch(promptOf(calls[0]), /LIKE MILESTONE: the LIVE/);
  assert.match(promptOf(calls[0]), /"event":"New likes/);
});

test('a low event frequency keeps like thank-yous off the AI', async () => {
  const { cohost, calls, clock } = setup({ settings: { aiEventFrequency: 'low' }, rng: () => 0.9, replies: [reply('should not be used')] });
  cohost.observeLike(likeEvent('PixelPaula', 5, { totalLikeCount: 40 }));
  clock.value += 6000;
  const result = await cohost.flushLikes();
  assert.equal(result.spoken, false);
  assert.equal(calls.length, 0);
  assert.ok(EVENT_FREQUENCY.low < EVENT_FREQUENCY.high);
});

// ------------------------------------------------------------------- follows

test('a new follower is welcomed immediately, by real username', async () => {
  const { cohost, calls, broadcasts } = setup({ replies: [reply('Welcome in, TurboTom!', 'happy', 'zappy')] });

  const result = await cohost.observeFollow(followEvent('TurboTom'));
  assert.equal(result.accepted, true);
  assert.equal(result.username, 'TurboTom');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(promptOf(calls[0]), /TurboTom just followed the channel/);

  const fx = broadcasts.filter((entry) => entry.type === 'mascot-fx').at(-1).payload;
  assert.equal(fx.action, 'welcome');
});

test('a redelivered follow is deduplicated', async () => {
  const { cohost, calls, clock } = setup({ replies: [reply('Welcome!'), reply('Second')] });
  await cohost.observeFollow(followEvent('BigDanny'));
  clock.value += 2000;
  const again = await cohost.observeFollow(followEvent('BigDanny'));
  assert.equal(again.accepted, false);
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, 1);
});

test('follow without any user data never invents a name', async () => {
  const { cohost, calls } = setup({});
  const result = await cohost.observeFollow({ kind: 'follow', userId: '', username: '' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'no-user');
  assert.equal(calls.length, 0);
});

test('follow reactions off means no welcome line', async () => {
  const { cohost, calls, broadcasts } = setup({ settings: { aiFollowReactions: false } });
  const result = await cohost.observeFollow(followEvent('NinaStreams'));
  assert.equal(result.accepted, false);
  assert.equal(calls.length, 0);
  assert.equal(broadcasts.filter((entry) => entry.type === 'mascot-fx').length, 0);
});

test('a follow arrives while a line is speaking: it is queued, not dropped', async () => {
  const { cohost } = setup({});
  cohost.speak('A line that is already playing', { emotion: 'happy' }, 'manual', null, { priority: PRIORITY.direct });
  const result = await cohost.observeFollow(followEvent('CoachRay'));
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'busy');
  assert.equal(cohost.queue.length, 1);
  assert.equal(cohost.queue[0].trigger, 'follow');
  assert.equal(cohost.queue[0].priority, PRIORITY.follow);
});

test('a provider failure while welcoming a follower does not leave the hosts paused', async () => {
  const { cohost } = setup({ chatImpl: () => { throw new Error('HTTP 500 from provider'); } });
  const result = await cohost.observeFollow(followEvent('LunaPlays'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'error');
  assert.equal(cohost.interaction.active, false, 'the viewer interaction is released on failure');
  assert.equal(cohost.inFlight, false);
});

// -------------------------------------------------------------------- shares

test('a share is thanked by name and deduplicated per viewer', async () => {
  const { cohost, calls, clock, broadcasts } = setup({ rng: () => 0, replies: [reply('Thanks for sharing, PixelPaula!')] });

  const first = await cohost.observeShare(shareEvent('PixelPaula'));
  assert.equal(first.accepted, true);
  assert.equal(first.ok, true);
  assert.match(promptOf(calls[0]), /PixelPaula shared the LIVE/);

  const fx = broadcasts.filter((entry) => entry.type === 'mascot-fx').at(-1).payload;
  assert.equal(fx.target, 'both', 'rng 0 makes the hosts celebrate together');
  assert.equal(fx.action, 'sparkles');

  clock.value += 5000;
  const again = await cohost.observeShare(shareEvent('PixelPaula'));
  assert.equal(again.accepted, false);
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, 1);
});

test('a share skipped by the cool-down does not leave the hosts paused', async () => {
  const { cohost } = setup({ replies: [reply('Welcome!'), reply('Thanks for sharing!')] });
  await cohost.observeFollow(followEvent('FirstTimer'));
  assert.equal(cohost.isSpeaking() || cohost.speaking, true, 'the welcome line is pending');

  const share = await cohost.observeShare(shareEvent('SecondViewer'));
  // Either it was queued behind the pending line, or it was refused - but it
  // must never leave an interaction open with no line coming.
  if (!share.ok && !share.queued) {
    assert.equal(cohost.interaction.active, false, 'a refused share releases the pause');
  }

  cohost.reportTts({ state: 'end', id: 1 });
  const after = await cohost.observeShare(shareEvent('ThirdViewer'));
  if (!after.ok && !after.queued) assert.equal(cohost.interaction.active, false);
});

test('share reactions off means no thank-you', async () => {
  const { cohost, calls } = setup({ settings: { aiShareReactions: false } });
  const result = await cohost.observeShare(shareEvent('ZoeZaps'));
  assert.equal(result.accepted, false);
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ priority

test('the event priority ladder matches the brief', () => {
  assert.ok(PRIORITY.direct > PRIORITY.gift, 'a comment aimed at a host outranks a gift');
  assert.ok(PRIORITY.gift > PRIORITY.follow, 'gifts outrank follows');
  assert.ok(PRIORITY.follow > PRIORITY.share, 'follows outrank shares');
  assert.ok(PRIORITY.share > PRIORITY.like, 'shares outrank like milestones');
  assert.ok(PRIORITY.like > PRIORITY.commentary, 'like milestones outrank game commentary');
  assert.ok(PRIORITY.commentary > PRIORITY.autonomous, 'commentary outranks hosts banter');
  assert.ok(PRIORITY.chat > PRIORITY.gift, 'ordinary chat is still above gifts');
});

test('a follow accepted during a viewer reply outlives the chat queue cleanup', async () => {
  const { cohost } = setup({});
  cohost.beginInteraction('Dana');
  cohost.enqueue({ trigger: 'duo', priority: PRIORITY.autonomous });
  cohost.enqueue({ trigger: 'follow', priority: PRIORITY.follow, event: 'x just followed the channel.' });
  cohost.beginInteraction('Dana');
  assert.deepEqual(cohost.queue.map((item) => item.trigger), ['follow']);
});

// -------------------------------------------------------------- like tracker

test('repeated likes without an identifier are all counted, not deduplicated', () => {
  let now = 1000;
  const tracker = new InteractionTracker({ now: () => now, windowMs: 5000 });
  for (let i = 0; i < 6; i += 1) {
    now += 100;
    tracker.addLike({ userId: 'u1', username: 'A', likeCount: 5 });
  }
  assert.equal(tracker.sessionLikes, 30, 'six real like events are six likes');
  assert.equal(tracker.counters.duplicates, 0);

  // With a message id, a redelivery is dropped.
  tracker.addLike({ userId: 'u1', username: 'A', likeCount: 5, msgId: 'm-1', createTime: now });
  tracker.addLike({ userId: 'u1', username: 'A', likeCount: 5, msgId: 'm-1', createTime: now });
  assert.equal(tracker.counters.duplicates, 1);
});

test('the tracker keeps like bookkeeping deterministic', () => {
  let now = 1000;
  const tracker = new InteractionTracker({ now: () => now, windowMs: 5000, minMilestone: 100 });

  tracker.addLike({ userId: 'u1', username: 'A', likeCount: 2, createTime: 1 });
  tracker.addLike({ userId: 'u1', username: 'A', likeCount: 2, createTime: 1 });
  assert.equal(tracker.counters.duplicates, 1, 'an identical event is dropped');
  assert.equal(tracker.pending.count, 2);

  now += 5000;
  const batch = tracker.flushLikes();
  assert.equal(batch.count, 2);
  assert.equal(batch.users[0], 'A');
  assert.equal(tracker.flushLikes(), null, 'an empty window produces no batch');

  assert.equal(tracker.takeMilestone(99), null);
  assert.equal(tracker.takeMilestone(100), 100);
  assert.equal(tracker.takeMilestone(100), null, 'a milestone is never repeated');
  assert.ok(LIKE_MILESTONES.includes(100));
  assert.deepEqual(milestonesFor(600), [1000, 5000, 10000]);
});
