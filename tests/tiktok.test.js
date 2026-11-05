import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatDedupeKey, normalizeEvent } from '../server/tiktok/normalize.js';
import { MockAdapter } from '../server/tiktok/mock.js';

test('chat events are normalized from the TikFinity envelope', () => {
  const event = normalizeEvent({
    event: 'chat',
    data: {
      comment: 'A1 B1',
      userId: '12345',
      uniqueId: 'luna',
      nickname: 'Luna Plays',
      msgId: 'm1',
      createTime: 99,
    },
  });
  assert.equal(event.kind, 'chat');
  assert.equal(event.text, 'A1 B1');
  assert.equal(event.userId, '12345');
  assert.equal(event.username, 'luna');
  assert.equal(event.displayName, 'Luna Plays');
});

test('chat events without text are rejected', () => {
  assert.equal(normalizeEvent({ event: 'chat', data: { userId: '1' } }), null);
  assert.equal(normalizeEvent({ event: 'chat', data: { comment: '   ' } }), null);
});

test('gift events keep the ID, streak fields and coin metadata', () => {
  const event = normalizeEvent({
    event: 'gift',
    data: {
      giftId: 5655,
      giftName: 'Rose',
      diamondCount: 1,
      repeatCount: 4,
      repeatEnd: false,
      userId: '777',
      uniqueId: 'bigdanny',
      nickname: 'Big Danny',
      msgId: 'g1',
      createTime: 1234,
    },
  });
  assert.equal(event.kind, 'gift');
  assert.equal(event.giftId, '5655');
  assert.equal(event.giftName, 'Rose');
  assert.equal(event.diamondCount, 1);
  assert.equal(event.repeatCount, 4);
  assert.equal(event.repeatEnd, false);
  assert.equal(event.username, 'bigdanny');
});

test('gift payloads without a gift id are rejected', () => {
  assert.equal(normalizeEvent({ event: 'gift', data: { giftName: 'Rose' } }), null);
});

test('other TikTok events map to their internal kinds', () => {
  assert.equal(normalizeEvent({ event: 'follow', data: { uniqueId: 'x' } }).kind, 'follow');
  assert.equal(normalizeEvent({ event: 'like', data: { uniqueId: 'x', likeCount: 5 } }).kind, 'like');
  assert.equal(normalizeEvent({ event: 'share', data: { uniqueId: 'x' } }).kind, 'share');
  assert.equal(normalizeEvent({ event: 'subscribe', data: { uniqueId: 'x', subMonth: 2 } }).kind, 'subscribe');
  const viewers = normalizeEvent({ event: 'roomUser', data: { viewerCount: 120 } });
  assert.equal(viewers.kind, 'viewers');
  assert.equal(viewers.viewerCount, 120);
});

test('unknown events are preserved as unknown instead of throwing', () => {
  const event = normalizeEvent({ event: 'somethingNew', data: {} });
  assert.equal(event.kind, 'unknown');
  assert.equal(normalizeEvent({ data: {} }), null);
  assert.equal(normalizeEvent(null), null);
});

test('the envelope also accepts a type field and nested user objects', () => {
  const event = normalizeEvent({
    type: 'chat',
    data: { comment: 'TOP', user: { userId: '55', uniqueId: 'nina', nickname: 'Nina' } },
  });
  assert.equal(event.kind, 'chat');
  assert.equal(event.userId, '55');
  assert.equal(event.username, 'nina');
});

test('chat dedupe keys are stable for the same message', () => {
  const event = normalizeEvent({ event: 'chat', data: { comment: 'A1 B1', uniqueId: 'u', msgId: '1' } });
  assert.equal(chatDedupeKey(event), chatDedupeKey(event));
  assert.notEqual(chatDedupeKey(event), chatDedupeKey({ ...event, text: 'A2 B2' }));
});

test('the mock adapter emits the same normalized contract', () => {
  const mock = new MockAdapter({ rng: () => 0.5 });
  const events = [];
  mock.on('event', (event) => events.push(event));
  mock.comment('Tester', 'A1 B1');
  mock.gift('Tester', { giftId: 'mock-rose', giftName: 'Rose', diamondCount: 1 });
  mock.follow('Tester');
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'chat');
  assert.equal(events[0].text, 'A1 B1');
  assert.equal(events[1].kind, 'gift');
  assert.equal(events[1].giftId, 'mock-rose');
  assert.equal(events[2].kind, 'follow');
});
