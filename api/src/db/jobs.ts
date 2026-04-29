import {db} from './index.js';
import {randomUUID} from 'node:crypto';

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'rendering'
  | 'uploading'
  | 'done'
  | 'failed'
  | 'cancelled';

export type RenderJob = {
  id: string;
  status: JobStatus;
  progress: number;
  api_key_id: string;

  artist: string;
  title: string;
  catalog: string;
  year: string;
  audio_url: string;
  palette_key: string;

  output_bucket: string;
  output_path: string;
  public_url: string | null;

  external_ref: string | null;
  callback_url: string | null;

  error_message: string | null;
  error_code: string | null;
  attempts: number;

  created_at: number;
  started_at: number | null;
  finished_at: number | null;

  duration_seconds: number | null;
  render_seconds: number | null;
  file_size_bytes: number | null;
};

export type CreateJobInput = {
  api_key_id: string;
  artist: string;
  title: string;
  catalog: string;
  year: string;
  audio_url: string;
  palette_key: string;
  output_bucket: string;
  output_path: string;
  external_ref: string | null;
  callback_url: string | null;
};

export const createJob = (input: CreateJobInput): RenderJob => {
  const id = `job_${randomUUID().replace(/-/g, '')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO render_jobs (
      id, status, progress, api_key_id,
      artist, title, catalog, year, audio_url, palette_key,
      output_bucket, output_path, external_ref, callback_url,
      attempts, created_at
    ) VALUES (?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    input.api_key_id,
    input.artist,
    input.title,
    input.catalog,
    input.year,
    input.audio_url,
    input.palette_key,
    input.output_bucket,
    input.output_path,
    input.external_ref,
    input.callback_url,
    now,
  );
  return getJob(id)!;
};

export const getJob = (id: string): RenderJob | null => {
  const row = db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(id) as
    | RenderJob
    | undefined;
  return row ?? null;
};

export const updateJobStatus = (
  id: string,
  status: JobStatus,
  progress?: number,
) => {
  const now = Date.now();
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    db.prepare(
      `UPDATE render_jobs
         SET status = ?, progress = COALESCE(?, progress), finished_at = ?
       WHERE id = ?`,
    ).run(status, progress ?? null, now, id);
  } else if (status === 'rendering' || status === 'downloading') {
    db.prepare(
      `UPDATE render_jobs
         SET status = ?, progress = COALESCE(?, progress),
             started_at = COALESCE(started_at, ?)
       WHERE id = ?`,
    ).run(status, progress ?? null, now, id);
  } else {
    db.prepare(
      `UPDATE render_jobs
         SET status = ?, progress = COALESCE(?, progress)
       WHERE id = ?`,
    ).run(status, progress ?? null, id);
  }
};

export const updateJobProgress = (id: string, progress: number) => {
  db.prepare('UPDATE render_jobs SET progress = ? WHERE id = ?').run(
    Math.max(0, Math.min(100, Math.round(progress))),
    id,
  );
};

export const setJobError = (
  id: string,
  errorCode: string,
  errorMessage: string,
) => {
  db.prepare(
    `UPDATE render_jobs
       SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
     WHERE id = ?`,
  ).run(errorCode, errorMessage.slice(0, 2000), Date.now(), id);
};

export const incrementAttempts = (id: string) => {
  db.prepare('UPDATE render_jobs SET attempts = attempts + 1 WHERE id = ?').run(id);
};

export const setJobOutput = (
  id: string,
  publicUrl: string,
  durationSeconds: number,
  renderSeconds: number,
  fileSizeBytes: number,
) => {
  db.prepare(
    `UPDATE render_jobs
       SET public_url = ?, duration_seconds = ?, render_seconds = ?, file_size_bytes = ?
     WHERE id = ?`,
  ).run(publicUrl, durationSeconds, renderSeconds, fileSizeBytes, id);
};
