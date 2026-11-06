/**
 * Original mascot artwork, drawn as inline SVG.
 *
 * Two characters share the same face-slot structure (eyes / mouth / extra) but
 * have completely different silhouettes and palettes:
 *
 *  - Zappy: the original golden sky-spark with long ears, glowy cheeks, tiny
 *    wings and a lightning tail.
 *  - Pip: a calm mint "comet owl" with round glasses, a single curl, bat-like
 *    wings and a star tail. Different body, different colours, different faces.
 *
 * No third-party or generated images are used; these are CSS/SVG shapes.
 */

const ZAPPY_FACES = {
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
  thinking: {
    eyes: `
      <ellipse cx="82" cy="104" rx="9" ry="11" fill="#2a1f08"/>
      <ellipse cx="118" cy="102" rx="9" ry="11" fill="#2a1f08"/>
      <circle cx="85" cy="100" r="3" fill="#ffffff"/>
      <circle cx="121" cy="98" r="3" fill="#ffffff"/>`,
    mouth: `<path d="M90 132 q10 -6 20 2" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    extra: `<text x="158" y="66" font-size="26" fill="#bfe6ff">?</text>`,
  },
  listening: {
    eyes: `
      <ellipse cx="82" cy="104" rx="10" ry="12" fill="#2a1f08"/>
      <ellipse cx="118" cy="104" rx="10" ry="12" fill="#2a1f08"/>
      <circle cx="86" cy="99" r="3.8" fill="#ffffff"/>
      <circle cx="122" cy="99" r="3.8" fill="#ffffff"/>`,
    mouth: `<path d="M92 130 q8 6 16 0" stroke="#2a1f08" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    extra: `<path d="M56 60 q-12 14 0 26" stroke="#ffe680" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.65"/>`,
  },
};

const ZAPPY_BODY = `
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

    <g class="face-eyes"></g>
    <g class="face-mouth"></g>
    <g class="face-extra"></g>
  </g>
</svg>`;

const PIP_FACES = {
  neutral: {
    eyes: `
      <circle cx="82" cy="103" r="6" fill="#123b40"/>
      <circle cx="118" cy="103" r="6" fill="#123b40"/>
      <circle cx="84" cy="101" r="2" fill="#ffffff"/>
      <circle cx="120" cy="101" r="2" fill="#ffffff"/>`,
    mouth: `<path d="M94 132 q6 5 12 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    extra: '',
  },
  happy: {
    eyes: `
      <path d="M74 106 q8 -10 16 0" stroke="#123b40" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M110 106 q8 -10 16 0" stroke="#123b40" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    mouth: `<path d="M90 129 q10 11 20 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    extra: '',
  },
  excited: {
    eyes: `
      <circle cx="82" cy="102" r="8" fill="#123b40"/>
      <circle cx="118" cy="102" r="8" fill="#123b40"/>
      <circle cx="85" cy="99" r="3" fill="#ffffff"/>
      <circle cx="121" cy="99" r="3" fill="#ffffff"/>`,
    mouth: `<ellipse cx="100" cy="132" rx="9" ry="10" fill="#1c5b60"/>`,
    extra: `<path d="M168 58 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3 z" fill="#b8ffe6"/>`,
  },
  surprised: {
    eyes: `
      <circle cx="82" cy="102" r="9" fill="#ffffff" stroke="#123b40" stroke-width="3"/>
      <circle cx="118" cy="102" r="9" fill="#ffffff" stroke="#123b40" stroke-width="3"/>
      <circle cx="82" cy="103" r="4" fill="#123b40"/>
      <circle cx="118" cy="103" r="4" fill="#123b40"/>`,
    mouth: `<ellipse cx="100" cy="134" rx="7" ry="9" fill="#1c5b60"/>`,
    extra: '',
  },
  sad: {
    eyes: `
      <path d="M74 104 q8 -7 16 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>
      <circle cx="82" cy="112" r="3.6" fill="#123b40"/>
      <path d="M110 104 q8 -7 16 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>
      <circle cx="118" cy="112" r="3.6" fill="#123b40"/>
      <circle cx="92" cy="116" r="3" fill="#7ecbff"/>`,
    mouth: `<path d="M92 138 q8 -9 16 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    extra: '',
  },
  sleepy: {
    eyes: `
      <path d="M74 104 q8 7 16 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M110 104 q8 7 16 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    mouth: `<ellipse cx="100" cy="133" rx="5" ry="6" fill="#1c5b60"/>`,
    extra: `<text x="156" y="62" font-size="24" fill="#c9fff0">z</text><text x="172" y="42" font-size="16" fill="#c9fff0">z</text>`,
  },
  thinking: {
    eyes: `
      <circle cx="82" cy="101" r="6" fill="#123b40"/>
      <path d="M74 104 q8 8 16 0" stroke="#123b40" stroke-width="3" fill="none" stroke-linecap="round"/>
      <circle cx="118" cy="103" r="6" fill="#123b40"/>`,
    mouth: `<path d="M94 132 h14" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    extra: `<text x="150" y="58" font-size="24" fill="#c9fff0">?</text>`,
  },
  laughing: {
    eyes: `
      <path d="M74 106 q8 -11 16 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M110 106 q8 -11 16 0" stroke="#123b40" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    mouth: `<path d="M88 126 q12 18 24 0 z" fill="#1c5b60"/>`,
    extra: `<text x="158" y="64" font-size="18" fill="#b8ffe6">✦</text>`,
  },
  celebrating: {
    eyes: `
      <text x="82" y="112" font-size="24" text-anchor="middle" fill="#b8ffe6">✧</text>
      <text x="118" y="112" font-size="24" text-anchor="middle" fill="#b8ffe6">✧</text>`,
    mouth: `<path d="M88 128 q12 18 24 0 z" fill="#1c5b60"/>`,
    extra: `<text x="164" y="64" font-size="20" fill="#b8ffe6">✧</text>`,
  },
  listening: {
    eyes: `
      <circle cx="82" cy="103" r="7" fill="#123b40"/>
      <circle cx="118" cy="103" r="7" fill="#123b40"/>
      <circle cx="84" cy="100" r="2.6" fill="#ffffff"/>
      <circle cx="120" cy="100" r="2.6" fill="#ffffff"/>`,
    mouth: `<ellipse cx="100" cy="131" rx="5" ry="4" fill="#1c5b60"/>`,
    extra: `<path d="M150 62 q16 6 14 22" stroke="#b8ffe6" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.7"/>`,
  },
};

