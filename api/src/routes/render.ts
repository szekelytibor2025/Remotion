import {Router} from 'express';
import {z} from 'zod';
import {requireApiKey} from '../lib/auth.js';
import {createJob, getJob} from '../db/jobs.js';
import {enqueueRenderJob} from '../queue/index.js';
import {logger} from '../lib/logger.js';

const router = Router();

// The visualiser ships a single brand-pure preset. Older clients may still
// send legacy palette names (violet/mono/ultra/coronita/funky-house); we
// transparently fold any incoming palette_key onto 'default' so the request
// never fails on an unknown value, and missing palette_key becomes 'default'.
const renderRequestSchema = z.object({
  artist: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  catalog: z.string().min(1).max(50),
  year: z.string().min(1).max(10),
  audio_url: z.string().url().max(2000),
  palette_key: z
    .string()
    .max(50)
    .optional()
    .transform(() => 'default' as const),
  output_bucket: z.string().min(1).max(100),
  output_path: z.string().min(1).max(500),
  external_ref: z.string().max(200).optional(),
  callback_url: z.string().url().max(2000).optional(),
});

router.post('/render', requireApiKey, async (req, res) => {
  const parsed = renderRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'Request body validation failed',
      issues: parsed.error.issues,
    });
  }

  const data = parsed.data;
  const apiKey = req.apiKey!;

  try {
    const job = createJob({
      api_key_id: apiKey.id,
      artist: data.artist,
      title: data.title,
      catalog: data.catalog,
      year: data.year,
      audio_url: data.audio_url,
      palette_key: data.palette_key,
      output_bucket: data.output_bucket,
      output_path: data.output_path,
      external_ref: data.external_ref ?? null,
      callback_url: data.callback_url ?? null,
    });
    await enqueueRenderJob(job.id);

    logger.info(
      {jobId: job.id, externalRef: data.external_ref, apiKey: apiKey.name},
      'Render job created',
    );

    return res.status(202).json({
      job_id: job.id,
      status: job.status,
      external_ref: job.external_ref,
      created_at: job.created_at,
    });
  } catch (err) {
    logger.error({err: (err as Error).message}, 'Failed to create render job');
    return res.status(500).json({
      error: 'internal_error',
      message: 'Failed to create render job',
    });
  }
});

router.get('/render/:jobId/progress', requireApiKey, (req, res) => {
  const jobIdParam = req.params.jobId;
  const jobId = typeof jobIdParam === 'string' ? jobIdParam : jobIdParam?.[0];
  if (!jobId) {
    return res.status(400).json({error: 'invalid_request', message: 'Missing jobId'});
  }
  const job = getJob(jobId);
  if (!job || job.api_key_id !== req.apiKey!.id) {
    return res.status(404).json({error: 'not_found', message: 'Job not found'});
  }

  const isTerminal =
    job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';

  return res.json({
    job_id: job.id,
    status: job.status,
    progress: job.status === 'done' ? 100 : job.progress,
    done: isTerminal,
  });
});

router.get('/render/:jobId', requireApiKey, (req, res) => {
  const jobIdParam = req.params.jobId;
  const jobId = typeof jobIdParam === 'string' ? jobIdParam : jobIdParam?.[0];
  if (!jobId) {
    return res.status(400).json({error: 'invalid_request', message: 'Missing jobId'});
  }
  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({error: 'not_found', message: 'Job not found'});
  }
  if (job.api_key_id !== req.apiKey!.id) {
    return res.status(404).json({error: 'not_found', message: 'Job not found'});
  }

  return res.json({
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    external_ref: job.external_ref,
    video_url: job.public_url,
    error: job.error_message
      ? {code: job.error_code, message: job.error_message}
      : null,
    duration_seconds: job.duration_seconds,
    render_seconds: job.render_seconds,
    file_size_bytes: job.file_size_bytes,
    attempts: job.attempts,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
  });
});

export default router;
