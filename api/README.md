# Kessey Records Visualizer API

HTTP API a Remotion-alapú RINGS music visualizer rendereléséhez. Bearer token auth, BullMQ queue, Supabase Storage upload, HMAC-aláírt webhook callback.

## Helyi indítás

```bash
cd api
cp .env.example .env
# töltsd ki: SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_HMAC_SECRET (random 32+ char)
npm install
docker run -d --name redis -p 6379:6379 redis:7-alpine
npm run migrate
npm run create-key -- "local-dev"
# két terminál:
npm run dev          # API (port 3001)
npm run dev:worker   # render worker
```

## Production deployment (Docker Compose)

```bash
cd ..  # repo root
cp api/.env.example api/.env
vim api/.env

docker compose up -d --build
docker compose logs -f api worker

# első API key létrehozása
docker compose exec api npm run create-key -- "kessey-dashboard"
```

## API endpointok

### `POST /api/v1/render`

Render job létrehozása. Bearer token kötelező.

```json
{
  "artist": "R.DAWE & DANK.L",
  "title": "Fortune Dream",
  "catalog": "KSY—026",
  "year": "2026",
  "audio_url": "https://....supabase.co/storage/v1/object/sign/tracks/track.wav?token=...",
  "palette_key": "coronita",
  "output_bucket": "videos",
  "output_path": "ksy-026/fortune-dream.mp4",
  "external_ref": "release_uuid_or_track_id",
  "callback_url": "https://dashboard.kessey.hu/api/internal/render-callback"
}
```

Válasz `202`:
```json
{"job_id": "job_...", "status": "queued", "external_ref": "...", "created_at": 1729...}
```

### `GET /api/v1/render/:jobId`

Job állapot lekérése (polling, ha nem akarsz webhookot).

### `GET /health`

Health check (DB + Redis ping). 200 / 503.

## Webhook payload

A worker `POST`-ot küld a `callback_url`-re render után:

```
POST <callback_url>
X-KRV-Signature: t=1729...,v1=<hex>
X-KRV-Event: render.completed
Content-Type: application/json
```

```json
{
  "event": "render.completed",
  "job_id": "job_...",
  "external_ref": "...",
  "status": "done",
  "video_url": "https://....supabase.co/storage/v1/object/public/videos/...",
  "duration_seconds": 208.0,
  "render_seconds": 1750.4,
  "file_size_bytes": 213442145,
  "attempted_at": 1729...
}
```

A signature ellenőrzése:

```ts
import crypto from 'node:crypto';
const [tsPart, sigPart] = req.headers['x-krv-signature'].split(',');
const ts = tsPart.split('=')[1];
const sig = sigPart.split('=')[1];
const expected = crypto.createHmac('sha256', WEBHOOK_HMAC_SECRET)
  .update(`${ts}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
```

## API key kezelés

```bash
docker compose exec api npm run create-key -- "név" 60   # 60 req/min limit
docker compose exec api npm run list-keys
docker compose exec api npm run revoke-key -- key_xxxxxxxx
```

## Hibák

| HTTP | Jelentés |
|---|---|
| 400 | Validation fail (Zod) |
| 401 | Hiányzó / érvénytelen Bearer token |
| 404 | Job nem létezik (vagy nem a hívó key-éhez tartozik) |
| 429 | Rate limit átlépve |
| 500 | Belső hiba |
| 503 | Health check bukott (DB/Redis le) |
