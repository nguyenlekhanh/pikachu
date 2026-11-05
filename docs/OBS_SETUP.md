# OBS setup — vertical 9:16 overlay

The overlay is a self-contained page designed at **1080 × 1920**. It scales itself to any viewport,
so the browser source size only needs to match your stream canvas.

---

## 1. Start the server

```bash
npm start
```

Leave it running for the whole stream. It reconnects to TikFinity automatically and the overlay
reconnects to the server automatically.

---

## 2. Add the browser source

1. In OBS: **Sources → + → Browser**.
2. **URL**

   ```
   http://localhost:3000/
   ```

3. **Width** `1080`, **Height** `1920`.
4. **Custom CSS** — leave empty.
5. Untick **Shutdown source when not visible**.
6. Untick **Refresh browser when scene becomes active** (so the game keeps running on other scenes).
7. Right-click the source → **Interact** if you ever need to click something (optional mouse play).

> Using a different canvas size (e.g. 720 × 1280)? Any size works: the stage is scaled to fit while
> keeping 9:16. Set the browser source to exactly your canvas size.

---

## 3. Background options

| URL | Result |
|---|---|
| `http://localhost:3000/` | designed dark gradient background |
| `http://localhost:3000/?bg=transparent` | transparent background, UI panels keep their own fills |
| `http://localhost:3000/?bg=chroma` | solid green screen `#00b140` for chroma key |

For `?bg=transparent`, add the source under your camera/gameplay layer. OBS Browser Sources support
alpha; keep **Allow transparency** enabled (default).

---

## 4. Mascot voice (important for OBS)

The mascot speaks through the **Web Speech API**. OBS's embedded browser (CEF) normally ships with
**no speech voices installed**, so the overlay will be silent there — the game itself is unaffected.

To get audio on stream, pick one of these:

1. **Recommended:** open `http://localhost:3000/` in **Chrome or Edge** on a second monitor, and add
   a **Window Capture** of that window (crop to the page). Audio comes from the browser and can be
   routed with OBS Audio Monitoring.
2. Keep the OBS Browser Source for the visuals with `?bg=transparent` and mute it; use the Chrome
   capture only for audio.
3. Turn voice off entirely: admin → **Mascot → Voice enabled: off** (the mascot still talks with
   speech bubbles).

Chrome may require one click on the page before speech synthesis is allowed. Clicking once on the
Chrome window at the start of a stream is enough.

Browser speech synthesis is intentionally pluggable: `client/game/js/voice.js` exposes
`speak(text, { priority })`, so a higher-quality server TTS can replace it later without touching
the mascot, game or admin.

---

## 5. Recommended OBS settings

- **Canvas:** 1080 × 1920 (vertical). If you stream to TikTok from OBS, use the same canvas.
- **FPS:** 30 or 60. The overlay animates with `requestAnimationFrame`; 30 is enough for the board.
- **Hardware acceleration** for the browser source: on (default). If the board stutters, disable it
  for this source only.
- **Audio:** background music (`assets/music/`, controlled in Admin → Music) and the mascot voice
  (see above). Both follow the browser-capture advice in section 4; OBS usually allows music
  autoplay, Chrome needs one click on the page.
- Do not add a second copy of the overlay to another scene — every copy is an extra WebSocket client
  and an extra renderer during long streams.

---

## 6. Long stream checklist

- [ ] `ADMIN_TOKEN` changed from the default.
- [ ] Admin dashboard open in a separate browser tab (not the OBS source).
- [ ] TikFinity shows `connected` and the overlay chip is green.
- [ ] Gift tier table matches your gift prices for your region.
- [ ] `STOP_GAME` enabled only if you actually want a 1000+ coin gift to end the game.
- [ ] OBS browser source set to **not** shut down when hidden.
- [ ] After a stream, the SQLite file in `data/` keeps the leaderboard for the next session.

---

## 7. Quick recovery

| Problem | Fix |
|---|---|
| Board is frozen | Right-click source → **Refresh page**. Server state is preserved. |
| Overlay is blank | Is `npm start` still running? Open `http://localhost:3000/api/health` in a browser. |
| Wrong size / letterboxed | Browser source size must match the canvas aspect (9:16). |
| Game over screen stuck | Admin → Game control → **Restart game** (or a configured restart). |
| Choppy animation | Lower canvas to 720 × 1280, or set animation speed to 1.0 in admin. |
