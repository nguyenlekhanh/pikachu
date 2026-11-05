import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../server/database/store.js';
import { SqliteStore } from '../server/database/sqlite.js';
import { AIService } from '../server/ai/service.js';
import { classifyEndpoint, looksSwappedOpenRouterEnv } from '../server/ai/endpoints.js';
import { encryptSecret, decryptSecret, maskSecret } from '../server/ai/crypto.js';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const completion = (content = 'OK') => jsonResponse({ choices: [{ message: { role: 'assistant', content } }] });

function makeService(fetchImpl = async () => completion(), { openrouter = {}, store = null } = {}) {
  const memory = store || new MemoryStore();
  if (!store) memory.init();
  return new AIService({
    store: memory,
    aiConfig: {
      timeoutMs: 1200,
      openrouter: { url: '', key: '', model: '', swapped: false, warning: null, ...openrouter },
    },
    encryptionSecret: 'unit-test-secret',
    encryptionSource: 'AI_SECRET',
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl,
  });
}

const ollama = (extra = {}) => ({
  name: 'Ollama',
  url: 'http://10.0.0.142:11434/v1',
  model: 'llama3.1',
  ...extra,
});

// --------------------------------------------------------------- endpoints

test('endpoint detection normalizes base URLs and full chat endpoints', () => {
  const base = classifyEndpoint('https://openrouter.ai/api/v1');
  assert.equal(base.ok, true);
  assert.equal(base.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(base.chatEndpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(base.providerType, 'openrouter');

  const full = classifyEndpoint('https://openrouter.ai/api/v1/chat/completions/');
  assert.equal(full.chatEndpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.ok(!full.chatEndpoint.includes('/chat/completions/v1'));
  assert.ok(!full.chatEndpoint.includes('/v1/v1'));
});

test('endpoint detection accepts Ollama URLs with and without /v1', () => {
  assert.equal(classifyEndpoint('http://10.0.0.142:11434').baseUrl, 'http://10.0.0.142:11434/v1');
  assert.equal(classifyEndpoint('http://10.0.0.142:11434/').chatEndpoint, 'http://10.0.0.142:11434/v1/chat/completions');
  assert.equal(
    classifyEndpoint('http://10.0.0.142:11434/v1/chat/completions').chatEndpoint,
    'http://10.0.0.142:11434/v1/chat/completions'
  );
  assert.equal(classifyEndpoint('http://10.0.0.142:11434/v1').providerType, 'ollama');
});

test('endpoint detection rejects invalid and unsafe URLs', () => {
  assert.equal(classifyEndpoint('').ok, false);
  assert.equal(classifyEndpoint('not a url').ok, false);
  assert.equal(classifyEndpoint('ftp://provider.example/v1').ok, false);
  assert.equal(classifyEndpoint('https://user:pass@provider.example/v1').ok, false);
});

// ------------------------------------------------------------- encryption

test('API keys round-trip through AES-256-GCM and tampering is detected', () => {
  const encrypted = encryptSecret('sk-or-v1-super-secret-value', 'app-secret');
  assert.ok(encrypted.startsWith('v1:'));
  assert.ok(!encrypted.includes('super-secret-value'));
  assert.equal(decryptSecret(encrypted, 'app-secret'), 'sk-or-v1-super-secret-value');
  assert.throws(() => decryptSecret(encrypted, 'different-secret'));
  assert.throws(() => decryptSecret(`${encrypted.slice(0, -2)}xx`, 'app-secret'));
  assert.equal(maskSecret('sk-or-v1-super-secret-value'), '••••••••alue');
  assert.equal(maskSecret('short'), '••••••••');
  assert.equal(maskSecret(''), '');
});

// ------------------------------------------------------------------- CRUD

test('add provider validates fields, encrypts the key and never returns it', () => {
  const service = makeService();
  const invalid = service.create({ name: '', url: 'http://10.0.0.142:11434/v1', model: 'llama3.1' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /name/i);

  const created = service.create(ollama({ apiKey: 'sk-or-v1-very-secret-1234' }));
  assert.equal(created.ok, true);
  assert.equal(created.provider.maskedKey, '••••••••1234');
  assert.equal(created.provider.hasKey, true);
  assert.equal(created.provider.isActive, false);
  assert.equal(created.provider.lastTestStatus, null);

  const stored = service.store.getProvider(created.provider.id);
  assert.ok(stored.encryptedApiKey.startsWith('v1:'));
  assert.ok(!stored.encryptedApiKey.includes('very-secret-1234'));

  const json = JSON.stringify(service.overview());
  assert.ok(!json.includes('very-secret-1234'));
  assert.ok(!json.includes(stored.encryptedApiKey));
});

test('edit provider keeps the saved key when the field is left blank', () => {
  const service = makeService();
  const created = service.create(ollama({ apiKey: 'sk-or-v1-keep-me-9876' }));

  const updated = service.update(created.provider.id, {
    name: 'Ollama local',
    url: 'http://10.0.0.142:11434',
    model: 'qwen2.5',
    apiKey: '',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.provider.name, 'Ollama local');
  assert.equal(updated.provider.baseUrl, 'http://10.0.0.142:11434/v1');
  assert.equal(updated.provider.model, 'qwen2.5');
  assert.equal(updated.provider.hasKey, true);
  assert.equal(updated.provider.maskedKey, '••••••••9876');
});

test('edit provider rejects an invalid URL and keeps the previous values', () => {
  const service = makeService();
  const created = service.create(ollama());
  const updated = service.update(created.provider.id, { name: 'Broken', url: 'ftp://nope' });
  assert.equal(updated.ok, false);
  assert.equal(service.store.getProvider(created.provider.id).name, 'Ollama');
});

test('only one provider can be active and activation persists', () => {
  const service = makeService();
  const a = service.create(ollama({ name: 'Ollama A' }));
  const b = service.create(ollama({ name: 'Ollama B', url: 'http://10.0.0.142:11434/v1/chat/completions' }));

  assert.equal(service.activate(a.provider.id).ok, true);
  assert.equal(service.activate(b.provider.id).ok, true);

  const active = service.list().filter((provider) => provider.isActive);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, b.provider.id);
  assert.equal(service.activeProvider().id, b.provider.id);
});

test('deleting the active provider requires confirmation, then leaves no active provider', () => {
  const service = makeService();
  const created = service.create(ollama());
  service.activate(created.provider.id);

  const blocked = service.remove(created.provider.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'active-provider');
  assert.equal(service.list().length, 1);

  const deleted = service.remove(created.provider.id, { disableConfirmed: true });
  assert.equal(deleted.ok, true);
  assert.equal(service.list().length, 0);
  assert.equal(service.activeProvider(), null);
});

test('active provider and encrypted key survive a server restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikachu-ai-'));
  const dbFile = path.join(dir, 'providers.db');
  let sqlite = null;
  try {
    sqlite = new SqliteStore(dbFile);
    sqlite.init();
    const before = makeService(undefined, { store: sqlite });
    const created = before.create(ollama({ apiKey: 'sk-or-v1-restart-5678' }));
    before.activate(created.provider.id);
    sqlite.close?.();
    sqlite = null;

    const reopened = new SqliteStore(dbFile);
    reopened.init();
    const after = makeService(undefined, { store: reopened });
    const providers = after.list();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, created.provider.id);
    assert.equal(providers[0].isActive, true);
    assert.equal(providers[0].hasKey, true);
    assert.equal(providers[0].maskedKey, '••••••••5678');
    assert.equal(after.activeProvider().encryptedApiKey.startsWith('v1:'), true);
    reopened.close?.();
  } finally {
    try {
      sqlite?.close?.();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may keep the WAL handle briefly; the OS cleans temp files. */
    }
  }
});

