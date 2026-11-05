# PIKACHU LIVE US — V1

An interactive Pikachu-style tile matching game for **TikTok LIVE (US)**, built to run continuously
inside a vertical **9:16 OBS Browser Source**. Viewers play on one shared board by commenting
tile coordinates; gifts trigger game effects; a flying mascot keeps the stream alive; auto play
takes over when chat goes quiet.

- **Language:** all public game text, mascot dialogue and notifications are American English.
- **Authoritative backend:** the browser never awards points or decides whether a gift happened.
- **TikTok source:** **TikFinity only** (Event API). No direct TikTok connection, no TikTokLive Connector.
- **Mock mode:** the game is fully playable and testable with zero TikTok connection.

---

## 1. Requirements

| Requirement | Notes |
|---|---|
| Node.js **18.17+** (tested on 20.x) | `node -v` |
| TikFinity Desktop (Windows) | Only needed for real LIVE events |
| OBS Studio 28+ | Browser Source 1080 × 1920 |

Dependencies install locally: Express, ws, better-sqlite3, Phaser 3, dotenv.
If the SQLite native module cannot load, the server automatically falls back to a JSON file store
and keeps running (the admin dashboard shows which driver is active).

---

## 2. Install and run

```bash
# 1. install dependencies
npm install

# 2. create your configuration
cp .env.example .env
#    then edit .env and set a real ADMIN_TOKEN
#    (TikFinity off? set TIKFINITY_ENABLED=false — the game still runs)

# 3. start the game server (overlay + admin + websocket + API on one port)
npm start

# development mode with automatic restart on file changes
npm run dev
```

Open:

| Page | URL | Purpose |
|---|---|---|
| Overlay (OBS) | `http://localhost:3000/` | the game / stream layout |
| Admin dashboard | `http://localhost:3000/admin` | controls, settings, gifts, logs |
| Health check | `http://localhost:3000/api/health` | quick status JSON |

There is no separate frontend build step. The server serves the overlay, the admin page and
Phaser directly from the repo, so a restart is all a long stream ever needs.

---

## 3. Connect TikTok LIVE (TikFinity)

Short version — the full walkthrough lives in **[docs/TIKFINITY_SETUP.md](docs/TIKFINITY_SETUP.md)**.

1. Install and open **TikFinity Desktop** on the same PC, log in, connect your TikTok account.
2. Enable its **Event API** (local WebSocket, documented default `ws://localhost:21213/`).
3. Start this server. The adapter connects automatically (`TIKFINITY_ENABLED=true`).
4. The overlay chip turns green — **TIKFINITY LIVE** — only after the socket is actually open.
5. If TikFinity is closed, the game keeps running and the chip shows **MOCK MODE**.

The admin dashboard → **TikFinity** tab shows connection state, last event, event counters,
errors, a mock simulator, and test comment/gift buttons.

---

## 4. Add the game to OBS

Full guide: **[docs/OBS_SETUP.md](docs/OBS_SETUP.md)**.

1. OBS → **Sources → + → Browser**.
2. URL: `http://localhost:3000/`
3. Width **1080**, Height **1920**.
4. Check **Shutdown source when not visible = off**, and **Refresh browser when scene becomes active = off**
   (the game must keep running while you are on another scene).
5. Want a transparent stream background? Use `http://localhost:3000/?bg=transparent`
   (or `?bg=chroma` for green screen). Default is the designed dark gradient.

Mascot voice uses the browser Web Speech API. The OBS browser source usually has **no installed
voices**, so for audio run the same URL in Chrome/Edge and capture that window — details in the
OBS guide. Everything else works identically inside OBS.

---

## 5. How viewers play

Comment **two tile coordinates**: columns are letters, rows are numbers, top-left is `A1`.

The board shows **coordinate headers** on stream: `A, B, C…` above the columns and `1, 2, 3…`
left of the rows. They are generated from the live board size, so a 6×6, 6×8, 8×8 or 10×10
board always labels exactly the tiles the server parses.

Above the board, a **gift legend** shows the real gift icons from `assets/gift_icon/` with the action
each configured tier triggers and its coin range. It is built from Admin → Gift settings, so
disabling a tier or changing its range updates the legend on the next state push.

| Command | Meaning |
|---|---|
| `A1 B1` | match the tiles at A1 and B1 |
| `A1B1`, `a1,b1`, `A1 - B1` | accepted variations |
| `TOP` | show the leaderboard |
| `ME` | your score |
| `RANK` | your current rank |
| `HINT` | reveal one available pair |
| `JOIN` | join the leaderboard |
| `HELP` | instructions |

Rules: identical tiles only, connection path with at most **two turns**, paths may go around the
outside of the board. Matched tiles disappear. The board automatically reshuffles when no legal
move remains, and the level advances when the board is empty.

Scoring: **+10** per match, **+2 per combo step** (capped), **+25 bonus at a 5-match streak**,
**+50** for clearing the level.

Anti-spam: default **2 s per-player cooldown**, identical commands deduplicated, invalid
coordinates rejected, and a move is validated atomically on the server (two players can never
claim the same tiles).

---

## 6. Gifts

Mapping is by **gift ID** first, then by the **coin value** of the completed streak. Nothing is
hardcoded to a real TikTok gift ID, and every mapping is editable in **Admin → Gift settings**.

| Tier | Default coins | Action | Notification |
|---|---|---|---|
| 1 | 1 | `HINT` | "Here's a little hint!" |
| 2 | 2–49 | `REVEAL_PAIR` | "Thanks for the gift! Here's a matching pair!" |
| 3 | 50–299 | `CLEAR_HALF_BOARD` | "WOW! Half the board is cleared!" |
| 4 | 300–999 | `COMPLETE_LEVEL` | "AMAZING! Level completed!" |
| 5 | 1000+ | `STOP_GAME` | "OH NO! GAME OVER!" |

