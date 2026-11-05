/**
 * Multi-provider AI registry.
 *
 * Holds every saved provider, keeps exactly one active, encrypts API keys at
 * rest and exposes a single `chat()` entry point for future features:
 *
 *   const reply = await aiService.chat([{ role: 'user', content: 'Hi' }]);
 *
 * Nothing in the game calls it yet, and no feature hardcodes a vendor: adding a
 * provider is data, not code. A failing active provider is reported, never
 * silently replaced by another one.
 */

import crypto from 'node:crypto';

import { classifyEndpoint, looksSwappedOpenRouterEnv } from './endpoints.js';
import { encryptSecret, decryptSecret, maskSecret } from './crypto.js';
import { testConnection, chatCompletion, DEFAULT_TIMEOUT_MS } from './adapter.js';

const cleanText = (value, max = 200) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

const nowIso = (ts) => (ts ? new Date(ts).toISOString() : null);

export class AIService {
  constructor({
    store,
    aiConfig = {},
    encryptionSecret = '',
    encryptionSource = 'AI_SECRET',
    logger = null,
    fetchImpl = fetch,
    now = () => Date.now(),
  } = {}) {
    this.store = store;
    this.aiConfig = aiConfig;
    this.secret = encryptionSecret;
    this.encryptionSource = encryptionSource;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = Number(aiConfig.timeoutMs) || DEFAULT_TIMEOUT_MS;
  }

  // ------------------------------------------------------------------- view

