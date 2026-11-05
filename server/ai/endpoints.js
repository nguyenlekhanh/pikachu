/**
 * URL parsing for OpenAI-compatible AI providers.
 *
 * The streamer may paste any of these and must get the same result:
 *   https://openrouter.ai/api/v1
 *   https://openrouter.ai/api/v1/
 *   https://openrouter.ai/api/v1/chat/completions
 *   http://10.0.0.142:11434
 *   http://10.0.0.142:11434/v1
 *   http://10.0.0.142:11434/v1/chat/completions
 *
 * No endpoint is built by string concatenation without removing an existing
 * `/v1` or `/chat/completions` first, so paths are never duplicated.
 */

const OPENAI_CHAT_PATH = '/chat/completions';
const OPENAI_MODELS_PATH = '/models';

const looksLikeKey = (value) => /^(sk|pk|or|key)-[A-Za-z0-9_-]{8,}$/i.test(String(value || '').trim());
const looksLikeUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

/**
 * Detect and normalize a provider URL.
 * @returns {{ok:true, baseUrl:string, chatEndpoint:string, modelsEndpoint:string, providerType:string}
 *          |{ok:false, error:string}}
 */
export function classifyEndpoint(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return { ok: false, error: 'AI URL is required.' };
  if (!looksLikeUrl(input)) {
    return { ok: false, error: 'AI URL must start with http:// or https:// (for example http://10.0.0.142:11434/v1).' };
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'AI URL is not a valid URL.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'AI URL must use http:// or https://.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Do not put credentials in the AI URL. Use the AI KEY field instead.' };
  }

  let pathname = parsed.pathname.replace(/\/+$/, '');

  // Drop a full chat endpoint back to its base, without assuming /v1 is present.
  if (pathname.toLowerCase().endsWith(OPENAI_CHAT_PATH)) {
    pathname = pathname.slice(0, -OPENAI_CHAT_PATH.length).replace(/\/+$/, '');
  }

  // Ollama's OpenAI-compatible API lives under /v1; the native port 11434 is
  // accepted without it and normalized once.
  if (!/(^|\/)v1$/i.test(pathname)) {
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const isOllama = port === '11434' || /ollama/i.test(parsed.hostname);
    pathname = `${pathname}/v1`;
  }

  const baseUrl = `${parsed.origin}${pathname}`;
  return {
    ok: true,
    baseUrl,
    chatEndpoint: `${baseUrl}${OPENAI_CHAT_PATH}`,
    modelsEndpoint: `${baseUrl}${OPENAI_MODELS_PATH}`,
    providerType: detectProviderType(parsed, input),
  };
}

export function detectProviderType(parsed, raw = '') {
  const host = String(parsed?.hostname || '').toLowerCase();
  const text = String(raw).toLowerCase();
  if (host.includes('openrouter') || text.includes('openrouter')) return 'openrouter';
  if (parsed?.port === '11434' || host.includes('ollama') || text.includes('ollama')) return 'ollama';
  return 'openai';
}

/** Env values are sometimes pasted into the wrong variable; detect both. */
export function looksSwappedOpenRouterEnv(url, key) {
  return looksLikeUrl(key) && looksLikeKey(url);
}

export { looksLikeKey, looksLikeUrl };
