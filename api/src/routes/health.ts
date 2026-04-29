import {Router} from 'express';
import {sharedRedis} from '../queue/index.js';
import {db} from '../db/index.js';

const router = Router();

router.get('/health', async (_req, res) => {
  const checks: Record<string, boolean> = {db: false, redis: false};

  try {
    db.prepare('SELECT 1').get();
    checks.db = true;
  } catch {
    checks.db = false;
  }

  try {
    const pong = await sharedRedis.ping();
    checks.redis = pong === 'PONG';
  } catch {
    checks.redis = false;
  }

  const ok = Object.values(checks).every(Boolean);
  return res.status(ok ? 200 : 503).json({ok, checks, timestamp: Date.now()});
});

export default router;
