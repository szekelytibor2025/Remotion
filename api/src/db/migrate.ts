import {db} from './index.js';
import {logger} from '../lib/logger.js';

const migrations: {version: number; up: string}[] = [
  {
    version: 1,
    up: `
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        rate_limit_per_minute INTEGER NOT NULL DEFAULT 60
      );

      CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;

      CREATE TABLE render_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('queued','downloading','rendering','uploading','done','failed','cancelled')),
        progress INTEGER NOT NULL DEFAULT 0,

        api_key_id TEXT NOT NULL REFERENCES api_keys(id),

        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        catalog TEXT NOT NULL,
        year TEXT NOT NULL,
        audio_url TEXT NOT NULL,
        palette_key TEXT NOT NULL,

        output_bucket TEXT NOT NULL,
        output_path TEXT NOT NULL,
        public_url TEXT,

        external_ref TEXT,
        callback_url TEXT,

        error_message TEXT,
        error_code TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,

        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,

        duration_seconds REAL,
        render_seconds REAL,
        file_size_bytes INTEGER
      );

      CREATE INDEX idx_render_jobs_status ON render_jobs(status);
      CREATE INDEX idx_render_jobs_external_ref ON render_jobs(external_ref);
      CREATE INDEX idx_render_jobs_created_at ON render_jobs(created_at);

      CREATE TABLE rate_limit_buckets (
        api_key_id TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (api_key_id, window_start)
      );

      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `,
  },
];

const ensureSchemaTable = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
};

const getCurrentVersion = (): number => {
  ensureSchemaTable();
  const row = db
    .prepare('SELECT MAX(version) as v FROM schema_version')
    .get() as {v: number | null};
  return row.v ?? 0;
};

export const runMigrations = () => {
  const current = getCurrentVersion();
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) {
    logger.info({current}, 'Database is up to date');
    return;
  }

  for (const m of pending) {
    logger.info({version: m.version}, 'Applying migration');
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
    })();
  }
  logger.info(
    {applied: pending.length, version: pending[pending.length - 1]?.version},
    'Migrations applied',
  );
};

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  runMigrations();
  db.close();
}