- Gift streaks are handled: streak parts are acknowledged, only the **completed** streak acts, and
  duplicate deliveries are dropped by a dedupe key.
- `STOP_GAME` is **off by default** (`stopGameEnabled`). While off, a tier-5 gift downgrades to a
  pair reveal and the log records that the shutdown gift is disabled.
- Every gift action is logged and the leaderboard keeps gift supporter stats.

---

## 7. Admin dashboard

`http://localhost:3000/admin` — unlock with `ADMIN_TOKEN` from `.env` (stored in that tab's
sessionStorage only; the overlay never receives it).

- **Game control:** start, pause, resume, restart, auto play on/off, reset leaderboard, stop game.
- **Game settings:** board size mode/fixed size, difficulty, tile types, cooldown, auto-play idle
  and move intervals, animation speed.
- **Gift settings:** tier table (coins → action), per gift ID overrides, enable/disable, and a
  library of gifts actually seen from TikTok so you never guess an ID.
- **Mascot:** enable/disable mascot, voice, volume, speech frequency, flight speed.
- **TikFinity:** status, endpoint, connect/disconnect, mock simulator, test comment, test gift,
  troubleshooting.
- **Event log:** searchable recent server events (gifts, connections, settings changes, errors).

---

## 8. Auto play and the mascot

- 15 s idle → playful mascot comment; 30 s → "comment two positions to play!"; 60 s → **AUTO PLAY**
  starts and clears valid pairs (no points awarded to players).
- Any accepted human command immediately stops auto play and gives the human priority.
- The mascot ("Zappy") is an original SVG/CSS character — no third-party character art — that flies
  around the stage, hovers, bounces, changes expression (happy, excited, surprised, sad, sleepy,
  angry, laughing, celebrating) and speaks American English with randomized phrasing and a voice
  cooldown.

---

## 9. Background music

**13 royalty-free tracks ship in `assets/music/`** — playful, instrumental game/cartoon music from
Kevin MacLeod (incompetech.com), all under **CC BY 4.0**, which permits commercial livestreaming
*with credit*. The required credit block is in `assets/music/LICENSES.md`; put it in your stream
description or profile so the attribution is visible. You can add or replace tracks freely — edit
`playlist.json`, keep the license record current, and never use commercial/chart music.

- Files are validated server-side and served from `/assets/music/`; bad names are rejected and
  missing files are skipped and reported. The overlay is never pointed at a broken URL.
- **Admin → Music** controls on/off, volume (default 0.3), shuffle, shows what is playable, and
  reloads `playlist.json` without a restart. A **⏭ NEXT MUSIC** button (next to Pause/Play) stops the
  current track and starts the next one in every open overlay — sequential LOOP ALL wraps after the
  last track, shuffle picks another track. Music ducks to 35% while the mascot speaks.
- `http://localhost:3000/?music=off` mutes music for one browser source only.
- Browsers block autoplay until the page is clicked once; OBS browser sources usually do not.

Full guide: **[docs/MUSIC.md](docs/MUSIC.md)**.

---

## 10. Project layout

```
client/game/           overlay (index.html, css, Phaser scene, UI, mascot, voice, net)
client/admin/          admin dashboard (vanilla ES modules)
server/game-engine/    board, two-turn matching, levels, authoritative engine
server/tiktok/         TikFinity Event API adapter, normalizer, mock adapter
server/gift-handler/   gift tier/id resolution + dedupe
server/music/          playlist.json loading + validation
server/websocket/      client hub (state, fx, mascot, feed, notices)
server/database/       SQLite store (migrations) + JSON/memory fallbacks
server/api/            public + admin REST API with token auth
shared/                tile catalogue used by both sides
assets/music/          your tracks + playlist.json + LICENSES.md (not app code)
tests/                 node:test suite
docs/                  TikFinity, OBS, architecture, troubleshooting
scripts/demo-events.js realistic mock event driver
```

Details: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## 11. Tests and demo

```bash
npm test        # 105 automated tests (matching, board, coordinates, engine, gifts, music queue/transport, TikFinity parsing)
npm run smoke   # 16 end-to-end checks against the running server (HTTP, auth, WS, move, score, gift, music)
npm run demo    # pushes a realistic comment + gift sequence into the running server
```

The demo script reads `ADMIN_TOKEN` from `.env` and needs the server running (`npm start`).

---

## 12. API quick reference

Public (used by the overlay):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | health + driver + connection summary |
| GET | `/api/state` | full game snapshot, public settings, leaderboard |
| GET | `/api/leaderboard` | leaderboards |
| GET | `/api/music` | validated background music playlist + skipped entries |
| POST | `/api/operator/move` | optional operator move `{ "a": "A1", "b": "B1" }` |
| WS | `/ws` | `state`, `fx`, `mascot`, `feed`, `notice`, `leaderboard`, `tiktok`, `overlay`, `music` (next-track commands) |

Admin (require `x-admin-token`):

`POST /api/admin/auth`, `GET /api/admin/overview`, `POST /api/admin/game`,
`POST /api/admin/settings`, `POST /api/admin/music`, `POST /api/admin/tiktok`,
`POST /api/admin/test`, `GET /api/admin/logs`.

---

## 13. V1 scope

Included: game, shared multiplayer board, scoring/leaderboard (top players, top gifters, most
active), gifts, mascot + voice, background music, auto play, TikFinity integration, admin dashboard,
OBS support, tests, docs.

Explicitly **not** included: boss battles, boss events/missions, and any V2 feature.

If something misbehaves during a stream, see **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**.
