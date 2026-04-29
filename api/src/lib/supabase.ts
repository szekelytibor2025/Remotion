import {createClient, SupabaseClient} from '@supabase/supabase-js';
import fs from 'node:fs';
import {env} from './env.js';
import {logger} from './logger.js';

let client: SupabaseClient | null = null;

export const supabase = (): SupabaseClient => {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {persistSession: false},
    });
  }
  return client;
};

export const uploadVideo = async (
  bucket: string,
  path: string,
  filePath: string,
): Promise<{publicUrl: string; sizeBytes: number}> => {
  const buffer = fs.readFileSync(filePath);
  const sizeBytes = buffer.byteLength;

  const {error: uploadErr} = await supabase()
    .storage.from(bucket)
    .upload(path, buffer, {
      contentType: 'video/mp4',
      upsert: true,
    });

  if (uploadErr) {
    logger.error({err: uploadErr, bucket, path}, 'Supabase upload failed');
    throw new Error(`Supabase upload failed: ${uploadErr.message}`);
  }

  const {data} = supabase().storage.from(bucket).getPublicUrl(path);
  return {publicUrl: data.publicUrl, sizeBytes};
};

export const downloadAudio = async (
  audioUrl: string,
  destPath: string,
): Promise<void> => {
  const res = await fetch(audioUrl);
  if (!res.ok) {
    throw new Error(`Audio download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
};
