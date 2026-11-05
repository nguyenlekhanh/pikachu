# Troubleshooting — PIKACHU LIVE US V1

## Server

**`npm start` exits immediately with a module error**
Run `node -v`; Node **18.17+** is required. Delete `node_modules` and run `npm install` again.

**Port 3000 already in use**
Set `PORT=3001` in `.env`, restart, and update the OBS browser source URL.

**`better-sqlite3` fails to load (native build)**
The server prints a warning and falls back to `data/pikachu.db.json`. Everything keeps working;
the admin status bar shows `JSON`. To restore SQLite, install build tools and `npm rebuild better-sqlite3`.

**Database locked / corrupt**
Stop the server, move `data/pikachu.db*` aside, start again. The leaderboard resets but settings
return to defaults.

## Overlay

**Blank page**
Check `http://localhost:3000/api/health`. If it fails, the server is not running.

**No Phaser / board missing but UI visible**
`/vendor/phaser.min.js` is served from `node_modules/phaser`. Run `npm install` — if Phaser is
missing, the overlay shows a toast and logs a console error.

**Overlay frozen after hours**
Refresh the browser source. The server is authoritative, so the board rebuilds from the last state.
Consider lowering the canvas size to 720 × 1280 for long streams.

**Too big / cropped**
The page fits 1080 × 1920 with letterboxing; set the browser source to 9:16 (1080 × 1920 or
720 × 1280).

**No mascot voice in OBS**
Expected: OBS's CEF usually has no speech voices. Open the page in Chrome/Edge and capture that
window, or disable voice in the admin panel. See docs/OBS_SETUP.md.

**Mascot covers the board**
Admin → Mascot → lower *Mascot speed*, or disable the mascot entirely; the game is unchanged.

## Gameplay

**"Those two don't connect" but they look matchable**
The path may need three turns. Paths may only turn twice, but they *can* travel outside the board.
Use `HINT` to see a legal pair.

**Board has no moves**
The server reshuffles automatically and posts "No moves left - board reshuffled!". If you see a
stuck board, hit **Restart game** in admin.

**A comment is ignored**
Common causes: per-player cooldown (2 s), identical command repeated within 4 s, coordinates outside
the board, or the command was not recognised. `ME`/`RANK`/`HELP`/`TOP` need lowercase or uppercase
but no extra words (`top please` is not a command).

**Two viewers claim the same tiles**
The first validated move wins; the second gets "tiles are already gone". This is intentional.

**Level does not advance**
The board must be fully empty. There is a short transition (~3 s) before the next level loads.

## Gifts

**Gift received but no effect**
Open the admin event log. Either no tier matches the coin value, the tier is disabled, or a gift-ID
override is disabled. Add or fix the mapping in **Gift settings**.

**Same gift triggers twice**
Dedupe covers redeliveries, but two separate streak completions are two separate gifts. Check the
log entries (they include count and streak).

**STOP_GAME does nothing**
It is disabled by default (safety). Enable *Allow STOP_GAME gift* in Game settings. While disabled,
a tier-5 gift becomes a pair reveal and the log records it.

**Tier 5 ended the stream game by accident**
Restart from admin → Game control → **Restart game**. Consider mapping the specific gift ID to a
safer action, or raise the tier-5 minimum coins.

## TikFinity

See the dedicated table in **docs/TIKFINITY_SETUP.md → Troubleshooting**. Quick checks:

1. TikFinity Desktop running and logged in.
2. Event API enabled; endpoint `ws://127.0.0.1:21213/`.
3. Port not blocked / not used by another process.
4. Admin → TikFinity shows `connected` and a growing event count.
5. If nothing works, keep playing in mock mode — the game never depends on TikTok being up.

## Admin

**Locked out / token rejected**
The token is `ADMIN_TOKEN` in `.env`. Restart the server after changing it. Use **Lock dashboard** to
clear the tab's stored token.

**Settings do not stick**
Settings are stored in the database on save. If the store fell back to memory-only (no DB file
permissions), they reset on restart — check the storage driver in the status bar.