// Pip: a mint comet-owl. Round glasses, a single curl, bat wings, star tail.
const PIP_BODY = `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="pbody" cx="38%" cy="24%" r="84%">
      <stop offset="0%" stop-color="#e9fff8"/>
      <stop offset="45%" stop-color="#6fe3c4"/>
      <stop offset="100%" stop-color="#259c86"/>
    </radialGradient>
    <linearGradient id="ptail" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#7d6bff"/>
      <stop offset="100%" stop-color="#c9a6ff"/>
    </linearGradient>
    <radialGradient id="pcheek">
      <stop offset="0%" stop-color="#ffd0e4"/>
      <stop offset="100%" stop-color="#ff8fc0"/>
    </radialGradient>
  </defs>

  <path d="M104 152 q26 34 62 26 q-14 20 -40 20 q-24 0 -34 -20 z" fill="url(#ptail)" stroke="#5b48c9" stroke-width="3" stroke-linejoin="round"/>
  <path d="M138 176 l6 -10 4 12 10 2 -9 7 z" fill="#e8dcff" stroke="#5b48c9" stroke-width="2" stroke-linejoin="round"/>

  <g class="wing-left">
    <path d="M58 96 C28 78 18 106 32 124 C44 138 56 128 62 114 Z" fill="#d8fff2" stroke="#4bbf9f" stroke-width="3"/>
    <path d="M34 104 q10 6 14 16" stroke="#8fdfc8" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g>
  <g class="wing-right">
    <path d="M142 96 C172 78 182 106 168 124 C156 138 144 128 138 114 Z" fill="#d8fff2" stroke="#4bbf9f" stroke-width="3"/>
    <path d="M166 104 q-10 6 -14 16" stroke="#8fdfc8" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g>

  <g class="pip-body">
    <path d="M100 22 q18 0 14 20 q-3 14 -14 14 q-10 0 -9 -14 q1 -8 6 -12" fill="#8ff0d6" stroke="#259c86" stroke-width="3" stroke-linejoin="round"/>

    <ellipse cx="100" cy="116" rx="54" ry="56" fill="url(#pbody)" stroke="#259c86" stroke-width="4"/>
    <ellipse cx="100" cy="146" rx="30" ry="24" fill="#f0fffb" opacity="0.55"/>

    <ellipse cx="62" cy="140" rx="11" ry="8" transform="rotate(-16 62 140)" fill="#2f7f74" stroke="#1f5f57" stroke-width="3"/>
    <ellipse cx="138" cy="140" rx="11" ry="8" transform="rotate(16 138 140)" fill="#2f7f74" stroke="#1f5f57" stroke-width="3"/>

    <circle cx="66" cy="128" r="11" fill="url(#pcheek)" opacity="0.85"/>
    <circle cx="134" cy="128" r="11" fill="url(#pcheek)" opacity="0.85"/>

    <circle cx="82" cy="103" r="20" fill="none" stroke="#123b40" stroke-width="4"/>
    <circle cx="118" cy="103" r="20" fill="none" stroke="#123b40" stroke-width="4"/>
    <path d="M102 103 h2" stroke="#123b40" stroke-width="4" stroke-linecap="round"/>
    <path d="M62 100 q-12 -4 -14 -12" stroke="#123b40" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M138 100 q12 -4 14 -12" stroke="#123b40" stroke-width="3" fill="none" stroke-linecap="round"/>

    <g class="face-eyes"></g>
    <g class="face-mouth"></g>
    <g class="face-extra"></g>
  </g>
</svg>`;

export const CHARACTERS = {
  zappy: {
    id: 'zappy',
    name: 'Zappy',
    role: 'hyper, playful, silly hype host',
    color: '#ffd23f',
    accent: '#c98b12',
    body: ZAPPY_BODY,
    faces: ZAPPY_FACES,
    bodyClass: 'zappy-body',
    bubbleClass: 'bubble-zappy',
    pitch: 1.2,
    rate: 1.05,
  },
  pip: {
    id: 'pip',
    name: 'Pip',
    role: 'deadpan, dry-witted, quietly competitive stats nerd',
    color: '#6fe3c4',
    accent: '#259c86',
    body: PIP_BODY,
    faces: PIP_FACES,
    bodyClass: 'pip-body',
    bubbleClass: 'bubble-pip',
    pitch: 0.9,
    rate: 0.97,
  },
};

export const FACE_NAMES = Object.keys(ZAPPY_FACES);

// AI intents map to the closest existing expression; no new artwork is invented.
export const EMOTION_ALIASES = {
  confused: 'surprised',
  talking: 'happy',
  curious: 'thinking',
};

export function resolveFace(character, emotion) {
  const faces = CHARACTERS[character]?.faces || ZAPPY_FACES;
  const resolved = EMOTION_ALIASES[emotion] || emotion;
  return { resolved, face: faces[resolved] || faces.neutral || ZAPPY_FACES.neutral };
}