// ---------------------------------------------------------------- testing

test('Ollama test uses /v1/chat/completions without an Authorization header', async () => {
  let captured = null;
  const service = makeService(async (url, init) => {
    captured = { url, init };
    return completion('OK');
  });
  const created = service.create(ollama());

  const result = await service.test(created.provider.id);

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.model, 'llama3.1');
  assert.equal(captured.url, 'http://10.0.0.142:11434/v1/chat/completions');
  assert.equal(captured.init.headers.authorization, undefined);
  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.model, 'llama3.1');
  assert.ok(Array.isArray(payload.messages) && payload.messages.length > 0);

  const stored = service.list()[0];
  assert.equal(stored.lastTestStatus, 'connected');
  assert.equal(typeof stored.lastTestedAt, 'number');
  assert.equal(stored.lastError, null);
});

test('a reachable URL alone is not success: the model must return a completion', async () => {
  const service = makeService(async () => jsonResponse({ ok: true, status: 'running' }));
  const created = service.create(ollama());
  const result = await service.test(created.provider.id);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid-response');
  assert.match(result.error, /did not return a chat completion/i);
  assert.equal(service.list()[0].lastTestStatus, 'failed');
});

test('invalid API key returns HTTP 401 and the key is redacted from errors', async () => {
  const service = makeService(async () =>
    jsonResponse({ error: { message: 'Invalid API key sk-or-v1-leaked-key-0000 supplied' } }, 401)
  );
  const created = service.create(ollama({ apiKey: 'sk-or-v1-leaked-key-0000' }));

  const result = await service.test(created.provider.id);

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.errorCode, 'invalid-key');
  assert.ok(!result.error.includes('sk-or-v1-leaked-key-0000'));
  assert.ok(!JSON.stringify(result.provider).includes('sk-or-v1-leaked-key-0000'));
  assert.ok(!service.list()[0].lastError.includes('sk-or-v1-leaked-key-0000'));
});

test('invalid model reports the provider error and HTTP status', async () => {
  const service = makeService(async () =>
    jsonResponse({ error: { message: 'model "llama9" not found, try pulling it first' } }, 404)
  );
  const created = service.create(ollama({ model: 'llama9' }));
  const result = await service.test(created.provider.id);

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.errorCode, 'invalid-model-or-url');
  assert.match(result.error, /llama9/);
});

test('connection timeout is reported as a timeout, not a success', async () => {
  const service = makeService(async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  });
  const created = service.create(ollama());
  const result = await service.test(created.provider.id);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'timeout');
  assert.match(result.error, /timed out/i);
  assert.equal(result.status, null);
});

