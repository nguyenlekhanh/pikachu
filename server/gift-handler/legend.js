/**
 * Gift legend for the overlay.
 *
 * The legend is derived from the *configured* gift tiers (Admin -> Gift
 * settings), not from a hardcoded list, so disabling a tier or changing its coin
 * range is reflected on stream. Each action maps to one of the real gift icon
 * images in assets/gift_icon/; if a file is missing the legend still renders
 * with a neutral lightning fallback instead of a broken image.
 *
 * Nothing here changes gift behaviour: this module only describes it.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Action -> real icon file shipped in assets/gift_icon/. */
export const GIFT_ACTION_ICONS = {
  HINT: 'rose.webp',
  REVEAL_PAIR: 'embroidered5.webp',
  CLEAR_HALF_BOARD: 'flowergarland15.webp',
  COMPLETE_LEVEL: 'Bouquet20.webp',
  STOP_GAME: 'grandCeremony.webp',
};

/** Short, mobile-readable labels (STOP_GAME is the "GAME OVER" gift). */
export const GIFT_ACTION_LABELS = {
  HINT: 'HINT',
  REVEAL_PAIR: 'REVEAL PAIR',
  CLEAR_HALF_BOARD: 'CLEAR HALF BOARD',
  COMPLETE_LEVEL: 'NEXT LEVEL',
  STOP_GAME: 'GAME OVER',
};

export const FALLBACK_ICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<circle cx="32" cy="32" r="29" fill="#16234f" stroke="#ffd93d" stroke-width="3"/>' +
    '<path d="M36 11 L21 35 h9 l-4 18 16-25 h-9 z" fill="#ffd93d"/>' +
    '</svg>'
)}`;

const cache = new Map();

/** "1 coin", "2–49 coins", "1000+ coins". */
export function formatCoins(min, max) {
  const low = Number.isFinite(Number(min)) ? Number(min) : 1;
  if (max === null || max === undefined || max === '') return `${low}+ coins`;
  const high = Number(max);
  if (!Number.isFinite(high)) return `${low}+ coins`;
  if (low === high) return `${low} coin${low === 1 ? '' : 's'}`;
  return `${low}–${high} coins`;
}

/**
 * @param {{ tiers?: Array<object>, dir?: string, baseUrl?: string }} options
 * @returns {Array<{tier:number, action:string, label:string, coin:string, icon:string, fallback:boolean, iconFile:string|null}>}
 */
export function buildGiftLegend({ tiers = [], dir = '', baseUrl = '/assets/gift_icon' } = {}) {
  const enabled = (Array.isArray(tiers) ? tiers : []).filter(
    (tier) => tier && tier.enabled !== false && GIFT_ACTION_LABELS[tier.action]
  );

  const key = `${dir}|${baseUrl}|${JSON.stringify(enabled)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const items = enabled.map((tier) => {
    const iconFile = GIFT_ACTION_ICONS[tier.action] || null;
    const exists = Boolean(iconFile && dir && fs.existsSync(path.join(dir, iconFile)));
    return {
      tier: tier.tier,
      action: tier.action,
      label: GIFT_ACTION_LABELS[tier.action],
      coin: formatCoins(tier.minCoins ?? 1, tier.maxCoins ?? null),
      icon: exists ? `${baseUrl}/${encodeURIComponent(iconFile)}` : FALLBACK_ICON,
      fallback: !exists,
      iconFile,
    };
  });

  // Keep the cache tiny: settings changes produce one new key at a time.
  if (cache.size > 20) cache.clear();
  cache.set(key, items);
  return items;
}
