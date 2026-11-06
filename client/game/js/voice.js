/**
 * Mascot voice.
 *
 * Uses the browser Web Speech API (American English). The class is a thin
 * abstraction on purpose: swapping in a higher quality server TTS provider
 * later means implementing the same `speak(text, opts)` method and pointing
 * `TTS_PROVIDER` at it.
 *
 * Note for OBS: the OBS browser source (CEF) usually ships without speech
 * synthesis voices, so the same page opened in Chrome/Edge is the reliable way
 * to get audio. The overlay keeps working silently when no voice is available.
 */

const PREFERRED = [
  'Google US English',
  'Microsoft Aria Online (Natural) - English (United States)',
  'Microsoft Jenny Online (Natural) - English (United States)',
  'Microsoft Zira - English (United States)',
  'Samantha',
  'Alex',
];

const COOLDOWN = { low: 14000, normal: 7500, high: 3800 };

export class Voice {
  constructor({ onStart = null, onEnd = null, onError = null, onVoices = null } = {}) {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    // Real playback telemetry: the server must never assume speech happened.
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.onError = onError;
    this.onVoices = onVoices;
    this.enabled = true;
    this.volume = 0.85;
    this.frequency = 'normal';
    this.voice = null;
    this.voices = [];
    this.lastAt = 0;
    this.available = false;
    this.lastSpoken = '';
    this.init();
  }

  init() {
    if (!this.supported) {
      console.warn('[voice] Web Speech API is not available in this browser.');
      return;
    }
    const load = () => {
      this.voices = window.speechSynthesis.getVoices() || [];
      if (!this.voices.length) return;
      this.available = true;
      const score = (voice) => {
        const name = voice.name || '';
        const preferredIndex = PREFERRED.findIndex((candidate) => name.includes(candidate));
        const isUS = /en[-_]US/i.test(voice.lang || '');
        const isEnglish = /^en/i.test(voice.lang || '');
        return (preferredIndex === -1 ? 100 : preferredIndex) + (isUS ? 0 : isEnglish ? 10 : 50);
      };
      const english = this.voices.filter((voice) => /^en/i.test(voice.lang || ''));
      const pool = english.length ? english : this.voices;
      this.voice = [...pool].sort((a, b) => score(a) - score(b))[0] || null;
      this.reportVoices();
    };
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    // Chrome occasionally pauses long lived speech synthesis; keep it awake.
    setInterval(() => {
      try {
        if (window.speechSynthesis.speaking) window.speechSynthesis.resume();
      } catch {
        /* ignore */
      }
    }, 8000).unref?.();
  }

  setSettings(settings = {}) {
    this.enabled = settings.voiceEnabled !== false;
    this.volume = Math.min(1, Math.max(0, Number(settings.voiceVolume ?? 0.85)));
    this.frequency = settings.speechFrequency || 'normal';
  }

  cooldownFor(priority) {
    if (priority >= 2) return Math.max(2500, COOLDOWN[this.frequency] / 2.4);
    return COOLDOWN[this.frequency] ?? COOLDOWN.normal;
  }

  speak(text, { priority = 1, force = false, speechId = null } = {}) {
    if (!this.supported) {
      this.onError?.({ error: 'unsupported', text, speechId });
      return false;
    }
    if (!this.enabled || !text) return false;
    const now = performance.now();
    // AI co-host lines are already rate limited server-side; force lets a real
    // generated reply reach TTS even right after a short game callout.
    if (!force && now - this.lastAt < this.cooldownFor(priority)) return false;
    // Low frequency mode skips some of the chatter to sound natural.
    if (this.frequency === 'low' && priority < 2 && Math.random() < 0.5) return false;

    this.lastAt = now;
    this.lastSpoken = text;

    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      if (this.voice) utterance.voice = this.voice;
      utterance.volume = this.volume;
      utterance.rate = 1.02 + Math.random() * 0.12;
      utterance.pitch = 1.04 + Math.random() * 0.18;
      // A cancelled utterance fires its events after a newer line started; the
      // server matches speech ids, but skipping them keeps the log clean.
      utterance.onstart = () => this.onStart?.({ text, speechId });
      utterance.onend = () => this.onEnd?.({ text, speechId });
      utterance.onerror = (event) => {
        const error = String(event?.error || 'speech-error');
        if (error === 'interrupted' || error === 'canceled') return;
        this.onError?.({ text, speechId, error });
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      console.warn('[voice] speak failed:', error.message);
      return false;
    }
  }

  /** Tell the server how many voices this overlay really has (0 is a warning). */
  reportVoices() {
    this.onVoices?.({ available: this.available, count: this.voices.length, supported: this.supported });
  }

  status() {
    return { supported: this.supported, available: this.available, count: this.voices.length };
  }

  cancel() {
    if (!this.supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}