test('unreachable Ollama host gives network troubleshooting guidance', async () => {
  const service = makeService(async () => {
    const error = new Error('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  });
  const created = service.create(ollama());
  const result = await service.test(created.provider.id);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'network');
  assert.match(result.error, /Connection refused/i);
  assert.match(result.error, /reachable/i);
  assert.match(result.error, /firewall|port|network/i);
});

test('draft test never saves a provider', async () => {
  const service = makeService();
  const draft = await service.testDraft({
    name: 'Draft',
    url: 'http://10.0.0.142:11434',
    model: 'llama3.1',
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.endpoint, 'http://10.0.0.142:11434/v1/chat/completions');
  assert.equal(service.list().length, 0);
});

// ------------------------------------------------------------- OpenRouter

test('OpenRouter env import creates one inactive provider without exposing the key', () => {
  const service = makeService(undefined, {
    openrouter: {
      url: 'https://openrouter.ai/api/v1',
      key: 'sk-or-v1-env-import-0000',
      model: 'openrouter/free',
    },
  });

  const first = service.importOpenRouter();
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.provider.name, 'OpenRouter');
  assert.equal(first.provider.providerType, 'openrouter');
  assert.equal(first.provider.isActive, false);
  assert.equal(first.provider.hasKey, true);
  assert.equal(first.provider.maskedKey, '••••••••0000');
  assert.ok(!JSON.stringify(first.overview).includes('sk-or-v1-env-import-0000'));

  const second = service.importOpenRouter();
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(service.list().length, 1);
});

test('missing OpenRouter variables give a configuration warning, not a crash', () => {
  const service = makeService();
  const result = service.importOpenRouter();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'openrouter-not-configured');
  assert.match(result.error, /OPENROUTER_URL/);
  assert.equal(service.overview().openrouter.configured, false);
});

test('config normalizes swapped OpenRouter env values without rewriting .env', async () => {
  const saved = {
    url: process.env.OPENROUTER_URL,
    key: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
  };
  process.env.OPENROUTER_URL = 'sk-or-v1-swapped-key-123456';
  process.env.OPENROUTER_API_KEY = 'https://openrouter.ai/api/v1';
  process.env.OPENROUTER_MODEL = 'openrouter/free';
  try {
    const { config } = await import(`../server/config.js?swapped=${Date.now()}`);
    assert.equal(config.ai.openrouter.swapped, true);
    assert.equal(config.ai.openrouter.url, 'https://openrouter.ai/api/v1');
    assert.equal(config.ai.openrouter.key, 'sk-or-v1-swapped-key-123456');
    assert.match(config.ai.openrouter.warning, /swapped/i);
    assert.ok(!config.ai.openrouter.warning.includes('sk-or-v1-swapped-key-123456'));
  } finally {
    if (saved.url === undefined) delete process.env.OPENROUTER_URL;
    else process.env.OPENROUTER_URL = saved.url;
    if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = saved.model;
  }
});

test('swapped OPENROUTER_URL / OPENROUTER_API_KEY values are detected', () => {
  assert.equal(
    looksSwappedOpenRouterEnv('sk-or-v1-abcdefgh12345678', 'https://openrouter.ai/api/v1'),
    true
  );
  assert.equal(looksSwappedOpenRouterEnv('https://openrouter.ai/api/v1', 'sk-or-v1-abcdefgh12345678'), false);
  assert.equal(looksSwappedOpenRouterEnv('', ''), false);
});

// -------------------------------------------------------------------- chat

test('aiService.chat uses the active provider only', async () => {
  let captured = null;
  const service = makeService(async (url, init) => {
    captured = { url, init };
    return completion('hello from the active provider');
  });
  await assert.rejects(service.chat([{ role: 'user', content: 'Hi' }]), /No active AI provider/);

  const created = service.create(ollama({ apiKey: 'sk-or-v1-chat-key-4321' }));
  service.activate(created.provider.id);
  const reply = await service.chat([{ role: 'user', content: 'Hi' }]);

  assert.equal(reply.content, 'hello from the active provider');
  assert.equal(reply.providerName, 'Ollama');
  assert.equal(captured.init.headers.authorization, 'Bearer sk-or-v1-chat-key-4321');
  assert.equal(JSON.parse(captured.init.body).model, 'llama3.1');
});

test('a failing active provider is reported and never silently replaced', async () => {
  let calls = 0;
  const service = makeService(async () => {
    calls += 1;
    return jsonResponse({ error: { message: 'provider exploded' } }, 500);
  });
  const a = service.create(ollama({ name: 'Primary' }));
  const b = service.create(ollama({ name: 'Backup', url: 'http://10.0.0.142:11434/v1/chat/completions' }));
  service.activate(a.provider.id);

  await assert.rejects(service.chat([{ role: 'user', content: 'Hi' }]), /HTTP 500/);
  assert.equal(service.activeProvider().id, a.provider.id);
  assert.notEqual(service.activeProvider().id, b.provider.id);
  assert.equal(calls, 1);
});
