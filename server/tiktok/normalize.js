/**
 * Event normalisation for TikTok LIVE payloads.
 *
 * TikFinity's Event API forwards `{ event, data }` where `data` follows the
 * TikTok-Live-Connector field shape. This module accepts that shape (plus a few
 * harmless synonyms) and produces the single internal contract the game engine
 * understands. Unknown or malformed payloads are rejected instead of crashing.
 */

const str = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value));

function normalizeUser(data = {}) {
  const user = data.user || data.userInfo || {};
  const userId =
    data.userId ??
    data.user_id ??
    data.uniqueId ??
    user.userId ??
    user.user_id ??
    user.id ??
    null;
  const username =
    data.uniqueId ??
    data.unique_id ??
    data.username ??
    user.uniqueId ??
    user.unique_id ??
    user.username ??
    data.nickname ??
    '';
  const displayName = data.nickname ?? user.nickname ?? username;
  return {
    userId: userId !== null && userId !== undefined ? String(userId) : '',
    username: str(username, 'viewer'),
    displayName: str(displayName, str(username, 'viewer')),
    profilePictureUrl: data.profilePictureUrl ?? user.profilePictureUrl ?? user.avatarThumb ?? null,
  };
}

/**
 * @param {{event?:string,type?:string,data?:object,payload?:object}} message
 * @returns {object|null} normalized event, or null when unusable
 */
export function normalizeEvent(message) {
  if (!message || typeof message !== 'object') return null;

  const rawEvent = message.event ?? message.type ?? message.eventType;
  if (!rawEvent || typeof rawEvent !== 'string') return null;

  const event = rawEvent.toLowerCase();
  const data = message.data ?? message.payload ?? message;

  switch (event) {
    case 'chat':
    case 'comment': {
      const text = data.comment ?? data.message ?? data.text ?? data.content ?? '';
      if (!text || !String(text).trim()) return null;
      return {
        kind: 'chat',
        ...normalizeUser(data),
        text: String(text),
        msgId: str(data.msgId ?? data.messageId ?? data.id, ''),
        createTime: Number(data.createTime ?? data.timestamp ?? 0) || 0,
        raw: message,
      };
    }

    case 'gift': {
      const giftId = data.giftId ?? data.gift_id ?? data.gift?.id ?? null;
      if (giftId === null) return null;
      const streakId = data.giftId
        ? `${data.giftId}-${data.userId ?? data.uniqueId ?? 'anon'}`
        : '';
      return {
        kind: 'gift',
        ...normalizeUser(data),
        giftId: String(giftId),
        giftName: str(data.giftName ?? data.gift?.name ?? data.giftname, `Gift ${giftId}`),
        diamondCount: Number(data.diamondCount ?? data.coins ?? data.diamond_count ?? 0) || 0,
        repeatCount: Math.max(1, Number(data.repeatCount ?? data.repeat_count ?? data.giftCount ?? 1) || 1),
        repeatEnd: data.repeatEnd ?? data.repeat_end ?? data.streakFinished,
        giftType: data.giftType ?? null,
        streakId: str(data.streakId ?? data.groupId ?? streakId, ''),
        createTime: Number(data.createTime ?? data.timestamp ?? 0) || 0,
        eventId: str(data.msgId ?? data.eventId ?? data.messageId ?? '', ''),
        raw: message,
      };
    }

    case 'follow':
    case 'social': {
      if (data.action && String(data.action).toLowerCase() !== 'follow') return null;
      return { kind: 'follow', ...normalizeUser(data), createTime: Number(data.createTime ?? 0) || 0, raw: message };
    }

    case 'like':
      return {
        kind: 'like',
        ...normalizeUser(data),
        likeCount: Number(data.likeCount ?? data.count ?? 1) || 1,
        totalLikeCount: Number(data.totalLikeCount ?? data.total ?? 0) || 0,
        createTime: Number(data.createTime ?? 0) || 0,
        raw: message,
      };

    case 'share':
      return { kind: 'share', ...normalizeUser(data), createTime: Number(data.createTime ?? 0) || 0, raw: message };

    case 'subscribe':
      return {
        kind: 'subscribe',
        ...normalizeUser(data),
        subMonth: Number(data.subMonth ?? 0) || 0,
        createTime: Number(data.createTime ?? 0) || 0,
        raw: message,
      };

    case 'roomuser':
    case 'room_user':
    case 'viewer_count':
    case 'member':
    case 'join':
      return {
        kind: event === 'join' || event === 'member' ? 'join' : 'viewers',
        ...normalizeUser(data),
        viewerCount: Number(data.viewerCount ?? data.viewer_count ?? data.memberCount ?? 0) || 0,
        createTime: Number(data.createTime ?? 0) || 0,
        raw: message,
      };

    case 'streamend':
    case 'stream_end':
      return { kind: 'streamEnd', raw: message };

    default:
      return { kind: 'unknown', event, raw: message };
  }
}

/** Stable dedupe key for chat events (TikTok sometimes redelivers). */
export function chatDedupeKey(event) {
  const user = event.userId || event.username;
  const id = event.msgId || `${event.createTime || ''}`;
  return `chat|${user}|${id}|${(event.text || '').slice(0, 64)}`;
}
