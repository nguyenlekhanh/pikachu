/**
 * Admin dashboard controller. Plain ES module, no framework.
 * The admin token lives in sessionStorage for this tab only and is sent as a
 * header on every admin request. It is never embedded in the overlay page.
 */

const ACTIONS = ['HINT', 'REVEAL_PAIR', 'CLEAR_HALF_BOARD', 'COMPLETE_LEVEL', 'STOP_GAME'];

const state = {
  token: sessionStorage.getItem('pk-admin-token') || '',
  overview: null,
  giftDraft: null,
  dirty: { settings: false, mascot: false, music: false, gifts: false },
  pollTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '—');

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': state.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    lock();
    throw new Error('Session expired');
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// -------------------------------------------------------------------- auth

function unlock() {
  $('#loginGate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  refresh();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, 3000);
}

function lock() {
  sessionStorage.removeItem('pk-admin-token');
  state.token = '';
  clearInterval(state.pollTimer);
  $('#app').classList.add('hidden');
  $('#loginGate').classList.remove('hidden');
}

async function submitLogin() {
  const token = $('#tokenInput').value.trim();
  if (!token) {
    $('#loginError').textContent = 'Enter the admin token first.';
    return;
  }
  try {
    const response = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw new Error('Invalid admin token');
    state.token = token;
    sessionStorage.setItem('pk-admin-token', token);
    $('#loginError').textContent = '';
    unlock();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
}

$('#loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  submitLogin();
});

// Explicit click handler as well: some embedded browsers do not dispatch a form
// submit for a button press, so the dashboard must not depend on it.
$('#loginForm button[type="submit"]').addEventListener('click', (event) => {
  event.preventDefault();
  submitLogin();
});

$('#logout').addEventListener('click', lock);

// -------------------------------------------------------------------- tabs

$$('.nav').forEach((button) => {
  button.addEventListener('click', () => {
    $$('.nav').forEach((nav) => nav.classList.remove('active'));
    $$('.tab-panel').forEach((panel) => panel.classList.remove('active'));
    button.classList.add('active');
    $(`[data-panel="${button.dataset.tab}"]`).classList.add('active');
    if (button.dataset.tab === 'logs') renderLogs();
  });
});

// ------------------------------------------------------------------ refresh

async function refresh() {
  if (!state.token) return;
  try {
    state.overview = await api('/api/admin/overview');
  } catch (error) {
    console.warn(error.message);
    return;
  }
  render();
}

function render() {
  const data = state.overview;
  if (!data) return;
  renderStatus(data);
  renderGame(data);
  renderSession(data);
  if (!state.giftDraft) state.giftDraft = buildGiftDraft(data.settings);
  if (!state.dirty.settings) fillForm('#settingsForm', data.settings);
  if (!state.dirty.mascot) fillForm('#mascotForm', data.settings);
  if (!state.dirty.music) fillForm('#musicForm', data.settings);
  if (!state.dirty.gifts) renderGifts();
  renderMusic(data);
  renderTikTok(data);
  renderLogs();
}

function renderStatus(data) {
  const tf = data.tiktok.tikfinity;
  const bars = [
    {
      label: 'Game',
      value: data.game.status.toUpperCase(),
      cls: data.game.status === 'running' ? 'ok' : data.game.status === 'gameover' ? 'bad' : 'warn',
    },
    {
      label: 'TikFinity',
      value: tf.connected ? 'CONNECTED' : tf.state.toUpperCase(),
      cls: tf.connected ? 'ok' : 'bad',
    },
    { label: 'Storage', value: String(data.stats.database).toUpperCase(), cls: 'ok' },
    { label: 'Overlay clients', value: String(data.stats.clients), cls: 'ok' },
    { label: 'Players', value: String(data.stats.players), cls: 'ok' },
    { label: 'Uptime', value: `${Math.floor(data.stats.uptime / 60)}m`, cls: 'ok' },
  ];
  if (data.warnings.defaultAdminToken) {
    bars.push({ label: 'Security', value: 'DEFAULT TOKEN — CHANGE IT', cls: 'bad' });
  }
  $('#statusbar').innerHTML = bars
    .map(
      (bar) =>
        `<span class="pill ${bar.cls}"><span class="dot"></span>${escapeHtml(bar.label)}: <b>${escapeHtml(bar.value)}</b></span>`
    )
    .join('');
}

function renderGame(data) {
  const game = data.game;
  const rows = [
    ['Status', game.status],
    ['Level', game.level],
    ['Board', `${game.cols} x ${game.rows}`],
    ['Remaining tiles', game.remaining],
    ['Matches this level', game.levelMatches],
    ['Total matches', game.totalMatches],
    ['Auto play', game.autoPlay ? 'ACTIVE' : game.autoPlayEnabled ? 'idle' : 'disabled'],
    ['Level transition', game.levelTransition ? 'yes' : 'no'],
    ['Game over reason', game.gameOverReason || '—'],
  ];
  $('#gameState').innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');

  const top = data.leaderboard.top.slice(0, 5);
  $('#leaderboard').innerHTML = top.length
    ? top
        .map(
          (player, index) =>
            `<div class="row-item${index === 0 ? ' leader' : ''}"><span>${index + 1}</span><span>${escapeHtml(
              player.username
            )}</span><b>${player.score}</b></div>`
        )
        .join('')
    : '<div class="empty">No scores yet.</div>';
}

function renderSession(data) {
  const game = data.game || {};
  const rows = [
    ['Session ID', game.sessionId || '—'],
    ['Session started', game.sessionStartedAt ? new Date(game.sessionStartedAt).toLocaleString() : '—'],
    ['Level', String(game.level ?? '—')],
    ['Tiles remaining', String(game.remaining ?? '—')],
  ];
  const target = $('#sessionInfo');
  if (!target) return;
  target.innerHTML = rows
    .map(([label, value]) => `<div class="cell"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`)
    .join('');
}

// -------------------------------------------------------------------- forms

function fillForm(selector, settings) {
  const form = $(selector);
  if (!form) return;
  for (const input of form.elements) {
    if (!input.name || !(input.name in settings)) continue;
    if (input.type === 'checkbox') input.checked = Boolean(settings[input.name]);
    else input.value = settings[input.name];
  }
}

function readForm(selector) {
  const form = $(selector);
  const values = {};
  for (const input of form.elements) {
    if (!input.name) continue;
    if (input.type === 'checkbox') values[input.name] = input.checked;
    else if (input.type === 'number') values[input.name] = Number(input.value);
    else values[input.name] = input.value;
  }
  return values;
}

const FORM_DIRTY_KEY = { '#settingsForm': 'settings', '#mascotForm': 'mascot', '#musicForm': 'music' };
Object.entries(FORM_DIRTY_KEY).forEach(([selector, key]) => {
  $(selector).addEventListener('input', () => {
    state.dirty[key] = true;
  });
});

async function saveSettings(patch, noteSelector, dirtyKey) {
  const note = $(noteSelector);
  try {
    await api('/api/admin/settings', { method: 'POST', body: { settings: patch } });
    note.textContent = 'Saved.';
    note.className = 'note ok';
    state.dirty[dirtyKey] = false;
    await refresh();
  } catch (error) {
    note.textContent = error.message;
    note.className = 'note bad';
  }
  setTimeout(() => {
    note.textContent = '';
  }, 4000);
}

$('#saveSettings').addEventListener('click', () =>
  saveSettings(readForm('#settingsForm'), '#settingsNote', 'settings')
);
$('#saveMascot').addEventListener('click', () =>
  saveSettings(readForm('#mascotForm'), '#mascotNote', 'mascot')
);
$('#saveMusic').addEventListener('click', () =>
  saveSettings(readForm('#musicForm'), '#musicNote', 'music')
);

// -------------------------------------------------------------------- gifts

function buildGiftDraft(settings) {
  return {
    giftTiers: JSON.parse(JSON.stringify(settings.giftTiers || [])),
    giftRules: JSON.parse(JSON.stringify(settings.giftRules || [])),
  };
}

function renderGifts() {
  const draft = state.giftDraft;
  if (!draft) return;

  const tierBody = $('#tierTable tbody');
  tierBody.innerHTML = draft.giftTiers
    .map(
      (tier, index) => `
      <tr data-index="${index}">
        <td>${tier.tier}</td>
        <td><input data-k="label" value="${escapeHtml(tier.label || '')}" /></td>
        <td><input class="tiny" type="number" data-k="minCoins" value="${tier.minCoins ?? 1}" /></td>
        <td><input class="tiny" type="number" data-k="maxCoins" value="${tier.maxCoins ?? ''}" placeholder="∞" /></td>
        <td><select data-k="action">${ACTIONS.map(
          (action) => `<option ${action === tier.action ? 'selected' : ''}>${action}</option>`
        ).join('')}</select></td>
        <td class="check"><input type="checkbox" data-k="enabled" ${tier.enabled !== false ? 'checked' : ''} /></td>
      </tr>`
    )
    .join('');

  const ruleBody = $('#ruleTable tbody');
  ruleBody.innerHTML = draft.giftRules.length
    ? draft.giftRules
        .map(
          (rule, index) => `
      <tr data-rule="${index}">
        <td><input data-k="giftId" value="${escapeHtml(rule.giftId)}" /></td>
        <td><input data-k="name" value="${escapeHtml(rule.name || '')}" /></td>
        <td><input class="tiny" type="number" data-k="tier" value="${rule.tier ?? ''}" /></td>
        <td><select data-k="action">${ACTIONS.map(
          (action) => `<option ${action === rule.action ? 'selected' : ''}>${action}</option>`
        ).join('')}</select></td>
        <td class="check"><input type="checkbox" data-k="enabled" ${rule.enabled !== false ? 'checked' : ''} /></td>
        <td><button data-remove="${index}" class="danger">Remove</button></td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="note">No gift ID overrides yet. Tiers apply.</td></tr>';

  const libraryBody = $('#giftLibrary tbody');
  libraryBody.innerHTML = (state.overview?.gifts || []).length
    ? state.overview.gifts
        .map(
          (gift) => `
      <tr>
        <td>${escapeHtml(gift.giftId)}</td>
        <td>${escapeHtml(gift.name || '')}</td>
        <td>${gift.coins ?? '—'}</td>
        <td>${gift.count}</td>
        <td><button data-map-gift="${escapeHtml(gift.giftId)}" data-map-name="${escapeHtml(gift.name || '')}">Map</button></td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="note">No gifts seen yet. Send a test gift or wait for a live gift.</td></tr>';
}

$('#tierTable').addEventListener('input', (event) => {
  const row = event.target.closest('tr');
  const key = event.target.dataset.k;
  if (!row || !key) return;
  const tier = state.giftDraft.giftTiers[Number(row.dataset.index)];
  if (!tier) return;
  if (event.target.type === 'checkbox') tier[key] = event.target.checked;
  else if (event.target.type === 'number') tier[key] = event.target.value === '' ? null : Number(event.target.value);
  else tier[key] = event.target.value;
  state.dirty.gifts = true;
});

$('#ruleTable').addEventListener('input', (event) => {
  const row = event.target.closest('tr');
  const key = event.target.dataset.k;
  if (!row || !key) return;
  const rule = state.giftDraft.giftRules[Number(row.dataset.rule)];
  if (!rule) return;
  if (event.target.type === 'checkbox') rule[key] = event.target.checked;
  else if (event.target.type === 'number') rule[key] = event.target.value === '' ? null : Number(event.target.value);
  else rule[key] = event.target.value;
  state.dirty.gifts = true;
});

$('#ruleTable').addEventListener('click', (event) => {
  const target = event.target;
  if (target.dataset.remove !== undefined) {
    state.giftDraft.giftRules.splice(Number(target.dataset.remove), 1);
    state.dirty.gifts = true;
    renderGifts();
  }
});

$('#giftLibrary').addEventListener('click', (event) => {
  const target = event.target;
  if (!target.dataset.mapGift) return;
  $('#newGiftId').value = target.dataset.mapGift;
  $('#newGiftName').value = target.dataset.mapName || '';
  $('#newGiftId').focus();
});

$('#addGiftRule').addEventListener('click', () => {
  const giftId = $('#newGiftId').value.trim();
  if (!giftId) {
    $('#giftNote').textContent = 'Gift ID is required.';
    $('#giftNote').className = 'note bad';
    return;
  }
  if (state.giftDraft.giftRules.some((rule) => String(rule.giftId) === giftId)) {
    $('#giftNote').textContent = 'That gift ID is already mapped.';
    $('#giftNote').className = 'note bad';
    return;
  }
  state.giftDraft.giftRules.push({
    giftId,
    name: $('#newGiftName').value.trim(),
    tier: Number($('#newGiftTier').value),
    action: $('#newGiftAction').value,
    enabled: true,
  });
  state.dirty.gifts = true;
  $('#newGiftId').value = '';
  $('#newGiftName').value = '';
  $('#giftNote').textContent = 'Mapping added. Remember to save.';
  $('#giftNote').className = 'note';
  renderGifts();
});

$('#saveGifts').addEventListener('click', async () => {
  const note = $('#giftNote');
  try {
    await api('/api/admin/settings', { method: 'POST', body: { settings: state.giftDraft } });
    state.dirty.gifts = false;
    state.giftDraft = null;
    note.textContent = 'Gift configuration saved.';
    note.className = 'note ok';
    await refresh();
  } catch (error) {
    note.textContent = error.message;
    note.className = 'note bad';
  }
});

// ----------------------------------------------------------------- game ops

$$('[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.action;
    if ((action === 'reset-leaderboard' || action === 'stop') && !window.confirm(`Are you sure you want to ${action.replace('-', ' ')}?`)) return;
    try {
      await api('/api/admin/game', { method: 'POST', body: { action } });
      await refresh();
    } catch (error) {
      window.alert(error.message);
    }
  });
});

