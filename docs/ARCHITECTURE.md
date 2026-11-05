# Architecture — PIKACHU LIVE US V1

```
TikFinity Desktop ──ws://127.0.0.1:21213──▶ TikFinityAdapter ─┐
                                                              ├─▶ normalize ─▶ GameEngine (authoritative)
MockAdapter (admin test / simulator) ─────────────────────────┘        │
                                                                       │ events
                                    ┌──────────────────────────────────┴─────────────┐
                                    ▼                                                ▼
                            SQLite/JSON store                          WebSocket hub (/ws)
                          (players, config, logs)                    │         │          │
                                                        overlay page ◀         ▶ admin dashboard
```

## 1. Layers

| Layer | Path | Responsibilities |
|---|---|---|
| Game core | `server/game-engine/` | board generation, two-turn path search, levels, moves, scoring, combos, auto play, gifts |
| Integration | `server/tiktok/` | TikFinity Event API client (reconnect/backoff), payload normalizer, mock adapter |
| Gift mapping | `server/gift-handler/` | gift ID → action, coin tiers, dedupe keys, notification copy |
| Players / persistence | `server/database/` | SQLite (migrations), JSON fallback, in-memory store for tests |
| Transport | `server/websocket/hub.js`, `server/api/routes.js` | broadcast fan-out, REST for bootstrap + admin |
| Overlay | `client/game/` | Phaser board rendering, DOM UI, mascot, voice |
| Admin | `client/admin/` | control panel (vanilla ES modules) |

## 2. Authority and atomicity

The frontend is a pure view. It cannot score a point or declare a gift received.

`GameEngine.performMove()` runs entirely synchronously: validate status → validate coordinates →
check both tiles exist → check types → `findPath()` → remove tiles → score → emit. Because Node is
single-threaded and there is no `await` inside that path, two comments delivered in the same tick
can never both remove the same pair. The second one sees empty cells and is rejected.

`handleGift()` works the same way: dedupe check, streak handling, then a synchronous board mutation.

## 3. Matching rules

The grid is `(rows + 2) × (cols + 2)` with an always-empty padding ring, which is what allows paths
to travel around the outside of the board. `findPath()` enumerates exactly the shapes a ≤ 2-turn
connection can take:

- 0 turns: same row/column with a clear line.
- 1 turn: an elbow at `(a.row, b.col)` or `(b.row, a.col)`.
- 2 turns: a middle column or middle row crossed vertically or horizontally, with both corners free.

Any returned polyline is asserted to have at most two turns. Paths never pass through tiles.

## 4. Board upkeep

- `generateBoard()` retries until the fresh layout already contains a legal move.
- Every mutation runs `afterBoardChange()`: board empty → level complete; no legal move → reshuffle.
- `shuffleRemaining()` keeps the exact multiset and count of remaining tiles and retries until a
  move exists (with a guaranteed-pair fallback that is effectively unreachable).
- Gift tier 3 clears pairs down to half the remaining tiles using the same validated move logic.

## 5. Scoring

| Event | Points |
|---|---|
| Match | 10 + combo bonus (`min(combo-1, 8) × 2`) |
| 5th consecutive match | extra +25 |
| Level clear (finisher) | +50 |

Combo state is runtime-only and resets on an invalid attempt. Scores persist per player identity:
`id:<tiktok numeric user id>` when available, otherwise `name:<uniqueId lowercase>`.

## 6. Event flow to the overlay

`engine.on(...)` → `hub.broadcast(type, payload)`:

| Type | Payload |
|---|---|
| `state` | full snapshot: level, padded grid, remaining, status, rev |
| `fx` | one effect: `match`, `attempt`, `hint`, `reveal`, `clearHalf`, `clearAll`, `shuffle`, `levelComplete`, `newLevel`, `gameover` |
| `mascot` | `{ emotion, text, priority }` |
| `feed` | one activity line |
| `notice` | direct reply to a command (score, rank, errors) |
| `leaderboard` | top / gifters / active lists |
| `tiktok` | connection status |
| `overlay` | `help` / `leaderboard` overlay request |

The client reconciles snapshots rather than replaying the game: it diffs tiles by cell, plays match
animations, and skips removals already animated by an `fx` message. A shuffle or new level triggers a
full staggered rebuild.

## 7. Dedupe and spam control

| Layer | Mechanism |
|---|---|
| TikFinity adapter | per-event key with a 5 minute TTL (chat message id, gift streak/count) |
| Engine commands | identical command from the same player within 4 s ignored |
| Engine cooldown | 2 s per player for board commands, 1 s for info commands (configurable) |
| Gifts | `user + giftId + streakId + repeatCount + eventId` with a 15 minute TTL |

Rejected commands (paused, game over, level transition) are deliberately **not** remembered, so a
player's honest retry after a pause still works.

## 8. Auto play

`tick()` runs once per second on the server:

```
t ≥ 15 s idle  → mascot prompt
t ≥ 30 s idle  → mascot explains the command format
t ≥ 60 s idle  → auto play on, one legal pair every ~1.8 s
```

Any accepted human command clears `autoPlay` immediately. Auto play never awards player points and
never runs while a human move is being processed (same synchronous engine).

## 9. Persistence and recovery

SQLite (`data/pikachu.db`), WAL mode, migrations via `PRAGMA user_version`:

- `players` — score, matches, attempts, gift coins/count, timestamps
- `config` — the whole game settings blob (survives restarts, including gift mappings)
- `event_log` — capped rolling log
- `gifts` — gift metadata observed from TikTok (feeds the admin "gifts seen" table)

On start the engine loads persisted settings, builds level 1 and starts running. Scores and the
leaderboard survive a server restart; the board itself is per-session.

## 10. Failure behaviour

| Failure | Behaviour |
|---|---|
| TikFinity offline | adapter reconnects with backoff; overlay shows `MOCK MODE`; game keeps running |
| SQLite cannot load | JSON file fallback (same store interface), then memory-only; driver shown in admin |
| WebSocket client lost | overlay retries and re-fetches `/api/state` every 20 s until reconnected |
| Game over | board frozen, leaderboard preserved, admin restart required |
| Malformed TikTok payload | dropped, counted as `eventsDropped`, never throws |

## 11. Deliberate V1 limits

- No boss battles / boss events / missions.
- 4×4 up to 10×10 boards, 15 tile types.
- One shared board, one game instance per server. Multiple simultaneous rooms are out of scope.
- Voice uses browser speech synthesis, with a documented seam for a hosted TTS provider.
