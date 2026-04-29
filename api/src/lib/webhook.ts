import {createHmac} from 'node:crypto';
import {env} from './env.js';
import {logger} from './logger.js';

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

export type WebhookPayload = {
  event: 'render.completed' | 'render.failed';
  job_id: string;
  external_ref: string | null;
  status: 'done' | 'failed';
  video_url?: string;
  error_code?: string;
  error_message?: string;
  duration_seconds?: number;
  render_seconds?: number;
  file_size_bytes?: number;
  attempted_at: number;
};

export const signPayload = (rawBody: string, timestamp: number): string => {
  const message = `${timestamp}.${rawBody}`;
  return createHmac('sha256', env.WEBHOOK_HMAC_SECRET).update(message).digest('hex');
};

export const sendWebhook = async (
  callbackUrl: string,
  payload: WebhookPayload,
): Promise<{ok: boolean; status?: number; error?: string}> => {
  const rawBody = JSON.stringify(payload);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signPayload(rawBody, timestamp);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-KRV-Signature': `t=${timestamp},v1=${signature}`,
          'X-KRV-Event': payload.event,
          'User-Agent': 'kessey-records-visualizer/1.0',
        },
        body: rawBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        logger.info(
          {jobId: payload.job_id, attempt, status: res.status},
          'Webhook delivered',
        );
        return {ok: true, status: res.status};
      }

      logger.warn(
        {jobId: payload.job_id, attempt, status: res.status},
        'Webhook returned non-2xx, will retry',
      );

      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return {ok: false, status: res.status, error: `Client error ${res.status}`};
      }
    } catch (err) {
      logger.warn(
        {jobId: payload.job_id, attempt, err: (err as Error).message},
        'Webhook delivery error, will retry',
      );
    }

    const delay = RETRY_DELAYS_MS[attempt] ?? 600_000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  logger.error({jobId: payload.job_id}, 'Webhook delivery failed after all retries');
  return {ok: false, error: 'Max retries exceeded'};
};
