import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FALLBACK_ICON,
  GIFT_ACTION_ICONS,
  GIFT_ACTION_LABELS,
  buildGiftLegend,
  formatCoins,
} from '../server/gift-handler/legend.js';
import { GAME_DEFAULTS } from '../server/config.js';

function iconDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-gift-icons-'));
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return dir;
}

test('the legend follows the configured tier order and labels', () => {
  const dir = iconDir(Object.values(GIFT_ACTION_ICONS));
  try {
    const items = buildGiftLegend({ tiers: GAME_DEFAULTS.giftTiers, dir });
    assert.deepEqual(items.map((item) => item.action), [
      'HINT',
      'REVEAL_PAIR',
      'CLEAR_HALF_BOARD',
      'COMPLETE_LEVEL',
      'STOP_GAME',
    ]);
    assert.deepEqual(items.map((item) => item.label), ['HINT', 'REVEAL PAIR', 'CLEAR HALF BOARD', 'NEXT LEVEL', 'GAME OVER']);
    assert.equal(items[0].icon, '/assets/gift_icon/rose.webp');
    assert.equal(items[4].icon, '/assets/gift_icon/grandCeremony.webp');
    assert.ok(items.every((item) => item.fallback === false));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coin labels describe the configured ranges', () => {
  assert.equal(formatCoins(1, 1), '1 coin');
  assert.equal(formatCoins(2, 49), '2–49 coins');
  assert.equal(formatCoins(300, 999), '300–999 coins');
  assert.equal(formatCoins(1000, null), '1000+ coins');

  const dir = iconDir(Object.values(GIFT_ACTION_ICONS));
  try {
    const items = buildGiftLegend({ tiers: GAME_DEFAULTS.giftTiers, dir });
    assert.deepEqual(items.map((item) => item.coin), ['1 coin', '2–49 coins', '50–299 coins', '300–999 coins', '1000+ coins']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('disabled tiers disappear from the legend', () => {
  const dir = iconDir(Object.values(GIFT_ACTION_ICONS));
  try {
    const tiers = GAME_DEFAULTS.giftTiers.map((tier) => (tier.tier === 5 ? { ...tier, enabled: false } : tier));
    const items = buildGiftLegend({ tiers, dir });
    assert.equal(items.length, 4);
    assert.ok(!items.some((item) => item.action === 'STOP_GAME'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing icon file falls back instead of rendering a broken image', () => {
  const dir = iconDir(['rose.webp']); // only tier 1 exists
  try {
    const items = buildGiftLegend({ tiers: GAME_DEFAULTS.giftTiers, dir });
    assert.equal(items[0].fallback, false);
    assert.equal(items[1].fallback, true);
    assert.equal(items[1].icon, FALLBACK_ICON);
    assert.equal(items[1].iconFile, GIFT_ACTION_ICONS.REVEAL_PAIR);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown or malformed tiers are ignored safely', () => {
  const dir = iconDir(Object.values(GIFT_ACTION_ICONS));
  try {
    const items = buildGiftLegend({
      tiers: [null, { action: 'NOT_A_GIFT' }, { action: 'HINT', minCoins: 1, maxCoins: 1, enabled: true }],
      dir,
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'HINT');
    assert.equal(items[0].action, GIFT_ACTION_LABELS.HINT ? 'HINT' : null);
    assert.deepEqual(buildGiftLegend({ tiers: [], dir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the legend reflects a changed coin range on the next build', () => {
  const dir = iconDir(Object.values(GIFT_ACTION_ICONS));
  try {
    const first = buildGiftLegend({ tiers: GAME_DEFAULTS.giftTiers, dir });
    assert.equal(first[1].coin, '2–49 coins');

    const changed = GAME_DEFAULTS.giftTiers.map((tier) =>
      tier.tier === 2 ? { ...tier, minCoins: 5, maxCoins: 20 } : tier
    );
    const second = buildGiftLegend({ tiers: changed, dir });
    assert.equal(second[1].coin, '5–20 coins');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
