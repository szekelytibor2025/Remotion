import {Queue, ConnectionOptions} from 'bullmq';
import {Redis} from 'ioredis';
import {env} from '../lib/env.js';

export const RENDER_QUEUE_NAME = 'render-jobs';

export const redisConnection: ConnectionOptions = {
  host: new URL(env.REDIS_URL).hostname,
  port: Number(new URL(env.REDIS_URL).port || 6379),
  maxRetriesPerRequest: null,
};

export const sharedRedis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export type RenderJobData = {
  jobId: string;
};

let queue: Queue<RenderJobData> | null = null;

export const renderQueue = (): Queue<RenderJobData> => {
  if (!queue) {
    queue = new Queue<RenderJobData>(RENDER_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {type: 'exponential', delay: 30_000},
        removeOnComplete: {count: 1000, age: 7 * 24 * 60 * 60},
        removeOnFail: {count: 1000, age: 30 * 24 * 60 * 60},
      },
    });
  }
  return queue;
};

export const enqueueRenderJob = async (jobId: string): Promise<void> => {
  await renderQueue().add(
    'render',
    {jobId},
    {jobId},
  );
};
