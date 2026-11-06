/**
 * "Zappy" - the original flying mascot for PIKACHU LIVE.
 *
 * Original CSS/SVG character (no third-party or copyrighted art assets): a
 * round golden sky-spark with long ears, glowy cheeks, tiny wings and a
 * lightning tail. Expressions are swapped as SVG fragments, and the mascot
 * flies around the stage on a requestAnimationFrame loop.
 */

const FACES = {
  neutral: {
    eyes: `
      <ellipse cx="82" cy="104" rx="9" ry="11" fill="#2a1f08"/>
      <ellipse cx="118" cy="104" rx="9" ry="11" fill="#2a1f08"/>
      <circle cx="85" cy="100" r="3" fill="#ffffff"/>
      <circle cx="121" cy="100" r="3" fill="#ffffff"/>`,
    mouth: `<path d="M90 130 q10 8 20 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    extra: '',
  },
  happy: {
    eyes: `
      <ellipse cx="82" cy="104" rx="9" ry="11" fill="#2a1f08"/>
      <ellipse cx="118" cy="104" rx="9" ry="11" fill="#2a1f08"/>
      <circle cx="85" cy="100" r="3.4" fill="#ffffff"/>
      <circle cx="121" cy="100" r="3.4" fill="#ffffff"/>`,
    mouth: `<path d="M86 128 q14 16 28 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    extra: '',
  },
  excited: {
    eyes: `
      <ellipse cx="82" cy="103" rx="11" ry="13" fill="#2a1f08"/>
      <ellipse cx="118" cy="103" rx="11" ry="13" fill="#2a1f08"/>
      <circle cx="86" cy="98" r="4" fill="#ffffff"/>
      <circle cx="122" cy="98" r="4" fill="#ffffff"/>`,
    mouth: `<path d="M87 126 q13 20 26 0 z" fill="#7a2d2d"/><path d="M94 139 q6 5 12 0" fill="#ff8fab"/>`,
    extra: `<path d="M168 62 l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4 z" fill="#ffe680"/>`,
  },
  surprised: {
    eyes: `
      <circle cx="82" cy="103" r="13" fill="#ffffff" stroke="#2a1f08" stroke-width="2"/>
      <circle cx="118" cy="103" r="13" fill="#ffffff" stroke="#2a1f08" stroke-width="2"/>
      <circle cx="82" cy="105" r="5.5" fill="#2a1f08"/>
      <circle cx="118" cy="105" r="5.5" fill="#2a1f08"/>`,
    mouth: `<ellipse cx="100" cy="134" rx="9" ry="11" fill="#7a2d2d"/>`,
    extra: '',
  },
  sad: {
    eyes: `
      <path d="M72 108 q9 -9 18 -2" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M110 106 q9 -7 18 2" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>
      <circle cx="92" cy="118" r="3.4" fill="#7ecbff"/>`,
    mouth: `<path d="M88 138 q12 -12 24 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    extra: '',
  },
  sleepy: {
    eyes: `
      <path d="M73 105 q9 8 18 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M109 105 q9 8 18 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    mouth: `<ellipse cx="100" cy="133" rx="6" ry="7" fill="#7a2d2d"/>`,
    extra: `<text x="156" y="66" font-size="26" fill="#bfe6ff">Z</text><text x="172" y="44" font-size="18" fill="#bfe6ff">z</text>`,
  },
  angry: {
    eyes: `
      <ellipse cx="82" cy="106" rx="8.5" ry="10" fill="#2a1f08"/>
      <ellipse cx="118" cy="106" rx="8.5" ry="10" fill="#2a1f08"/>
      <path d="M70 90 l20 8" stroke="#2a1f08" stroke-width="6" stroke-linecap="round"/>
      <path d="M130 90 l-20 8" stroke="#2a1f08" stroke-width="6" stroke-linecap="round"/>`,
    mouth: `<path d="M88 138 q12 -12 24 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    extra: `<text x="160" y="74" font-size="24" fill="#ff7a8a">💢</text>`,
  },
  laughing: {
    eyes: `
      <path d="M73 108 q9 -12 18 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M109 108 q9 -12 18 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    mouth: `<path d="M84 124 q16 26 32 0 z" fill="#7a2d2d"/><path d="M92 140 q8 7 16 0" fill="#ff8fab"/>`,
    extra: `<text x="160" y="70" font-size="20" fill="#ffe680">✨</text>`,
  },
  celebrating: {
    eyes: `
      <text x="82" y="116" font-size="30" text-anchor="middle" fill="#ffd93d">★</text>
      <text x="118" y="116" font-size="30" text-anchor="middle" fill="#ffd93d">★</text>`,
    mouth: `<path d="M84 126 q16 22 32 0 z" fill="#7a2d2d"/>`,
    extra: `<text x="168" y="70" font-size="24" fill="#ffe680">✨</text>`,
  },
};

