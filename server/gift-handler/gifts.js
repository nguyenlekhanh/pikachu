/**
 * Gift tier resolution and deduplication keys.
 *
 * Mapping is by gift ID first, then falls back to the coin value tiers. Nothing
 * here hardcodes a real TikTok gift ID: the defaults are purely price bands,
 * and the admin dashboard can override any specific gift ID.
 */

export const GIFT_ACTIONS = [
  'HINT',
  'REVEAL_PAIR',
  'CLEAR_HALF_BOARD',
  'COMPLETE_LEVEL',
  'STOP_GAME',
];

export const GIFT_ACTION_LABELS = {
  HINT: 'Show a hint',
  REVEAL_PAIR: 'Reveal a matching pair',
  CLEAR_HALF_BOARD: 'Clear half the board',
  COMPLETE_LEVEL: 'Complete the level',
  STOP_GAME: 'Stop the game',
};

export const GIFT_NOTIFICATIONS = {
  HINT: "Here's a little hint!",
  REVEAL_PAIR: "Thanks for the gift! Here's a matching pair!",
  CLEAR_HALF_BOARD: 'WOW! Half the board is cleared!',
  COMPLETE_LEVEL: 'AMAZING! Level completed!',
  STOP_GAME: 'OH NO! GAME OVER!',
};

export function giftCoins(gift = {}) {
  const single = Number(gift.diamondCount ?? gift.coins ?? 0);
  const count = Math.max(1, Number(gift.repeatCount ?? gift.count ?? 1));
  const total = single * count;
  return Number.isFinite(total) ? Math.max(1, Math.round(total)) : 1;
}

export function giftDedupeKey(gift = {}) {
  const user = gift.userId ?? gift.uniqueId ?? gift.username ?? 'unknown';
  const streak = gift.streakId ?? gift.createTime ?? gift.timestamp ?? 0;
  const count = gift.repeatCount ?? gift.count ?? 1;
  const eventId = gift.eventId ?? gift.msgId ?? '';
  return `gift|${user}|${gift.giftId ?? gift.giftName ?? 'unknown'}|${streak}|${count}|${eventId}`;
}

function normalizeAction(value) {
  const upper = String(value || '').toUpperCase().replace(/[\s-]+/g, '_');
  return GIFT_ACTIONS.includes(upper) ? upper : null;
}

/**
 * Resolve which game action a gift triggers.
 * @returns {{action: string, tier: number|null, enabled: boolean, source: string, coins: number, label: string}}
 */
export function resolveGiftAction(gift = {}, settings = {}) {
  const coins = giftCoins(gift);
  const rules = Array.isArray(settings.giftRules) ? settings.giftRules : [];

  const idRule = rules.find(
    (rule) => rule && String(rule.giftId) === String(gift.giftId) && String(rule.giftId) !== 'undefined'
  );

  if (idRule) {
    if (idRule.enabled === false) {
      return {
        action: 'NONE',
        tier: idRule.tier ?? null,
        enabled: false,
        source: 'giftId',
        coins,
        label: idRule.name || gift.giftName || `Gift ${gift.giftId}`,
        reason: 'This gift effect is disabled in the admin dashboard.',
      };
    }
    const action = normalizeAction(idRule.action);
    if (action) {
      return {
        action,
        tier: idRule.tier ?? null,
        enabled: true,
        source: 'giftId',
        coins,
        label: idRule.name || gift.giftName || `Gift ${gift.giftId}`,
      };
    }
  }

  const tiers = Array.isArray(settings.giftTiers) ? settings.giftTiers : [];
  const tier = tiers.find((entry) => {
    if (!entry) return false;
    const min = Number(entry.minCoins ?? 1);
    const max = entry.maxCoins === null || entry.maxCoins === undefined ? Infinity : Number(entry.maxCoins);
    return coins >= min && coins <= max;
  });

  if (tier) {
    const action = normalizeAction(tier.action);
    if (tier.enabled === false || !action) {
      return {
        action: 'NONE',
        tier: tier.tier ?? null,
        enabled: false,
        source: 'tier',
        coins,
        label: tier.label || `Tier ${tier.tier}`,
        reason: 'This gift tier is disabled in the admin dashboard.',
      };
    }
    return {
      action,
      tier: tier.tier ?? null,
      enabled: true,
      source: 'tier',
      coins,
      label: tier.label || `Tier ${tier.tier}`,
    };
  }

  return {
    action: 'NONE',
    tier: null,
    enabled: false,
    source: 'none',
    coins,
    label: gift.giftName || `Gift ${gift.giftId ?? '?'}`,
    reason: 'No gift tier matches this coin value.',
  };
}
