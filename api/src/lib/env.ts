import 'dotenv/config';
import {z} from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  SQLITE_PATH: z.string().default('./data/api.db'),

  REMOTION_BUNDLE_DIR: z.string().default('../remotion'),
  REMOTION_COMPOSITION_ID: z.string().default('Rings'),
  REMOTION_CONCURRENCY: z.coerce.number().default(4),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_VIDEO_BUCKET: z.string().default('videos'),

  WEBHOOK_HMAC_SECRET: z.string().min(16),

  WORK_DIR: z.string().default('./work'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const env = schema.parse(process.env);