// --------------------------------------------------------------------- music

function renderMusic(data) {
  const music = data.music;
  if (!music) return;

  const cells = [
    ['Feature', music.enabled ? 'enabled' : 'disabled in .env'],
    ['Overlay setting', data.settings.musicEnabled ? 'playing' : 'muted'],
    ['Folder', 'assets/music'],
    ['Playlist file', music.present ? 'playlist.json' : 'missing'],
    ['Playable tracks', music.tracks.length],
    ['Skipped entries', music.skipped.length],
    ['Playlist changed', music.updatedAt ? new Date(music.updatedAt).toLocaleString() : '—'],
  ];
  $('#musicStatus').innerHTML = cells
    .map(([label, value]) => `<div class="cell"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`)
    .join('');

  // Transport state: what every overlay is playing right now, and the mode NEXT
  // MUSIC follows (sequential LOOP ALL or shuffle).
  const transport = data.musicTransport || null;
  const current = transport?.current || null;
  $('#musicNowPlaying').textContent = current ? current.title || current.file : '—';
  $('#musicMode').textContent = transport?.mode === 'shuffle' ? 'SHUFFLE' : 'LOOP ALL';
  const toggle = $('#musicToggle');
  if (toggle && document.activeElement !== toggle) {
    toggle.textContent = data.settings.musicEnabled ? '⏸ Pause' : '▶ Play';
  }
  const nextButton = $('#nextMusic');
  if (nextButton && !nextButton.dataset.busy) {
    nextButton.disabled = !music.tracks.length;
    nextButton.title = music.tracks.length
      ? 'Stop the current track and start the next one in every overlay'
      : 'No playable tracks in assets/music/playlist.json';
  }

  const body = $('#musicTable tbody');
  body.innerHTML = music.tracks.length
    ? music.tracks
        .map(
          (track, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(track.file)}</td>
        <td>${escapeHtml(track.title || '')}</td>
        <td>${escapeHtml(track.artist || '—')}</td>
        <td>${escapeHtml(track.license || '—')}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="note">No playable tracks. Add MP3 files to assets/music/ and list them in playlist.json.</td></tr>';

  const notes = [
    ...music.warnings,
    ...music.skipped.map((entry) => `Skipped ${entry.file}: ${entry.reason.replace('-', ' ')}`),
  ];
  $('#musicWarnings').textContent = notes.join(' · ');
  $('#musicWarnings').className = notes.length ? 'note bad' : 'note';
}

$('#reloadMusic').addEventListener('click', async () => {
  const note = $('#musicNote');
  try {
    await api('/api/admin/music', { method: 'POST', body: { action: 'reload' } });
    note.textContent = 'Playlist reloaded.';
    note.className = 'note ok';
    await refresh();
  } catch (error) {
    note.textContent = error.message;
    note.className = 'note bad';
  }
});

$('#musicToggle').addEventListener('click', async () => {
  const note = $('#musicTransportNote');
  const enabled = !state.overview?.settings?.musicEnabled;
  try {
    // The overlay applies musicEnabled from every state snapshot, so pausing
    // here pauses the bed on all connected overlays immediately.
    await api('/api/admin/settings', { method: 'POST', body: { settings: { musicEnabled: enabled } } });
    note.textContent = enabled ? 'Music resumed.' : 'Music paused.';
    note.className = 'note ok';
    await refresh();
  } catch (error) {
    note.textContent = error.message;
    note.className = 'note bad';
  }
});

// Rapid clicks are ignored while a skip is in flight and by the server throttle,
// so two tracks can never start at the same time.
$('#nextMusic').addEventListener('click', async () => {
  const button = $('#nextMusic');
  const note = $('#musicTransportNote');
  if (button.dataset.busy) return;
  button.dataset.busy = '1';
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '⏭ SKIPPING…';
  try {
    const result = await api('/api/admin/music', { method: 'POST', body: { action: 'next' } });
    if (result.track) {
      $('#musicNowPlaying').textContent = result.track.title || result.track.file;
      $('#musicMode').textContent = result.mode === 'shuffle' ? 'SHUFFLE' : 'LOOP ALL';
    }
    note.textContent = result.message || 'Next track started.';
    note.className = 'note ok';
  } catch (error) {
    note.textContent = error.message;
    note.className = 'note bad';
  } finally {
    delete button.dataset.busy;
    button.textContent = label;
    button.disabled = !state.overview?.music?.tracks?.length;
    setTimeout(() => {
      if (note.textContent && note.className.includes('ok')) note.textContent = '';
    }, 5000);
  }
});

// ------------------------------------------------------------------ tikfinity

function renderTikTok(data) {
  const tf = data.tiktok.tikfinity;
  const mockStatus = data.tiktok.mock;
  const cells = [
    ['TikFinity state', tf.state],
    ['Connected', tf.connected ? 'YES' : 'NO'],
    ['Endpoint', tf.url],
    ['Last event', tf.lastEventAt ? `${fmtTime(tf.lastEventAt)} (${tf.lastEvent?.summary || ''})` : 'none yet'],
    ['Events received', tf.eventsReceived],
    ['Dropped/duplicates', tf.eventsDropped],
    ['Last error', tf.lastError || '—'],
    ['Reconnect attempt', tf.attempt],
    ['Mock simulator', mockStatus.state],
    ['Mock events', mockStatus.eventsReceived],
  ];
  $('#tiktokStatus').innerHTML = cells
    .map(
      ([label, value]) =>
        `<div class="cell"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`
    )
    .join('');

  const urlInput = $('#tikfinityUrl');
  if (document.activeElement !== urlInput) urlInput.value = tf.url;
}

$('#connectTikfinity').addEventListener('click', () => tiktokAction({ action: 'connect' }));
$('#disconnectTikfinity').addEventListener('click', () => tiktokAction({ action: 'disconnect' }));
$('#setTikfinityUrl').addEventListener('click', () =>
  tiktokAction({ action: 'set-url', url: $('#tikfinityUrl').value.trim() })
);
$('#simulateOn').addEventListener('click', () => tiktokAction({ action: 'simulate-on' }));
$('#simulateOff').addEventListener('click', () => tiktokAction({ action: 'simulate-off' }));

async function tiktokAction(body) {
  try {
    await api('/api/admin/tiktok', { method: 'POST', body });
    await refresh();
  } catch (error) {
    window.alert(error.message);
  }
}

$('#testComment').addEventListener('click', async () => {
  const note = $('#testNote');
  try {
    await api('/api/admin/test', {
      method: 'POST',
      body: { type: 'comment', username: $('#testUser').value.trim(), text: $('#testText').value.trim() },
    });
    note.textContent = 'Test comment injected.';
    note.className = 'note ok';
    await refresh();
  } catch (error) {
    note.textContent = error.message;
    note.className = 'note bad';
  }
});

$('#testGift').addEventListener('click', async () => {
  const note = $('#testNote');
  try {
    await api('/api/admin/test', {
      method: 'POST',
      body: {
        type: 'gift',
        username: $('#testGiftUser').value.trim(),
        giftId: $('#testGiftId').value.trim(),
        giftName: $('#testGiftName').value.trim(),
        coins: Number($('#testGiftCoins').value),
      },
    });
    note.textContent = 'Test gift injected.';
    note.className = 'note ok';
    await refresh();
  } catch (error) {
    note.textContent = error.message;
    note.className = 'note bad';
  }
});

// ---------------------------------------------------------------------- logs

function renderLogs() {
  if (!state.overview) return;
  const logs = state.overview.logs || [];
  const container = $('#logTable');
  if (!container) return;
  container.innerHTML = logs
    .map(
      (log) => `
      <div class="log-line">
        <span>${new Date(log.ts).toLocaleString()}</span>
        <span class="lvl ${escapeHtml(log.level || 'info')}">${escapeHtml(log.level || 'info')}</span>
        <span class="cat">${escapeHtml(log.category || '')}</span>
        <span>${escapeHtml(log.message || '')}</span>
      </div>`
    )
    .join('') || '<div class="log-line"><span>No events yet.</span></div>';
}

$('#refreshLogs').addEventListener('click', refresh);

// --------------------------------------------------------------- live session

let resetStep = 0;
let resetBusy = false;

function openResetDialog() {
  resetStep = 1;
  $('#resetDialogTitle').textContent = 'Start a Fresh LIVE Session?';
  $('#resetDialogMessage').textContent =
    'This will permanently clear current session scores, demo events, player statistics, and game progress. Your game settings, gift mappings, music library, and TikFinity configuration will remain unchanged.';
  $('#resetDialogWarning').classList.add('hidden');
  $('#resetConfirm').textContent = 'Continue';
  $('#resetDialog').classList.remove('hidden');
  $('#resetConfirm').focus();
}

function closeResetDialog() {
  resetStep = 0;
  $('#resetDialog').classList.add('hidden');
}

$('#resetSession').addEventListener('click', openResetDialog);
$('#resetCancel').addEventListener('click', closeResetDialog);
$('#resetDialog').addEventListener('click', (event) => {
  if (event.target === $('#resetDialog')) closeResetDialog();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#resetDialog').classList.contains('hidden')) closeResetDialog();
});

$('#resetConfirm').addEventListener('click', async () => {
  // Step 1 -> 2 asks again with an explicit final warning.
  if (resetStep === 1) {
    resetStep = 2;
    $('#resetDialogTitle').textContent = 'Final confirmation';
    $('#resetDialogMessage').textContent =
      'The current LIVE session will be closed and replaced by a brand-new Level 1 board.';
    $('#resetDialogWarning').classList.remove('hidden');
    $('#resetConfirm').textContent = 'YES, RESET NOW';
    return;
  }

  if (resetBusy) return;
  const button = $('#resetConfirm');
  const note = $('#resetSessionNote');
  resetBusy = true;
  button.disabled = true;
  button.textContent = 'RESETTING…';
  try {
    const result = await api('/api/admin/game', { method: 'POST', body: { action: 'reset-session' } });
    note.textContent = `Fresh session ${result.session.id} ready at ${new Date(
      result.session.startedAt
    ).toLocaleTimeString()} — Level ${result.game.level}, ${result.game.remaining} tiles.`;
    note.className = 'note ok';
    closeResetDialog();
    await refresh();
  } catch (error) {
    note.textContent = error.message;
    note.className = 'note bad';
    closeResetDialog();
  } finally {
    resetBusy = false;
    button.disabled = false;
    button.textContent = 'YES, RESET NOW';
  }
});

// ----------------------------------------------------------------------- boot

if (state.token) {
  unlock();
} else {
  $('#loginGate').classList.remove('hidden');
}
