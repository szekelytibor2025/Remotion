import {Request, Response, NextFunction} from 'express';
import {
  ApiKey,
  checkAndIncrementRateLimit,
  findApiKeyByHash,
  hashApiKey,
  touchApiKey,
} from '../db/api-keys.js';

declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: ApiKey;
  }
}

export const requireApiKey = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or malformed Authorization header. Expected: Bearer <api_key>',
    });
  }

  const raw = header.slice('Bearer '.length).trim();
  if (raw.length < 20) {
    return res.status(401).json({error: 'unauthorized', message: 'Invalid API key'});
  }

  const hash = hashApiKey(raw);
  const apiKey = findApiKeyByHash(hash);
  if (!apiKey) {
    return res.status(401).json({error: 'unauthorized', message: 'Invalid API key'});
  }

  const limit = checkAndIncrementRateLimit(apiKey.id, apiKey.rate_limit_per_minute);
  res.setHeader('X-RateLimit-Limit', String(apiKey.rate_limit_per_minute));
  res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.floor(limit.resetAt / 1000)));

  if (!limit.allowed) {
    return res.status(429).json({
      error: 'rate_limit_exceeded',
      message: `Rate limit of ${apiKey.rate_limit_per_minute} requests per minute exceeded`,
      reset_at: limit.resetAt,
    });
  }

  touchApiKey(apiKey.id);
  req.apiKey = apiKey;
  next();
};
