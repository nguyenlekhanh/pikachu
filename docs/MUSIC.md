# Background music

The overlay can play a looping music bed for the stream. **13 licensed tracks are installed** in
`assets/music/` (Kevin MacLeod / incompetech.com, CC BY 4.0) and play in fixed order, looping back
to the first track after the last one. You can replace them with your own music at any time.

> **Attribution is required for these tracks.** Put the credit block from `assets/music/LICENSES.md`
in your stream description or profile. CC BY 4.0 allows commercial livestreaming, but only with
visible credit.

```
assets/music/
├── playlist.json     the track list (shipped, already references track01-04)
├── LICENSES.md       proof you may broadcast each track (shipped as a template)
├── track01.mp3
├── track02.mp3
├── track03.mp3
└── track04.mp3
```

The files are served at `/assets/music/<file>` and validated on the server. Only a plain audio file
name is accepted — no folders, no `..`, no non-audio extensions — and files that do not exist are
**skipped and reported**, never played as a broken URL.

---

## 1. Add music

1. Copy your tracks into `assets/music/`.
2. Edit `assets/music/playlist.json` so each entry points at a real file.
3. Open **Admin → Music → Reload playlist** (no server restart needed).
4. Check the track count and the "skipped" list. Everything that made it into the table is playable.

The shipped `playlist.json` already lists `track01.mp3` … `track04.mp3`. If those files are not
there yet, the admin page lists all four as *missing-file* and the overlay simply stays silent.

---

## 2. `playlist.json` format

