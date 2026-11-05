/**
 * Secret encryption for saved AI provider keys.
 *
 * Provider API keys must never be stored as plaintext and must never be sent to
 * the admin browser. They are encrypted with AES-256-GCM using a key derived
 * from a server-side secret (AI_SECRET / APP_SECRET in .env). The stored value
 * is self-describing (`v1:iv:tag:ciphertext`) so the format can evolve.
 *
 * If AI_SECRET is not configured the service derives a key from ADMIN_TOKEN and
 * reports that fallback in the admin UI. That is still encrypted at rest, but a
 * dedicated AI_SECRET is strongly preferred.
 */

import crypto from 'node:crypto';

const SALT = 'pikachu-live-us-ai-providers-v1';
const VERSION = 'v1';

export function deriveKey(secret) {
  const value = String(secret || '');
  if (!value) throw new Error('AI encryption secret is not configured');
  // scrypt is intentionally slow: one derivation per process is enough here.
  return crypto.scryptSync(value, SALT, 32);
}

export function encryptSecret(plaintext, secret) {
  const text = String(plaintext ?? '');
  if (!text) return null;
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptSecret(payload, secret) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported encrypted key format');
  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** UI-safe representation: never the real key. */
export function maskSecret(secret) {
  const value = String(secret ?? '');
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `••••••••${value.slice(-4)}`;
}
