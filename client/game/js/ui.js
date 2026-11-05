/**
 * DOM UI: top bar, leaderboard, event feed, toasts, overlays.
 * Keeping the text UI in HTML (instead of canvas) keeps it crisp and readable
 * on a mobile livestream.
 */

const FEED_ICONS = {
  match: '✅',
  invalid: '⚠️',
  gift: '🎁',
  'gift-effect': '✨',
  'gift-streak': '🎁',
  gift_request: '🎁',
  level: '🏁',
  challenge: '👑',
  champion: '👑',
  bonus: '🎉',
  auto: '🤖',
  system: '⚙️',
  join: '👋',
  follow: '➕',
  like: '❤️',
  subscribe: '⭐',
  share: '🔁',
  shuffle: '🔄',
  gameover: '💀',
  hint: '💡',
};

const OVERLAY_HTML = {
  help: `
    <div class="overlay" data-overlay="help">
      <div class="overlay-card">
        <h2>HOW TO PLAY</h2>
        <p>Match two identical tiles with a path of at most two turns.</p>
        <h3>COMMANDS</h3>
        <ul class="overlay-list">
          <li><span class="cmd">A1 B1</span><span class="desc">Match the tiles at A1 and B1</span></li>
          <li><span class="cmd">TOP</span><span class="desc">Show the leaderboard</span></li>
          <li><span class="cmd">ME</span><span class="desc">Your score</span></li>
          <li><span class="cmd">RANK</span><span class="desc">Your current rank</span></li>
          <li><span class="cmd">HINT</span><span class="desc">Show one available pair</span></li>
          <li><span class="cmd">JOIN</span><span class="desc">Join the leaderboard</span></li>
        </ul>
        <p class="muted-note">Ten points per match, combo bonus for a streak.</p>
      </div>
    </div>`,
};

export class UI {
  constructor() {
    this.el = {
      stage: document.getElementById('stage'),
      level: document.getElementById('statLevel'),
      remaining: document.getElementById('statRemaining'),
      matches: document.getElementById('statMatches'),
      status: document.getElementById('statStatus'),
      connChip: document.getElementById('connChip'),
      autoChip: document.getElementById('autoChip'),
      lastMove: document.getElementById('lastMove'),
      lbList: document.getElementById('leaderboardList'),
      playerCount: document.getElementById('playerCount'),
      feedList: document.getElementById('feedList'),
      toastStack: document.getElementById('toastStack'),
      overlayRoot: document.getElementById('overlayRoot'),
      boardFrame: document.getElementById('boardFrame'),
      giftLegend: document.getElementById('giftLegendItems'),
    };
    this.overlayTimer = null;
    this.lastMoveTimer = null;
    this.feed = [];
    this.toasts = [];
    this.currentLevel = null;
    this.lastStatus = null;
    this.pausedBadge = null;
  }

  // ------------------------------------------------------------- gift legend

  /**
   * Renders the gift legend from the server's configured tiers: real gift
   * images, the action each one triggers, and its coin range. The server
   * supplies a fallback icon for any missing file.
   */
  setGiftLegend(items = []) {
    const root = this.el.giftLegend;
    if (!root) return;
    root.innerHTML = '';

    const list = Array.isArray(items) ? items.slice(0, 5) : [];
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'gift-empty';
      empty.textContent = 'Gift actions appear here once they are configured.';
      root.appendChild(empty);
      return;
    }