const BODY = `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="zbody" cx="34%" cy="26%" r="82%">
      <stop offset="0%" stop-color="#fff3ae"/>
      <stop offset="48%" stop-color="#ffd23f"/>
      <stop offset="100%" stop-color="#e39a12"/>
    </radialGradient>
    <linearGradient id="ztail" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#a8f4ff"/>
      <stop offset="100%" stop-color="#2b9dd8"/>
    </linearGradient>
    <radialGradient id="zcheek">
      <stop offset="0%" stop-color="#ffb3c4"/>
      <stop offset="100%" stop-color="#f2607c"/>
    </radialGradient>
  </defs>

  <path d="M152 128 l30 -12 -9 22 24 6 -34 18 -3 -19 -20 4 z" fill="url(#ztail)" stroke="#1a6f96" stroke-width="3" stroke-linejoin="round"/>

  <g class="wing-left">
    <path d="M56 100 C24 68 10 94 24 116 C33 130 50 126 60 116 Z" fill="#f2fbff" stroke="#93d8ef" stroke-width="3"/>
    <path d="M40 100 l14 4 -12 6 z" fill="#cdeefb"/>
  </g>
  <g class="wing-right">
    <path d="M144 100 C176 68 190 94 176 116 C167 130 150 126 140 116 Z" fill="#f2fbff" stroke="#93d8ef" stroke-width="3"/>
    <path d="M160 100 l-14 4 12 6 z" fill="#cdeefb"/>
  </g>

  <g class="zappy-body">
    <ellipse cx="66" cy="56" rx="15" ry="36" transform="rotate(-20 66 56)" fill="url(#zbody)" stroke="#c98b12" stroke-width="4"/>
    <ellipse cx="66" cy="36" rx="7" ry="15" transform="rotate(-20 66 56)" fill="#3a2a10"/>
    <ellipse cx="134" cy="56" rx="15" ry="36" transform="rotate(20 134 56)" fill="url(#zbody)" stroke="#c98b12" stroke-width="4"/>
    <ellipse cx="134" cy="36" rx="7" ry="15" transform="rotate(20 134 56)" fill="#3a2a10"/>

    <ellipse cx="78" cy="172" rx="17" ry="10" fill="#e8a318" stroke="#c98b12" stroke-width="3"/>
    <ellipse cx="122" cy="172" rx="17" ry="10" fill="#e8a318" stroke="#c98b12" stroke-width="3"/>

    <ellipse cx="100" cy="118" rx="58" ry="54" fill="url(#zbody)" stroke="#c98b12" stroke-width="4"/>
    <ellipse cx="100" cy="140" rx="34" ry="26" fill="#fff6c9" opacity="0.55"/>

    <circle cx="68" cy="132" r="12" fill="url(#zcheek)" opacity="0.9"/>
    <circle cx="132" cy="132" r="12" fill="url(#zcheek)" opacity="0.9"/>

    <g id="z-eyes">${FACES.neutral.eyes}</g>
    <g id="z-mouth">${FACES.neutral.mouth}</g>
    <g id="z-extra"></g>
  </g>
</svg>`;

// AI replies can use intents that map to the closest existing expression; no
// new animation assets are invented.
const EMOTION_ALIASES = {
  thinking: 'sleepy',
  confused: 'surprised',
  talking: 'happy',
};

export class Mascot {
  constructor({ layer, voice }) {
    this.layer = layer;
    this.voice = voice;
    this.enabled = true;
    this.speed = 1;
    this.emotion = 'neutral';
    this.x = 800;
    this.y = 520;
    this.target = { x: 780, y: 500 };
    this.nextTargetAt = 0;
    this.lastFrame = 0;
    this.frameHandle = null;
    this.bubbleTimer = null;
    this.emotionTimer = null;

    this.el = document.createElement('div');
    this.el.className = 'mascot';
    this.el.innerHTML = `<div class="mascot-aura"></div>${BODY}`;
    this.layer.appendChild(this.el);

    this.bubble = document.createElement('div');
    this.bubble.className = 'bubble';
    this.layer.appendChild(this.bubble);

    this.eyes = this.el.querySelector('#z-eyes');
    this.mouth = this.el.querySelector('#z-mouth');
    this.extra = this.el.querySelector('#z-extra');

    this.el.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
    this.animate = this.animate.bind(this);
    this.start();
  }

