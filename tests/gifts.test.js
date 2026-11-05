import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  giftCoins,
  giftDedupeKey,
  resolveGiftAction,
  GIFT_ACTIONS,
} from '../server/gift-handler/gifts.js';
import { GAME_DEFAULTS } from '../server/config.js';

const settings = { ...GAME_DEFAULTS };

test('coin totals multiply by the streak count', () => {
  assert.equal(giftCoins({ diamondCount: 1, repeatCount: 1 }), 1);
  assert.equal(giftCoins({ diamondCount: 5, repeatCount: 3 }), 15);
  assert.equal(giftCoins({ coins: 10 }), 10);
  assert.equal(giftCoins({}), 1);
});

test('tier boundaries map to the five documented actions', () => {
  const expectations = [
    [1, 'HINT', 1],
    [2, 'REVEAL_PAIR', 2],
    [49, 'REVEAL_PAIR', 2],
    [50, 'CLEAR_HALF_BOARD', 3],
    [299, 'CLEAR_HALF_BOARD', 3],
    [300, 'COMPLETE_LEVEL', 4],
    [999, 'COMPLETE_LEVEL', 4],
    [1000, 'STOP_GAME', 5],
    [50000, 'STOP_GAME', 5],
  ];
  for (const [coins, action, tier] of expectations) {
    const resolution = resolveGiftAction({ giftId: 'x', coins }, settings);
    assert.equal(resolution.action, action, `coins=${coins}`);
    assert.equal(resolution.tier, tier, `coins=${coins}`);
    assert.equal(resolution.enabled, true);
  }
});

test('a per gift ID override wins over the coin tier', () => {
  const withRule = {
    ...settings,
    giftRules: [{ giftId: '5655', name: 'Rose', actor: 'x', tier: 4, action: 'COMPLETE_LEVEL', enabled: true }],
  };
  const resolution = resolveGiftAction({ giftId: '5655', coins: 1 }, withRule);
  assert.equal(resolution.action, 'COMPLETE_LEVEL');
  assert.equal(resolution.source, 'giftId');
});

test('a disabled gift override produces no action', () => {
  const withRule = {
    ...settings,
    giftRules: [{ giftId: '5655', action: 'HINT', enabled: false }],
  };
  const resolution = resolveGiftAction({ giftId: '5655', coins: 1 }, withRule);
  assert.equal(resolution.action, 'NONE');
  assert.equal(resolution.enabled, false);
});

test('a disabled tier produces no action', () => {
  const tiers = settings.giftTiers.map((tier) => (tier.tier === 2 ? { ...tier, enabled: false } : tier));
  const resolution = resolveGiftAction({ giftId: 'other', coins: 5 }, { ...settings, giftTiers: tiers });
  assert.equal(resolution.action, 'NONE');
  assert.equal(resolution.enabled, false);
});

test('unknown coin values with no matching tier are reported safely', () => {
  const resolution = resolveGiftAction({ giftId: 'z', coins: 5 }, { ...settings, giftTiers: [] });
  assert.equal(resolution.action, 'NONE');
  assert.equal(resolution.enabled, false);
  assert.ok(resolution.reason);
});

test('every documented gift action is resolvable', () => {
  for (const action of GIFT_ACTIONS) {
    const resolution = resolveGiftAction(
      { giftId: 'abc', coins: 1 },
      { ...settings, giftRules: [{ giftId: 'abc', action, enabled: true }] }
    );
    assert.equal(resolution.action, action);
  }
});

test('dedupe keys differ per user, streak, and repeat count', () => {
  const base = { userId: 'u1', giftId: '1', streakId: 's1', repeatCount: 1, repeatEnd: true };
  assert.notEqual(giftDedupeKey(base), giftDedupeKey({ ...base, userId: 'u2' }));
  assert.notEqual(giftDedupeKey(base), giftDedupeKey({ ...base, repeatCount: 2 }));
  assert.notEqual(giftDedupeKey(base), giftDedupeKey({ ...base, streakId: 's2' }));
  assert.equal(giftDedupeKey(base), giftDedupeKey({ ...base }));
});
