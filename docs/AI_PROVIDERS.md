# AI providers

Admin → **AI PROVIDERS** manages the AI backends the server can call. Nothing in the game uses
AI yet: this release only adds provider management, real connection testing and the shared
`aiService.chat()` interface for future features.

## What the section does

Each saved provider shows its name, normalized URL, model, key mask, connection result, active
state, last successful test (or last error) and the **ADD PROVIDER / EDIT / TEST CONNECTION /
SET ACTIVE / DELETE** actions.

- Only **one** provider is active. Activating one deactivates the others in the same database
  transaction (a unique partial index also enforces it).
- The active selection is stored in SQLite, so a restart restores it.
- A failing active provider is reported to the caller; it is never swapped for another provider
  automatically. The admin has to choose a new one.
- Deleting the active provider first asks for a second confirmation that AI features become
  disabled; otherwise it asks you to activate another provider first. Deleting always clears the
  active pointer, so the system never references a deleted provider.

## Add or edit a provider

| Field | Notes |
|---|---|
| Provider name | Any label (`Ollama`, `OpenRouter`, `Custom AI`). |
| AI URL | Base URL (`https://provider.example/v1`) **or** a full chat endpoint (`…/v1/chat/completions`). |
| AI KEY | Optional. Leave blank for local Ollama. When editing, blank keeps the saved key. |
| AI model | Required, entered manually (for example `llama3.1`, `gpt-4o`, `anthropic/claude-3.5-sonnet`). |

**TEST CONNECTION** works on the form values before saving (and can reuse the stored key when
editing). **SAVE** persists, **CANCEL** discards unsaved changes.

The URL is normalized once by `server/ai/endpoints.js`:

- `…/v1` → `…/v1/chat/completions`
- `…/v1/chat/completions` stays as-is
- `http://10.0.0.142:11434` → `http://10.0.0.142:11434/v1/chat/completions`
- an existing `/v1` or `/chat/completions` is never appended twice

## What a connection test proves

A test is a real minimal chat completion (`max_tokens: 8`) against the selected model. HTTP 200
alone is not enough: the response must contain a valid completion. The dashboard receives and
shows:

- `CONNECTED` or `CONNECTION FAILED`
- HTTP status (when there is one)
- response time in milliseconds
- model name and the resolved endpoint
- a specific explanation: invalid key (401/403), unknown model or endpoint (404), rate limit (429),
  timeout, refused connection, DNS failure or an unexpected response shape

Results are stored on the provider row (`last_test_status`, `last_tested_at`, `last_error`) and
survive a restart.

## Ollama (local network)

The backend on this PC must be able to reach the Ollama machine. Use the OpenAI-compatible URL:

```
http://10.0.0.142:11434/v1
```

- No AI KEY is required. Model names are never assumed: type the model you pulled
  (`llama3.1`, `qwen2.5`, …).
- If the test fails, the message includes connection troubleshooting: confirm Ollama is running on
  `10.0.0.142:11434`, that the Windows firewall allows the port, that both machines are on the same
  network, and that the URL is reachable from this PC
  (`curl http://10.0.0.142:11434/api/tags`).
- Ollama must listen on all interfaces, not only `127.0.0.1` (set `OLLAMA_HOST=0.0.0.0` when
  starting it).

## OpenRouter

If `.env` contains `OPENROUTER_URL`, `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`, the server:

1. detects the configuration at startup and imports it once as an **inactive** provider
   (also available with **Import OpenRouter from .env**);
2. never overwrites the environment variables or an existing provider;
3. avoids duplicates by provider type/base URL;
4. stores the key encrypted and only shows a mask.

Missing variables produce a clear warning in the Admin section; nothing crashes. Note that pasting
the URL into `OPENROUTER_API_KEY` and the key into `OPENROUTER_URL` is detected, used correctly in
memory and reported as a warning — fix the names in `.env` to avoid ambiguity.

## Storage and security

Table `ai_providers` (migration 2):

| Column | Purpose |
|---|---|
| `id` | random `ai_…` id |
| `name` | display name |
| `provider_type` | `openai`, `ollama` or `openrouter` (detected) |
| `base_url` | normalized base URL |
| `model` | model id |
| `encrypted_api_key` | AES-256-GCM payload (`v1:iv:tag:ciphertext`) or NULL |
| `is_active` | 0/1, unique partial index for the single active row |
| `last_test_status` | `connected`, `failed` or NULL |
| `last_tested_at` | epoch ms of the last test |
| `last_error` | last failure text (already redacted) |
| `source` | `manual` or `openrouter-env` |
| `created_at`, `updated_at` | epoch ms |

- Keys are encrypted with a key derived from `AI_SECRET` (or `APP_SECRET`). Without either, the
  server derives one from `ADMIN_TOKEN` and shows a warning in the UI — set `AI_SECRET` for a
  dedicated encryption key.
- Plaintext keys are decrypted only in the server process when testing or calling the provider.
  The API returns only `hasKey` and a mask (`••••••••1234`). The dashboard never receives the key,
  never stores it in `localStorage`/`sessionStorage`, and password inputs are cleared after saving.
- Error bodies, timeouts and network failures are redacted (`[redacted]`, plus any `sk-…`/Bearer
  token) before they are shown, stored in `last_error` or written to the log.
- `.env` is git-ignored; only `.env.example` contains empty placeholders.

## Shared service interface

```js
const reply = await aiService.chat([{ role: 'user', content: 'Hello' }]);
// { content, model, providerId, providerName, status, ms }
```

The service resolves the active provider, decrypts its key and calls the reusable
OpenAI-compatible adapter (`server/ai/adapter.js`). Future features should call this interface and
must not import a vendor SDK. With no active provider, `chat()` throws a clear error rather than
picking one.

## Files

```
server/ai/endpoints.js  URL validation, normalization, provider-type detection
server/ai/crypto.js     AES-256-GCM encrypt/decrypt/mask
server/ai/adapter.js    OpenAI-compatible chat + connection test, timeouts, redaction
server/ai/service.js    registry: CRUD, activation, testing, env import, chat()
```

## API

All endpoints require `x-admin-token` and return `Cache-Control: no-store` for the list.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/providers` | masked providers, active id, env status, encryption warning |
| POST | `/api/admin/providers` | create `{ name, url, model, apiKey? }` |
| PATCH | `/api/admin/providers/:id` | update; blank `apiKey` keeps the stored key |
| DELETE | `/api/admin/providers/:id` | delete; active requires `{ confirmDisable: true }` |
| POST | `/api/admin/providers/:id/test` | real test, stores result |
| POST | `/api/admin/providers/test` | test unsaved form values (optional `id` reuses stored key) |
| POST | `/api/admin/providers/:id/activate` | make it the only active provider |
| POST | `/api/admin/providers/import-openrouter` | import from `.env` once |

`GET /api/admin/overview` also contains the same masked `ai` block.

## Tests

`tests/aiProviders.test.js` covers add/edit/delete, activation and single-active enforcement,
restart persistence (SQLite), key masking and encryption round-trip, tamper detection, endpoint
normalization, Ollama URL and no-auth request, OpenRouter import and duplicate suppression,
missing/swapped env variables, timeouts, invalid key/model, refused connections, failed-test
storage, draft testing and the shared `chat()` interface (including no silent failover).