    for (const item of list) {
      const row = document.createElement('div');
      row.className = `gift-item${item.fallback ? ' gift-fallback' : ''}`;

      const img = document.createElement('img');
      img.className = 'gift-icon';
      img.src = item.icon;
      img.alt = `${item.label} gift`;
      img.title = item.fallback ? `${item.label}: icon file missing` : item.label;
      img.loading = 'lazy';

      const text = document.createElement('div');
      text.className = 'gift-text';

      const action = document.createElement('span');
      action.className = 'gift-action';
      action.textContent = item.label || item.action || '';

      const coins = document.createElement('span');
      coins.className = 'gift-coins';
      coins.textContent = item.coin || '';

      text.append(action, coins);
      row.append(img, text);
      root.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- top bar

  setSettings(settings) {
    this.settings = settings;
    if (settings && settings.mascotEnabled !== undefined) {
      document.body.classList.toggle('mascot-off', !settings.mascotEnabled);
    }
  }

  setState(state) {
    if (!state) return;
    this.el.level.textContent = String(state.level);
    this.el.remaining.textContent = String(state.remaining);
    this.el.matches.textContent = String(state.totalMatches);

    const statusText = {
      running: 'RUNNING',
      paused: 'PAUSED',
      idle: 'WAITING',
      gameover: 'GAME OVER',
    }[state.status] || state.status.toUpperCase();
    this.el.status.textContent = statusText;
    this.el.status.style.color =
      state.status === 'gameover' ? '#ff8a8a' : state.status === 'paused' ? '#ffb347' : '';

    this.el.autoChip.classList.toggle('hidden', !state.autoPlay);
    document.body.classList.toggle('status-paused', state.status === 'paused');
    this.togglePausedBadge(state.status === 'paused');
    this.syncGameOver(state);
  }

  togglePausedBadge(paused) {
    if (paused && !this.pausedBadge) {
      const badge = document.createElement('div');
      badge.className = 'paused-badge';
      badge.textContent = 'PAUSED';
      this.el.boardFrame.appendChild(badge);
      this.pausedBadge = badge;
    } else if (!paused && this.pausedBadge) {
      this.pausedBadge.remove();
      this.pausedBadge = null;
    }
  }

  bumpStat(name) {
    const map = { remaining: this.el.remaining, matches: this.el.matches };
    const el = map[name];
    if (!el) return;
    const parent = el.closest('.stat');
    parent.classList.remove('hit');
    void parent.offsetWidth;
    parent.classList.add('hit');
  }

  setConnection(tiktok) {
    if (!tiktok) return;
    const chip = this.el.connChip;
    const labelEl = chip.querySelector('.chip-label');
    chip.classList.remove('chip-live', 'chip-offline', 'chip-mock');
    if (tiktok.connected) {
      chip.classList.add('chip-live');
      labelEl.textContent = 'LIVE';
    } else if (tiktok.mode === 'MOCK / OFFLINE' && tiktok.eventsReceived > 0) {
      chip.classList.add('chip-mock');
      labelEl.textContent = 'MOCK MODE';
    } else {
      chip.classList.add('chip-offline');
      labelEl.textContent = 'MOCK MODE';
    }
  }

  setViewers(count) {
    if (!Number.isFinite(count)) return;
    this.viewers = count;
  }

  showLastMove(text) {
    this.el.lastMove.textContent = text;
    this.el.lastMove.classList.remove('hidden');
    clearTimeout(this.lastMoveTimer);
    this.lastMoveTimer = setTimeout(() => this.el.lastMove.classList.add('hidden'), 4200);
  }

  // ------------------------------------------------------------- leaderboard

  setLeaderboard(board) {
    if (!board) return;
    const top = (board.top || []).slice(0, 5);
    this.el.playerCount.textContent = `${board.totalPlayers || 0} PLAYERS`;
    if (!top.length) {
      this.el.lbList.innerHTML = '<li class="lb-empty">No scores yet. Comment JOIN to get on the board!</li>';
      return;
    }
    const previous = this.lastLeaderId;
    this.el.lbList.innerHTML = '';
    top.forEach((player, index) => {
      const li = document.createElement('li');
      li.className = `lb-row${index === 0 ? ' leader' : ''}`;
      const medal = index === 0 ? '👑' : `${index + 1}`;
      li.innerHTML = `
        <span class="lb-rank">${medal}</span>
        <span class="lb-name"></span>
        <span class="lb-score">${player.score}</span>
        <span class="lb-matches">${player.matches} ✅</span>`;
      li.querySelector('.lb-name').textContent = player.username;
      if (player.id === previous) li.classList.add('bump');
      this.el.lbList.appendChild(li);
    });
    this.lastLeaderId = top[0]?.id;
  }

  // -------------------------------------------------------------------- feed

  addFeed(entry) {
    if (!entry) return;
    this.feed.unshift(entry);
    if (this.feed.length > 4) this.feed.pop();
    this.renderFeed();
  }

  renderFeed() {
    this.el.feedList.innerHTML = '';
    for (const entry of this.feed) {
      const li = document.createElement('li');
      li.className = `feed-item kind-${entry.kind || 'system'}`;
      const icon = document.createElement('span');
      icon.className = 'ico';
      icon.textContent = FEED_ICONS[entry.kind] || '•';
      const text = document.createElement('span');
      text.className = 'txt';
      text.textContent = entry.text || '';
      li.append(icon, text);
      this.el.feedList.appendChild(li);
    }
  }

  // ------------------------------------------------------------------ toasts

  showNotice(notice) {
    if (!notice || !notice.text) return;
    const div = document.createElement('div');
    div.className = 'toast';
    const name = document.createElement('b');
    name.textContent = notice.username ? `${notice.username}: ` : '';
    div.append(name, document.createTextNode(notice.text));
    this.el.toastStack.appendChild(div);
    this.toasts.push(div);
    while (this.toasts.length > 3) {
      const old = this.toasts.shift();
      old.remove();
    }
    setTimeout(() => {
      div.style.transition = 'opacity .3s ease, transform .3s ease';
      div.style.opacity = '0';
      div.style.transform = 'translateY(8px)';
      setTimeout(() => {
        div.remove();
        this.toasts = this.toasts.filter((item) => item !== div);
      }, 320);
    }, 5200);
  }

  toast(text, variant = '') {
    this.showNotice({ text, username: '' });
    if (variant && this.toasts.length) this.toasts[this.toasts.length - 1].classList.add(variant);
  }

  // ---------------------------------------------------------------- overlays

  showOverlay(mode, duration = 8000) {
    if (mode === 'leaderboard') {
      this.showLeaderboardOverlay(duration);
      return;
    }
    const html = OVERLAY_HTML[mode];
    if (!html) return;
    this.el.overlayRoot.innerHTML = html;
    clearTimeout(this.overlayTimer);
    this.overlayTimer = setTimeout(() => this.clearOverlay(mode), duration);
  }

  showLeaderboardOverlay(duration = 9000) {
    const board = this.leaderboard || { top: [] };
    const rows = (board.top || [])
      .slice(0, 8)
      .map(
        (player, index) =>
          `<li><span class="cmd">${index === 0 ? '👑' : `#${index + 1}`}</span><span class="desc">${this.escape(
            player.username
          )} — ${player.score} pts</span></li>`
      )
      .join('');
    this.el.overlayRoot.innerHTML = `
      <div class="overlay" data-overlay="leaderboard">
        <div class="overlay-card">
          <h2>TOP PLAYERS</h2>
          <ul class="overlay-list">${rows || '<li><span class="desc">No scores yet!</span></li>'}</ul>
          <p class="muted-note">Comment JOIN to appear here.</p>
        </div>
      </div>`;
    clearTimeout(this.overlayTimer);
    this.overlayTimer = setTimeout(() => this.clearOverlay('leaderboard'), duration);
  }

  clearOverlay(mode) {
    const node = this.el.overlayRoot.querySelector(`[data-overlay="${mode}"]`);
    if (node) node.remove();
  }

  escape(text) {
    return String(text || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // ---------------------------------------------------------------- game over

  syncGameOver(state) {
    const exists = this.el.overlayRoot.querySelector('[data-overlay="gameover"]');
    if (state.status === 'gameover' && !exists) {
      const board = this.leaderboard?.top?.slice(0, 5) || [];
      const rows = board
        .map((player, index) => `<li><span class="cmd">#${index + 1}</span><span class="desc">${this.escape(player.username)} — ${player.score}</span></li>`)
        .join('');
      this.el.overlayRoot.insertAdjacentHTML(
        'beforeend',
        `<div class="overlay" data-overlay="gameover">
          <div class="overlay-card gameover-card">
            <h2>GAME OVER</h2>
            <p class="big-stat">${this.escape(state.gameOverReason || 'The game has stopped')}</p>
            <h3>FINAL LEADERBOARD</h3>
            <ul class="overlay-list">${rows || '<li><span class="desc">No scores yet</span></li>'}</ul>
            <p class="muted-note">Waiting for the streamer to restart.</p>
          </div>
        </div>`
      );
    } else if (state.status !== 'gameover' && exists) {
      exists.remove();
    }
  }

  levelBanner(text) {
    const el = document.createElement('div');
    el.className = 'level-banner';
    el.textContent = text;
    this.el.stage.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => el.remove(), 2400);
  }

  setLeaderboardCache(board) {
    this.leaderboard = board;
  }
}
