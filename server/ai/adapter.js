/**
 * OpenAI-compatible provider adapter.
 *
 * One adapter serves OpenRouter, Ollama, llama.cpp, LM Studio, vLLM provider
 * modes and any custom OpenAI-compatible server. It never special-cases a vendor:
 * the only differences are the normalized endpoint and whether an API key is set.
 *
 * Safety rules:
 *  - the API key is only ever placed in the Authorization header;
 *  - every error message is redacted before it can reach a log or the dashboard;
 *  - a test only succeeds when the model returns a valid chat completion, not
 *    merely because the TCP connection opened.
 */

import { classifyEndpoint } from './endpoints.js';

export const DEFAULT_TIMEOUT_MS = 8000;

/** Replace a key with a placeholder anywhere it may have been echoed. */
export function redactSecret(value, secret) {
  let text = String(value == null ? '' : value);
  const key = String(secret || '');
  if (key && key.length >= 4) text = text.split(key).join('[redacted]');
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .slice(0, 600);
}

const networkHint = (message) =>
  `${message} Check that the AI server is running and reachable from this PC ` +
  '(host, port, firewall and that both machines are on the same network).';

/** Pull a useful message out of an error body without dumping the whole thing. */
function errorMessageFromBody(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body.slice(0, 300) || fallback;
  return (
    body.error?.message ||
    body.error ||
    body.message ||
    body.detail ||
    fallback
  );
}

async function readBody(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 300);
  }
}

function extractContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? payload?.response ?? '';
  if (typeof content === 'string' && content.trim()) return content.trim();
  // Some providers stream tool/reasoning only; still a valid completion shape.
  if (choice?.message || choice?.delta) return '';
  return null;
}

/**
 * Send a minimal chat completion and report exactly what happened.
 *
 * @param {{baseUrl:string, model:string, apiKey?:string, providerType?:string}} provider
 */
export async function testConnection(provider, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  const endpoint = classifyEndpoint(provider?.baseUrl || provider?.url);
  if (!endpoint.ok) {
    return { ok: false, status: null, ms: 0, model: provider?.model || '', endpoint: null, error: endpoint.error };
  }
  if (!provider?.model) {
    return { ok: false, status: null, ms: 0, model: '', endpoint: endpoint.chatEndpoint, error: 'AI model is required.' };
  }

  const key = String(provider.apiKey || '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const started = now();

  try {
    const response = await fetchImpl(endpoint.chatEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });

    const ms = Math.max(0, now() - started);
    const body = await readBody(response);

    if (!response.ok) {
      const status = response.status;
      let hint = '';
      if (status === 401 || status === 403) hint = ' The API key was rejected.';
      if (status === 404) hint = ' The endpoint or model was not found; check the URL and model name.';
      if (status === 429) hint = ' The provider is rate limiting or the account has no credit.';
      return {
        ok: false,
        status,
        ms,
        model: provider.model,
        endpoint: endpoint.chatEndpoint,
        error: redactSecret(`${errorMessageFromBody(body, response.statusText || 'Request failed')}${hint}`, key),
        errorCode: status === 401 || status === 403 ? 'invalid-key' : status === 404 ? 'invalid-model-or-url' : 'http-error',
      };
    }

    const content = extractContent(body);
    if (content === null) {
      return {
        ok: false,
        status: response.status,
        ms,
        model: provider.model,
        endpoint: endpoint.chatEndpoint,
        error: redactSecret('The provider answered but did not return a chat completion (unexpected response shape).', key),
        errorCode: 'invalid-response',
      };
    }

    return {
      ok: true,
      status: response.status,
      ms,
      model: provider.model,
      endpoint: endpoint.chatEndpoint,
      content: redactSecret(content, key).slice(0, 120),
      providerType: endpoint.providerType,
    };
  } catch (error) {
    const ms = Math.max(0, now() - started);
    const aborted = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
    if (aborted) {
      return {
        ok: false,
        status: null,
        ms,
        model: provider.model,
        endpoint: endpoint.chatEndpoint,
        error: `Connection test timed out after ${timeoutMs} ms.`,
        errorCode: 'timeout',
      };
    }
    const code = error?.cause?.code || error?.code || '';
    const base =
      code === 'ECONNREFUSED'
        ? 'Connection refused.'
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? 'Host could not be resolved.'
        : code === 'ECONNRESET'
        ? 'Connection was reset.'
        : 'Could not reach the AI provider.';
    return {
      ok: false,
      status: null,
      ms,
      model: provider.model,
      endpoint: endpoint.chatEndpoint,
      error: redactSecret(networkHint(base), key),
      errorCode: 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat completion through the same adapter. Used by the shared aiService.chat()
 * interface; no game feature calls this yet.
 */
export async function chatCompletion(
  provider,
  messages,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    temperature = 0.7,
    maxTokens = 400,
    responseFormat = null,
    now = Date.now,
  } = {}
) {
  const endpoint = classifyEndpoint(provider?.baseUrl || provider?.url);
  if (!endpoint.ok) throw new Error(endpoint.error);
  if (!provider?.model) throw new Error('AI model is required.');
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages must be a non-empty array.');

  const key = String(provider.apiKey || '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const started = now();
  try {
    const response = await fetchImpl(endpoint.chatEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
      signal: controller.signal,
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new Error(
        redactSecret(`HTTP ${response.status}: ${errorMessageFromBody(body, response.statusText || 'Request failed')}`, key)
      );
    }
    const content = extractContent(body);
    if (content === null) throw new Error('The provider did not return a chat completion.');
    return {
      content,
      model: provider.model,
      providerId: provider.id || null,
      status: response.status,
      ms: Math.max(0, now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}