  setSettings(settings = {}) {
    this.enabled = settings.mascotEnabled !== false;
    this.speed = Math.max(0.3, Number(settings.mascotSpeed) || 1);
    this.el.style.display = this.enabled ? '' : 'none';
    if (!this.enabled) this.hideBubble();
  }

  setEmotion(emotion) {
    const resolved = EMOTION_ALIASES[emotion] || emotion;
    const face = FACES[resolved] || FACES.neutral;
    this.emotion = emotion;
    this.el.classList.remove(...Object.keys(FACES).map((key) => key));
    if (resolved !== 'neutral') this.el.classList.add(resolved);
    this.eyes.innerHTML = face.eyes;
    this.mouth.innerHTML = face.mouth;
    this.extra.innerHTML = face.extra || '';
    clearTimeout(this.emotionTimer);
    if (emotion !== 'neutral') {
      this.emotionTimer = setTimeout(() => this.setEmotion('neutral'), 6000);
    }
  }

  react(line = {}) {
    if (!this.enabled || !line.text) return;
    this.setEmotion(line.emotion || 'happy');
    this.showBubble(line.text, line.priority || 1);
    if (!this.voice) return;
    const spoke = this.voice.speak(line.text, {
      priority: line.priority || 1,
      force: Boolean(line.ai),
      speechId: line.speechId ?? null,
    });
    // Honest reporting: a line the voice layer never played must not leave the
    // server waiting for a completion that will never arrive.
    if (!spoke && line.speechId != null) this.onSpeechSkipped?.(line);
  }

  showBubble(text, priority = 1) {
    this.bubble.textContent = text;
    this.bubble.classList.add('show');
    this.positionBubble();
    clearTimeout(this.bubbleTimer);
    const duration = Math.min(9000, Math.max(2800, 1400 + text.length * 62)) + (priority > 1 ? 600 : 0);
    this.bubbleTimer = setTimeout(() => this.hideBubble(), duration);
  }

  hideBubble() {
    this.bubble.classList.remove('show');
  }

  pickTarget() {
    const margin = 130;
    // Keep Zappy below the instructions and gift legend so it never hides them.
    const minY = 520;
    const maxY = 1120;
    // translate3d places the top-left corner, so reserve the sprite width to
    // stop the mascot and its tail from being clipped by the stage edge.
    const size = this.el.offsetWidth || 200;
    const maxX = Math.max(margin, 1080 - size - margin);
    const avoidCenter = Math.random() < 0.45;
    let x = margin + Math.random() * Math.max(0, maxX - margin);
    let y = minY + Math.random() * (maxY - minY);
    if (avoidCenter && x > 260 && x < 820) {
      x = Math.random() < 0.5 ? margin + Math.random() * 120 : maxX - Math.random() * 120;
    }
    this.target = { x, y };
    this.nextTargetAt = performance.now() + 2400 + Math.random() * 3200;
  }

  animate(ts) {
    if (!this.enabled) {
      this.frameHandle = requestAnimationFrame(this.animate);
      return;
    }
    if (!this.lastFrame) this.lastFrame = ts;
    const dt = Math.min(64, ts - this.lastFrame);
    this.lastFrame = ts;

    if (ts > this.nextTargetAt) this.pickTarget();

    const ease = Math.min(0.9, 0.0022 * this.speed * dt * 1.35);
    this.x += (this.target.x - this.x) * ease;
    this.y += (this.target.y - this.y) * ease;

    const bob = Math.sin(ts / 480) * 9;
    const tilt = Math.sin(ts / 900) * 4;
    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px, ${(this.y + bob).toFixed(1)}px, 0) rotate(${tilt.toFixed(2)}deg)`;

    this.positionBubble();
    this.frameHandle = requestAnimationFrame(this.animate);
  }

  positionBubble() {
    if (!this.bubble.classList.contains('show')) return;
    const bubbleWidth = this.bubble.offsetWidth || 320;
    const bubbleHeight = this.bubble.offsetHeight || 80;
    let left = this.x + 120 - bubbleWidth / 2;
    left = Math.min(Math.max(left, 26), 1080 - bubbleWidth - 26);
    let top = this.y - bubbleHeight - 12;
    let tail = 'tail-left';
    if (top < 24) {
      top = this.y + 240;
      tail = 'tail-left';
    }
    this.bubble.style.left = `${left}px`;
    this.bubble.style.top = `${top}px`;
    this.bubble.classList.remove('tail-left', 'tail-right');
    this.bubble.classList.add(this.x + 120 < left + bubbleWidth / 2 ? 'tail-right' : 'tail-left');
  }

  start() {
    if (this.frameHandle) return;
    this.frameHandle = requestAnimationFrame(this.animate);
  }

  stop() {
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }
}