  view(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      providerType: row.providerType,
      baseUrl: row.baseUrl,
      model: row.model,
      hasKey: Boolean(row.encryptedApiKey),
      maskedKey: row.encryptedApiKey ? maskSecretSafe(this, row) : '',
      isActive: Boolean(row.isActive),
      lastTestStatus: row.lastTestStatus || null,
      lastTestedAt: row.lastTestedAt || null,
      lastTestedAtIso: nowIso(row.lastTestedAt),
      lastError: row.lastError || null,
      source: row.source || 'manual',
      createdAt: row.createdAt || null,
      updatedAt: row.updatedAt || null,
    };
  }

  list() {
    return this.store.listProviders().map((row) => this.view(row));
  }

  activeProvider() {
    const row = this.store.listProviders().find((entry) => entry.isActive);
    return row || null;
  }

  encryptionWarning() {
    return this.encryptionSource === 'AI_SECRET'
      ? null
      : 'AI_SECRET is not set in .env, so provider keys are encrypted with a key derived from ADMIN_TOKEN. Set AI_SECRET for an independent encryption key.';
  }

  openrouterEnvironment() {
    const env = this.aiConfig.openrouter || {};
    return {
      configured: Boolean(env.url && env.key && env.model),
      url: env.url || '',
      model: env.model || '',
      hasKey: Boolean(env.key),
      swapped: Boolean(env.swapped),
      warning: env.warning || null,
    };
  }

  overview() {
    return {
      providers: this.list(),
      activeId: this.activeProvider()?.id || null,
      openrouter: this.openrouterEnvironment(),
      encryptionSource: this.encryptionSource,
      encryptionWarning: this.encryptionWarning(),
      timeoutMs: this.timeoutMs,
    };
  }

  // --------------------------------------------------------------- validation

  validate(input = {}) {
    const name = cleanText(input.name, 80);
    const model = cleanText(input.model, 120);
    if (!name) return { ok: false, error: 'Provider name is required.' };
    if (name.length < 2) return { ok: false, error: 'Provider name is too short.' };
    if (!model) return { ok: false, error: 'AI model is required (for example llama3.1 or gpt-4o).' };

    const endpoint = classifyEndpoint(input.url || input.baseUrl);
    if (!endpoint.ok) return endpoint;

    const apiKey = String(input.apiKey ?? '').trim();
    if (apiKey && apiKey.length < 4) return { ok: false, error: 'AI KEY looks too short to be valid.' };

    return {
      ok: true,
      values: {
        name,
        model,
        baseUrl: endpoint.baseUrl,
        providerType: endpoint.providerType,
        apiKey,
      },
    };
  }

  // -------------------------------------------------------------------- crud

  create(input = {}) {
    const checked = this.validate(input);
    if (!checked.ok) return { ok: false, error: checked.error };

    const row = this.store.createProvider({
      id: `ai_${crypto.randomBytes(6).toString('hex')}`,
      name: checked.values.name,
      providerType: checked.values.providerType,
      baseUrl: checked.values.baseUrl,
      model: checked.values.model,
      encryptedApiKey: checked.values.apiKey ? this.encrypt(checked.values.apiKey) : null,
      isActive: false,
      lastTestStatus: null,
      lastTestedAt: null,
      lastError: null,
      source: cleanText(input.source, 40) || 'manual',
      createdAt: this.now(),
      updatedAt: this.now(),
    });

    this.logger?.info?.(`AI provider added: ${row.name} (${row.providerType}, ${row.baseUrl}).`);
    return { ok: true, provider: this.view(row), overview: this.overview() };
  }

  update(id, patch = {}) {
    const existing = this.store.getProvider(id);
    if (!existing) return { ok: false, code: 'not-found', error: 'Provider not found.' };

    const merged = {
      name: patch.name !== undefined ? patch.name : existing.name,
      model: patch.model !== undefined ? patch.model : existing.model,
      url: patch.url !== undefined ? patch.url : existing.baseUrl,
    };
    const checked = this.validate(merged);
    if (!checked.ok) return { ok: false, error: checked.error };

    const apiKey = String(patch.apiKey ?? '').trim();
    const clearKey = patch.clearKey === true;
    const updated = this.store.updateProvider(id, {
      name: checked.values.name,
      model: checked.values.model,
      baseUrl: checked.values.baseUrl,
      providerType: checked.values.providerType,
      encryptedApiKey: apiKey
        ? this.encrypt(apiKey)
        : clearKey
        ? null
        : existing.encryptedApiKey,
      updatedAt: this.now(),
    });
    this.logger?.info?.(`AI provider updated: ${updated.name}.`);
    return { ok: true, provider: this.view(updated), overview: this.overview() };
  }

  remove(id, { disableConfirmed = false } = {}) {
    const row = this.store.getProvider(id);
    if (!row) return { ok: false, code: 'not-found', error: 'Provider not found.' };
    if (row.isActive && !disableConfirmed) {
      return {
        ok: false,
        code: 'active-provider',
        error: 'This provider is active. Activate another provider first, or confirm disabling AI features before deleting it.',
      };
    }
    if (row.isActive) this.store.setActiveProvider(null);
    this.store.deleteProvider(id);
    this.logger?.info?.(`AI provider deleted: ${row.name}.`);
    return { ok: true, deleted: this.view(row), overview: this.overview() };
  }

  activate(id) {
    const row = this.store.getProvider(id);
    if (!row) return { ok: false, code: 'not-found', error: 'Provider not found.' };
    const updated = this.store.setActiveProvider(id);
    this.logger?.info?.(`AI provider activated: ${updated.name}.`);
    return { ok: true, provider: this.view(updated), overview: this.overview() };
  }

  // -------------------------------------------------------------------- test

  decrypt(payload) {
    if (!payload) return '';
    return decryptSecret(payload, this.secret);
  }

  encrypt(plain) {
    return encryptSecret(plain, this.secret);
  }

  /** Test a saved provider or an unsaved draft (edit form). */
  async testDraft(input = {}) {
    const checked = this.validate(input);
    if (!checked.ok) return { ok: false, status: null, ms: 0, model: input.model || '', error: checked.error };

    let apiKey = checked.values.apiKey;
    if (!apiKey && input.id) {
      const stored = this.store.getProvider(input.id);
      if (stored?.encryptedApiKey) {
        try {
          apiKey = this.decrypt(stored.encryptedApiKey);
        } catch {
          return {
            ok: false,
            status: null,
            ms: 0,
            model: checked.values.model,
            error: 'The stored API key could not be decrypted. Re-enter it (AI_SECRET may have changed).',
          };
        }
      }
    }

    const result = await testConnection(
      { baseUrl: checked.values.baseUrl, model: checked.values.model, apiKey, providerType: checked.values.providerType },
      { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, now: this.now }
    );

    return {
      ok: Boolean(result.ok),
      status: result.status ?? null,
      ms: result.ms ?? 0,
      model: result.model || checked.values.model,
      endpoint: result.endpoint || null,
      error: result.error || null,
      errorCode: result.errorCode || null,
      providerType: checked.values.providerType,
    };
  }

  async test(id) {
    const row = this.store.getProvider(id);
    if (!row) return { ok: false, code: 'not-found', error: 'Provider not found.' };

    let apiKey = '';
    try {
      apiKey = this.decrypt(row.encryptedApiKey);
    } catch {
      const failed = this.store.noteProviderTest(id, {
        status: 'failed',
        testedAt: this.now(),
        error: 'Stored API key could not be decrypted. Re-enter the key (AI_SECRET may have changed).',
      });
      return {
        ok: false,
        status: null,
        ms: 0,
        model: row.model,
        error: 'Stored API key could not be decrypted. Re-enter the key (AI_SECRET may have changed).',
        provider: this.view(failed),
        overview: this.overview(),
      };
    }

    const result = await testConnection(
      { baseUrl: row.baseUrl, model: row.model, apiKey, providerType: row.providerType },
      { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, now: this.now }
    );

    const updated = this.store.noteProviderTest(id, {
      status: result.ok ? 'connected' : 'failed',
      testedAt: this.now(),
      error: result.ok ? null : result.error,
    });
    const summary = {
      ok: Boolean(result.ok),
      status: result.status ?? null,
      ms: result.ms ?? 0,
      model: result.model || row.model,
      endpoint: result.endpoint || null,
      error: result.error || null,
      errorCode: result.errorCode || null,
      provider: this.view(updated),
      overview: this.overview(),
    };
    if (!result.ok) {
      this.logger?.warn?.(`AI connection test failed for ${row.name}: ${result.error}`);
    } else {
      this.logger?.info?.(`AI connection test passed for ${row.name} (${result.status}, ${result.ms} ms).`);
    }
    return summary;
  }

  // -------------------------------------------------------------- openrouter

  /**
   * Import OpenRouter from .env once. Never overwrites the env or an existing
   * provider; the key is encrypted before it touches the database.
   */
  importOpenRouter({ save = true } = {}) {
    const env = this.openrouterEnvironment();
    // The safe overview deliberately omits the secret; read the internal config
    // for the key itself and never put it in a response.
    const credentials = this.aiConfig.openrouter || {};
    if (!env.configured) {
      return {
        ok: false,
        code: 'openrouter-not-configured',
        error:
          'OpenRouter is not configured. Set OPENROUTER_URL, OPENROUTER_API_KEY and OPENROUTER_MODEL in .env, then restart the server.',
      };
    }

    const endpoint = classifyEndpoint(env.url);
    if (!endpoint.ok) return { ok: false, code: 'openrouter-invalid-url', error: endpoint.error };

    const existing = this.store
      .listProviders()
      .find((row) => row.providerType === 'openrouter' || row.source === 'openrouter-env' || row.baseUrl === endpoint.baseUrl);
    if (existing) {
      return { ok: true, created: false, provider: this.view(existing), overview: this.overview() };
    }
    if (!save) {
      return { ok: true, created: false, preview: { name: 'OpenRouter', baseUrl: endpoint.baseUrl, model: env.model } };
    }

    const created = this.create({
      name: 'OpenRouter',
      url: endpoint.baseUrl,
      model: env.model,
      apiKey: credentials.key,
      source: 'openrouter-env',
    });
    if (!created.ok) return { ok: false, code: 'openrouter-import-failed', error: created.error };
    this.logger?.info?.(`OpenRouter imported from .env as provider ${created.provider.id} (inactive).`);
    return { ok: true, created: true, provider: created.provider, overview: this.overview() };
  }

  // -------------------------------------------------------------------- chat

  /**
   * Shared AI entry point. Future features call this instead of a vendor SDK.
   * If the active provider fails, the error is surfaced: no silent failover.
   */
  async chat(messages, options = {}) {
    const row = this.activeProvider();
    if (!row) throw new Error('No active AI provider is configured. Choose one in Admin → AI Providers.');
    const apiKey = this.decrypt(row.encryptedApiKey);
    const reply = await chatCompletion(
      { id: row.id, baseUrl: row.baseUrl, model: row.model, apiKey, providerType: row.providerType },
      messages,
      {
        fetchImpl: this.fetchImpl,
        timeoutMs: Number(options.timeoutMs) || this.timeoutMs,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        responseFormat: options.responseFormat || null,
        now: this.now,
      }
    );
    return { ...reply, providerName: row.name };
  }
}

function maskSecretSafe(service, row) {
  try {
    return maskSecret(service.decrypt(row.encryptedApiKey));
  } catch {
    return '••••••••';
  }
}

export { looksSwappedOpenRouterEnv };
