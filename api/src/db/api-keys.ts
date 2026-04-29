import {db} from './index.js';
import {createHash, randomBytes} from 'node:crypto';

const KEY_PREFIX = 'krv_';

export type ApiKey = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  rate_limit_per_minute: number;
};

export const hashApiKey = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

export const generateApiKey = (
  name: string,
  rateLimitPerMinute = 60,
): {id: string; rawKey: string; record: ApiKey} => {
  const raw = `${KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const hash = hashApiKey(raw);
  const id = `key_${randomBytes(8).toString('hex')}`;
  const prefix = raw.slice(0, 8);
  const now = Date.now();

  db.prepare(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, rate_limit_per_minute)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, hash, prefix, now, rateLimitPerMinute);

  const record = getApiKeyById(id)!;
  return {id, rawKey: raw, record};
};

export const findApiKeyByHash = (hash: string): ApiKey | null => {
  const row = db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .get(hash) as ApiKey | undefined;
  return row ?? null;
};

export const getApiKeyById = (id: string): ApiKey | null => {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as
    | ApiKey
    | undefined;
  return row ?? null;
};

export const listApiKeys = (): ApiKey[] => {
  return db
    .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
    .all() as ApiKey[];
};

export const revokeApiKey = (id: string): boolean => {
  const result = db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), id);
  return result.changes > 0;
};

export const touchApiKey = (id: string) => {
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
};

export const checkAndIncrementRateLimit = (
  apiKeyId: string,
  limitPerMinute: number,
): {allowed: boolean; remaining: number; resetAt: number} => {
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const resetAt = windowStart + 60_000;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO rate_limit_buckets (api_key_id, window_start, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT (api_key_id, window_start)
       DO UPDATE SET request_count = request_count + 1`,
    ).run(apiKeyId, windowStart);

    const row = db
      .prepare(
        'SELECT request_count FROM rate_limit_buckets WHERE api_key_id = ? AND window_start = ?',
      )
      .get(apiKeyId, windowStart) as {request_count: number};

    db.prepare(
      'DELETE FROM rate_limit_buckets WHERE window_start < ?',
    ).run(windowStart - 5 * 60_000);

    return row.request_count;
  });

  const count = tx();
  const allowed = count <= limitPerMinute;
  return {
    allowed,
    remaining: Math.max(0, limitPerMinute - count),
    resetAt,
  };
};
