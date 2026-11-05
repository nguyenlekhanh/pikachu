# TikFinity setup — PIKACHU LIVE US V1

TikFinity is the **only** TikTok LIVE source for this project. The game never connects to TikTok
directly and does not implement TikTokLive Connector.

```
TikTok LIVE  →  TikFinity Desktop  →  Local WebSocket  →  Pikachu backend  →  /ws  →  overlay  →  OBS
```

---

## 1. What the integration actually uses

From TikFinity's published **Event API** documentation:

| Item | Value |
|---|---|
| Endpoint | `ws://localhost:21213/` (default; configurable in this project) |
| Message envelope | `{ "event": "<name>", "data": { ... } }` |
| Event names | `chat`, `gift`, `share`, `follow`, `like`, `roomUser`, `subscribe` |
| `data` shape | follows the TikTok-Live-Connector field documentation |

The adapter in `server/tiktok/tikfinity.js` connects to that endpoint with the `ws` library,
normalizes every payload in `server/tiktok/normalize.js`, and forwards it to the game engine.

It does **not** invent endpoints or event names. If a future TikFinity version adds events, they are
kept as `unknown` events and logged — never crashed on.

---

## 2. Install TikFinity

1. Download **TikFinity Desktop** from `https://tikfinity.zerody.one/app` (Windows).
2. Run it and complete the free TikFinity account setup.
3. Enter your TikTok `@username` and connect the account while your LIVE is running.
4. The desktop app is required — the Event API is served by the local desktop app, not the web app.

> The `21213` WebSocket endpoint is part of TikFinity's **Event API**, which is a documented
> feature of the desktop app. Depending on your TikFinity build it may be labelled
> *Event API* / *Developer / WebSocket API* in the app. If you do not see it, update TikFinity
> first — an older build has no Event API at all.

---

## 3. Start the game

```bash
npm install
cp .env.example .env     # set ADMIN_TOKEN
npm start
```

`.env` relevant keys:

```
TIKFINITY_ENABLED=true
TIKFINITY_WS_URL=ws://127.0.0.1:21213/
TIKFINITY_RECONNECT=true
MOCK_MODE=true
```

Start order does not matter: the adapter retries with backoff (2 s → 30 s) until TikFinity is
available.

---

## 4. Verify the connection

1. Open the admin dashboard: `http://localhost:3000/admin`.
2. Unlock with `ADMIN_TOKEN`.
3. Go to **TikFinity**. The connection card must read:

   - **TikFinity state:** `connected`
   - **Connected:** `YES`
   - **Last event:** a timestamp after you send something

4. The overlay chip in the top-left of the game also switches from `MOCK MODE` to
   `TIKFINITY LIVE` (green).

The server only reports `connected` after the WebSocket `open` event. It never fakes a connection:
if TikFinity is closed you will see `reconnecting` plus the actual socket error.

---

## 5. Test comments

Easiest path (no LIVE needed):

1. Admin → **TikFinity** → *Send test comment* with text `A1 B1`.
2. The comment travels through the **same** normalization + engine pipeline as a real comment.

With a real LIVE:

1. Start your TikTok LIVE.
2. Type `JOIN` in the chat from a second device or ask a viewer.
3. The overlay feed shows the join, and the log in the admin page shows the chat event.
4. Type `A1 B1` using labels from the board.

Commands accepted: `A1 B1` (and `A1B1`, `a1 b1`, `A1,B1`, `A1 - B1`), `TOP`, `ME`, `RANK`,
`JOIN`, `HELP`, `HINT`. A leading `!` is ignored, so `!top` also works.

---

## 6. Test gifts

### Without a LIVE

Admin → **TikFinity** → *Send test gift*:

| Preset coins | Expected action |
|---|---|
| 1 | hint |
| 5 | reveal pair |
| 99 | clear half the board |
| 400 | complete the level |
| 1500 | stop game (only if enabled in Game settings) |

### With a real LIVE

1. Send any 1-coin gift from your phone.
2. The admin **Gift settings → Gifts seen from TikTok** table fills in the real gift ID, name and
   coin value. Click **Map** to create an override for it.
3. Set a tier/action, **Save gift configuration**, and send the gift again to confirm.

### Streaks

TikFinity forwards gift streak updates with a repeat count and a "streak finished" flag. The engine
acknowledges intermediate streak parts and acts once when the streak completes, using
`diamondCount × repeatCount` coins for the tier. Every processed gift is deduplicated by
`user + giftId + streak + repeatCount + event id`, so a redelivery can never fire twice.

---

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| State stays `reconnecting` | Is TikFinity Desktop running and logged in? Is port 21213 free (`netstat -ano | findstr 21213`)? |
| `ECONNREFUSED` in the log | TikFinity not running, Event API disabled, or a different port — set `TIKFINITY_WS_URL` and use **Apply URL**. |
| Connected but no events | Is your TikTok account actually live and connected in TikFinity? Send a chat message from another account. |
| Events arrive but nothing happens | The comment must be a valid command. `HELP` reply text appears as an overlay toast, not in TikTok chat. |
| Gifts do nothing | Check the gift tier table (admin), whether the tier is disabled, and the event log for "No gift tier matches". |
| Wrong gift effect | Add a per-gift-ID override; ID overrides beat the coin tiers. |
| Duplicate plays | Dedupe is built in; if you see two effects for one gift, the second is a different streak count — check the log. |

Useful logs:

- Admin → **Event log** (server side, persisted in SQLite).
- Server console (`npm start`), which prints connection state changes.

### Mock mode

Mock mode is always available. It is clearly labelled in the overlay (`MOCK MODE`) and in the admin
panel (`mock` source), so it is never confused with a real connection. `MOCK_SIMULATE=true`
generates fake comments/gifts on a timer for stress testing; the admin toggle controls it live.

---

## 8. Security notes

- No credentials are needed for the Event API — it is local-only.
- The admin token is server-side (`ADMIN_TOKEN`) and is never sent to the overlay page.
- `ws://` means the TikFinity link is loopback-only; do not expose port 21213 publicly.
