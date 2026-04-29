import {Worker} from 'bullmq';
import path from 'node:path';
import fs from 'node:fs';
import {env} from './lib/env.js';
import {logger} from './lib/logger.js';
import {redisConnection, RENDER_QUEUE_NAME, RenderJobData} from './queue/index.js';
import {
  getJob,
  incrementAttempts,
  setJobError,
  setJobOutput,
  updateJobProgress,
  updateJobStatus,
} from './db/jobs.js';
import {downloadAudio, uploadVideo} from './lib/supabase.js';
import {renderRingsVideo, warmBundle} from './lib/render.js';
import {sendWebhook, WebhookPayload} from './lib/webhook.js';
import {runMigrations} from './db/migrate.js';

runMigrations();

logger.info('Warming Remotion bundle...');
await warmBundle();
logger.info('Worker ready, waiting for jobs');

const cleanWorkDir = (jobId: string) => {
  const dir = path.join(env.WORK_DIR, jobId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

const fireWebhook = async (
  jobId: string,
  callbackUrl: string | null,
  payload: WebhookPayload,
) => {
  if (!callbackUrl) return;
  try {
    await sendWebhook(callbackUrl, payload);
  } catch (err) {
    logger.error({jobId, err: (err as Error).message}, 'Webhook delivery threw');
  }
};

const worker = new Worker<RenderJobData>(
  RENDER_QUEUE_NAME,
  async (bullJob) => {
    const {jobId} = bullJob.data;
    const job = getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found in DB`);

    incrementAttempts(jobId);

    const workDir = path.join(env.WORK_DIR, jobId);
    fs.mkdirSync(workDir, {recursive: true});
    const audioPath = path.join(workDir, 'input.wav');
    const videoPath = path.join(workDir, 'output.mp4');

    try {
      logger.info({jobId, attempt: job.attempts + 1}, 'Job started');

      updateJobStatus(jobId, 'downloading', 0);
      logger.info({jobId}, 'Downloading audio');
      await downloadAudio(job.audio_url, audioPath);

      updateJobStatus(jobId, 'rendering', 5);
      logger.info({jobId}, 'Rendering video');
      const audioFileUrl = `file://${audioPath.replace(/\\/g, '/')}`;
      const result = await renderRingsVideo({
        outputLocation: videoPath,
        inputProps: {
          artist: job.artist,
          title: job.title,
          catalog: job.catalog,
          year: job.year,
          audioUrl: audioFileUrl,
          paletteKey: job.palette_key as
            | 'violet'
            | 'mono'
            | 'ultra'
            | 'coronita',
        },
        onProgress: (pct) => {
          const overall = 5 + Math.round(pct * 0.85);
          updateJobProgress(jobId, overall);
        },
      });

      updateJobStatus(jobId, 'uploading', 92);
      logger.info({jobId}, 'Uploading to Supabase Storage');
      const upload = await uploadVideo(job.output_bucket, job.output_path, videoPath);

      setJobOutput(
        jobId,
        upload.publicUrl,
        result.durationSeconds,
        result.renderSeconds,
        upload.sizeBytes,
      );
      updateJobStatus(jobId, 'done', 100);

      const fresh = getJob(jobId)!;
      logger.info(
        {jobId, publicUrl: upload.publicUrl, renderSeconds: result.renderSeconds},
        'Job completed',
      );

      await fireWebhook(jobId, fresh.callback_url, {
        event: 'render.completed',
        job_id: jobId,
        external_ref: fresh.external_ref,
        status: 'done',
        video_url: upload.publicUrl,
        duration_seconds: result.durationSeconds,
        render_seconds: result.renderSeconds,
        file_size_bytes: upload.sizeBytes,
        attempted_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const message = (err as Error).message ?? 'Unknown error';
      const stack = (err as Error).stack ?? '';
      logger.error({jobId, err: message, stack}, 'Job failed');

      const isFinalAttempt = (bullJob.attemptsMade ?? 0) + 1 >= (bullJob.opts.attempts ?? 1);

      if (isFinalAttempt) {
        setJobError(jobId, 'render_failed', message);
        const fresh = getJob(jobId)!;
        await fireWebhook(jobId, fresh.callback_url, {
          event: 'render.failed',
          job_id: jobId,
          external_ref: fresh.external_ref,
          status: 'failed',
          error_code: 'render_failed',
          error_message: message,
          attempted_at: Math.floor(Date.now() / 1000),
        });
      }

      throw err;
    } finally {
      cleanWorkDir(jobId);
    }
  },
  {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 90 * 60_000,
    stalledInterval: 60_000,
  },
);

worker.on('completed', (job) =>
  logger.info({bullJobId: job.id}, 'BullMQ job completed'),
);
worker.on('failed', (job, err) =>
  logger.error({bullJobId: job?.id, err: err.message}, 'BullMQ job failed'),
);
worker.on('error', (err) => logger.error({err: err.message}, 'Worker error'));

const shutdown = async () => {
  logger.info('Worker shutting down');
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