```json
{
  "name": "Pikachu Live - Stream Music",
  "shuffle": true,
  "volume": 0.3,
  "fadeMs": 1200,
  "tracks": [
    {
      "file": "track01.mp3",
      "title": "Warm Up",
      "artist": "Your Artist",
      "license": "CC BY 4.0",
      "volume": 1
    }
  ]
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | `Stream music` | Label shown in the admin dashboard. |
| `shuffle` | boolean | `true` | Random order instead of file order. |
| `volume` | 0–1 | `0.3` | Playlist master volume; the admin volume setting overrides it. |
| `fadeMs` | number | `1200` | Fade in/out time per track, 0–5000 ms. |
| `tracks[].file` | string | — | Audio file name inside `assets/music/`. Required. |
| `tracks[].title` | string | file name | Shown in the admin table. |
| `tracks[].artist` | string | empty | Shown in the admin table. |
| `tracks[].license` | string | empty | Free-text reminder, shown in the admin table. |
| `tracks[].volume` | 0–1 | `1` | Per-track trim, multiplied by the master volume. |

Supported extensions: `mp3`, `m4a`, `ogg`, `oga`, `wav`, `flac`, `opus`, `webm`. Up to 100 tracks.
A plain string entry (`"track05.mp3"`) is accepted as shorthand.

The admin token, game state and playlist all stay on your machine; the overlay only ever fetches
`/api/music` from the same server.

---

## 3. How it plays

- One track at a time, next track queued automatically; a corrupt or deleted file is skipped and the
  player moves on instead of stopping.
- Volume fades in when a track starts and out on pause, so cuts are not audible.
- While the mascot speaks, the music **ducks to 35%** and returns about a second after the speech
  bubble disappears — the voice stays intelligible without a full mute.
- Music is independent of game state: it keeps playing when the game is paused, game over, or
  waiting for a level to load.
- Reloading the playlist from admin hot-swaps it in the open overlay (the server broadcasts the new
  list over the WebSocket).
- **NEXT MUSIC** is a server-side command: the admin asks the server for the next track, the server
  numbers the command and broadcasts one `music` frame, and every overlay cuts its current track and
  starts the same one. Volume, per-track trim and mascot ducking are preserved, and a track that is
  already playing is never restarted. Repeated clicks are throttled (one change per 350 ms) and the
  button is disabled while a skip is in flight, so two tracks can never overlap.
- Each overlay reports the track it actually started back to the server (`music-current`), which is
  what the admin panel shows as **Now playing** and what NEXT skips forward from.
- With **no playable tracks** the button reports a clear message in the panel instead of failing
  silently; with a single playable track it says there is nothing else to skip to.

---

## 4. Controls

| Where | Control | Effect |
|---|---|---|
| Admin → Music | Music enabled | Master on/off for every overlay. |
| Admin → Music | Music volume (0–1) | Master volume (default `0.3`). |
| Admin → Music | Shuffle playlist | Random vs. file order. |
| Admin → Music | ⏭ NEXT MUSIC | Stops the current track and starts the next one in **every** open overlay. File order (LOOP ALL) wraps after the last track; shuffle picks another random track. The admin panel shows the new track immediately. |
| Admin → Music | ⏸ Pause / ▶ Play | Pauses or resumes the bed on every overlay immediately (same setting as *Music enabled*). |
| Admin → Music | Reload playlist | Re-reads `playlist.json` without a restart. |
| URL | `?music=off` | Mutes music for that page only (e.g. a second OBS source). |
| `.env` | `MUSIC_ENABLED=false` | Disables the feature server-side. |
| `.env` | `MUSIC_DIR=assets/music` | Point at a different folder. |

The settings persist in the database with the rest of the game settings, so a stream restart keeps
your volume.

---

## 5. Volume for a live stream

Suggested starting point, then adjust by ear on the real stream:

| Situation | Master volume |
|---|---|
| Mascot voice enabled, chat busy | `0.2` – `0.3` |
| Mascot voice disabled | `0.35` – `0.5` |
| Music-only break scene | `0.5` – `0.6` |

Music should sit clearly **below** the mascot voice. If viewers say the voice is hard to hear,
lower the music first — the ducking already drops it to 35% while Zappy talks.

---

## 6. Licensing — read this before going live

The player cannot tell whether you are allowed to broadcast a track; that is your responsibility.
`assets/music/LICENSES.md` is a record sheet for exactly that.

- Commercial/chart music is **not** licensed for TikTok LIVE. TikTok's own music catalogue is for
  TikTok's editing tools, not for an OBS overlay.
- Use your own recordings, properly licensed royalty-free tracks, or music you have written
  permission to broadcast.
- Keep the license text or receipt. Rights holders and platforms ask for proof.
- If a track's license requires credit, display it on stream or in the description.

---

## 7. Troubleshooting

| Problem | Cause / fix |
|---|---|
| No music at all, admin shows 0 tracks | The files are not in `assets/music/`, or the names do not match `playlist.json`. Fix the names, then **Reload playlist**. |
| Admin lists tracks, overlay is silent | Autoplay was blocked. Click the overlay page once (or use OBS, which usually allows it), then check the browser console for `[music]`. |
| Music starts late | Autoplay unlock only happens after the first click/key press in Chrome/Edge. That is browser policy, not a bug. |
| Need to inspect the player | In the overlay's browser console, `__music` exposes the live player: `__music.blocked` (autoplay blocked), `__music.tracks.length`, `__music.current`, and `__music.audio.paused`. |
| Wrong track order | `shuffle` is on. Turn it off in `playlist.json` or Admin → Music. |
| Track skipped during the stream | The file could not be decoded or was removed; the player skips it and continues. Re-encode as MP3/AAC or replace the file. |
| Music too loud under the mascot | Lower Admin → Music volume; keep it at or below `0.3` when the voice is on. |
| Music still plays after disabling | Check the overlay page URL for `?music=off` (that is a per-page override), and reload the overlay after an `.env` change. |

---

## 8. Why tracks are not in the repository

Audio files are large and almost always licensed to someone. Keeping them out of the code means
the project stays portable and you never accidentally publish music you only had a personal
download for. `LICENSES.md` and `playlist.json` are the two files worth committing alongside your
tracks.
