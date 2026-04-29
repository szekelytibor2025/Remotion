# YouTube Auto-Upload integráció — dashboard

> Ez a dokumentum a **dashboard csapat számára** készült, kiegészítésképp a
> [`DASHBOARD_INTEGRATION.md`](./DASHBOARD_INTEGRATION.md) mellé. A teljes
> workflow leírása: render → permanent Supabase Storage → automatikus YouTube
> upload napi rate limittel és optimal-time scheduling-gel.
>
> **A Visualizer API-t ez nem érinti** — minden a dashboard repóban
> implementálódik (server-side route handlerek + új Supabase táblák +
> egy óránkénti cron worker).

## Áttekintés

```
┌──────────────┐  HMAC webhook  ┌──────────────┐
│ Visualizer   │ ─────────────► │  Dashboard   │
│ API (render) │                │  /callback   │
└──────────────┘                │              │
                                │  ┌────────┐  │
                                │  │ release│  │
                                │  │ _videos│  │ ← MP4 public_url eltárolva (örökre)
                                │  └────────┘  │
                                │      │        │
                                │      ▼        │
                                │  ┌────────┐  │
                                │  │youtube_│  │ ← új job, scheduled_at = peak slot
                                │  │upload_ │  │
                                │  │queue   │  │
                                │  └────────┘  │
                                │      │        │
                                │  cron óránként│
                                │      │        │
                                │      ▼        │
                                │  ┌────────┐  │   YouTube Data API v3
                                │  │YT Upload│ ─────────────────────┐
                                │  │ worker  │                       │
                                │  └────────┘                       ▼
                                │              │            ┌──────────────┐
                                │  /admin/yt   │            │ Kessey YT    │
                                │  - OAuth     │ ◄───────── │ channel      │
                                │  - log/retry │            │ (1 csatorna) │
                                └──────────────┘            └──────────────┘
```

**Workflow:**
1. Render kész → webhook érkezik a dashboard-ra → `release_videos.status = 'done'`
2. **Trigger** automatikusan beilleszt egy `youtube_upload_queue` rekordot
   `status = 'pending'` és `scheduled_at = <next optimal slot>`-tal
3. Óránkénti cron job a `scheduled_at <= NOW()` és `status = 'pending'` jobok
   közül **napi 6-os rate limittel** kiválasztja a következőt
4. A worker letölti a videót Supabase Storage-ból → uploadolja YouTube-ra a
   tárolt OAuth refresh tokennel → menti a `youtube_video_id`-t
5. Ha az artist-nak van `youtube_playlist_id`, hozzáadja a playlist-hez

## 1. Permanent Supabase Storage

A `videos` bucket **örökre tartja a fájlokat**. Nincs lifecycle policy,
nincs auto-delete. A `release_videos.public_url` is állandó, mert public
bucket nem generál újra signed URL-t.

**Storage capacity tervezés:**

| Paraméter | Érték |
|---|---|
| Egy videó (4K@60fps, ~3-4 perc) | ~300-500 MB |
| Várható összméret 600 visszamenőleges track | ~240 GB |
| Évente új release-ek (~50/év) | ~25 GB/év |
| **Supabase Pro storage** | **100 GB included**, $0.021/GB/hó utána |

**Költségbecslés:**
- 240 GB indulás: 140 GB extra × $0.021 × 12 = **~$35/év** ($3/hó)
- 365 GB 5 év múlva: 265 GB extra × $0.021 × 12 = **~$67/év**

Ez teljesen kezelhető. **Nem kell külön Backblaze/S3.**

**Bucket beállítás** (már a `DASHBOARD_INTEGRATION.md`-ben szerepelt, csak
ismétlésként):
```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('videos', 'videos', true, 1073741824, ARRAY['video/mp4'])  -- 1GB limit
ON CONFLICT (id) DO NOTHING;
```

## 2. Új Supabase táblák

### 2.1 OAuth token tárolás

```sql
-- supabase/migrations/<timestamp>_youtube_oauth.sql

CREATE TABLE IF NOT EXISTS youtube_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_account_id text NOT NULL UNIQUE,        -- a Google sub claim
  google_email text NOT NULL,
  channel_id text NOT NULL,                       -- YT channel ID (UC...)
  channel_title text NOT NULL,

  access_token text NOT NULL,                     -- titkosítva (lent)
  refresh_token text NOT NULL,                    -- titkosítva (lent)
  scope text NOT NULL,
  token_type text NOT NULL DEFAULT 'Bearer',
  expires_at timestamptz NOT NULL,

  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_yt_oauth_active ON youtube_oauth_tokens(is_active) WHERE is_active = true;

ALTER TABLE youtube_oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "yt_oauth_admin_only"
  ON youtube_oauth_tokens FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin')
  );
```

> **Token titkosítás (kötelező!):** A `access_token`/`refresh_token`-t
> **NE plain text-ben** tároljátok. Használjatok app-szintű AES-256-GCM
> titkosítást egy `YT_TOKEN_ENCRYPTION_KEY` env-vel (32 bájt), pl.
> `node:crypto`-val. A meglévő dashboard kódbázisban valószínűleg már van
> erre helper, ha nincs, lent megírom.

### 2.2 Upload queue + scheduling

```sql
-- supabase/migrations/<timestamp>_youtube_upload_queue.sql

CREATE TABLE IF NOT EXISTS youtube_upload_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_video_id uuid NOT NULL REFERENCES release_videos(id) ON DELETE CASCADE UNIQUE,

  status text NOT NULL CHECK (status IN ('pending','uploading','done','failed','cancelled','skipped')) DEFAULT 'pending',
  scheduled_at timestamptz NOT NULL,
  attempted_at timestamptz,
  completed_at timestamptz,

  title text NOT NULL,
  description text NOT NULL,
  tags text[] DEFAULT '{}',
  privacy_status text NOT NULL DEFAULT 'public' CHECK (privacy_status IN ('public','unlisted','private')),
  category_id text NOT NULL DEFAULT '10',         -- 10 = Music
  playlist_id text,                                -- ha az artist-nak van

  youtube_video_id text,                           -- pl. dQw4w9WgXcQ
  youtube_url text,                                -- https://youtu.be/...

  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_yt_queue_pending ON youtube_upload_queue(scheduled_at)
  WHERE status = 'pending';
CREATE INDEX idx_yt_queue_release_video ON youtube_upload_queue(release_video_id);
```

### 2.3 Publish config — peak time, daily rate, playlists

```sql
-- supabase/migrations/<timestamp>_youtube_publish_config.sql

CREATE TABLE IF NOT EXISTS youtube_publish_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  daily_upload_limit integer NOT NULL DEFAULT 6,
  rolling_window_hours integer NOT NULL DEFAULT 24,

  -- Peak idősávok jsonb-ben, pl.:
  -- [
  --   {"day": "mon-fri", "from": "19:00", "to": "22:00"},
  --   {"day": "sat-sun", "from": "14:00", "to": "22:00"}
  -- ]
  publish_windows jsonb NOT NULL DEFAULT '[
    {"days": [1,2,3,4,5], "from": "19:00", "to": "22:00"},
    {"days": [0,6],       "from": "14:00", "to": "22:00"}
  ]'::jsonb,
  timezone text NOT NULL DEFAULT 'Europe/Budapest',

  -- Default templates
  title_template text NOT NULL DEFAULT '{Artist} - {Title} (Original Mix)',
  description_template text NOT NULL DEFAULT
'🎵 {Artist} - {Title}
📀 {Label} · {Catalog} · {Year}
📅 Release date: {ReleaseDate}

🔗 Listen on all platforms:
• Spotify: {SpotifyUrl}
• Apple Music: {AppleMusicUrl}
• Deezer: {DeezerUrl}
• Beatport: {BeatportUrl}

Follow Kessey Records:
• Instagram: https://instagram.com/kesseyrecords
• Facebook: https://facebook.com/kesseyrecords
• Website: https://kesseyrecords.hu

#{LabelTag} #{ArtistTag} #{GenreTag}

© {Year} Kessey Records. All rights reserved.',

  default_tags text[] DEFAULT ARRAY['kessey records', 'music', 'electronic'],

  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES profiles(user_id)
);

INSERT INTO youtube_publish_config (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE youtube_publish_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "yt_config_admin_only"
  ON youtube_publish_config FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin')
  );
```

### 2.4 Új mezők meglévő táblákhoz

```sql
-- supabase/migrations/<timestamp>_artists_youtube_extension.sql

ALTER TABLE artists
  ADD COLUMN youtube_playlist_id text,                 -- pl. PLxxxxxxxxxx
  ADD COLUMN spotify_artist_url text,
  ADD COLUMN apple_music_artist_url text,
  ADD COLUMN deezer_artist_url text,
  ADD COLUMN beatport_artist_url text,
  ADD COLUMN custom_youtube_tags text[];               -- artist-specifikus extra tag-ek

ALTER TABLE releases
  ADD COLUMN spotify_url text,
  ADD COLUMN apple_music_url text,
  ADD COLUMN deezer_url text,
  ADD COLUMN beatport_url text;

ALTER TABLE release_videos
  ADD COLUMN youtube_video_id text,
  ADD COLUMN youtube_url text,
  ADD COLUMN youtube_uploaded_at timestamptz;
```

## 3. Google OAuth setup

### 3.1 Google Cloud Console

1. **Új projekt** vagy meglévő használata: https://console.cloud.google.com/
2. **YouTube Data API v3** engedélyezése (APIs & Services → Library)
3. **OAuth consent screen** beállítása:
   - User type: **External** (ha nem Workspace)
   - App name: pl. "Kessey Records Dashboard"
   - Scopes: `youtube.upload`, `youtube.readonly`, `youtube` (playlist
     hozzáadáshoz), `userinfo.email`
   - **Test users**-be tedd be a CEO Gmail-jét amíg nincs verified app
4. **OAuth 2.0 Client ID** létrehozás (Web application):
   - Authorized redirect URI: `https://dashboard.kessey-records.hu/api/internal/youtube-oauth-callback`
   - Mentsd el a `client_id`-t és `client_secret`-et

> **Verification:** A `youtube.upload` scope-hoz a Google verification kell
> ahhoz, hogy ne csak test usereket fogadjon. Submit-olni kell a privacy
> policy URL-t és magyarázatot. Tipikusan 4-6 hét. Addig **csak a "test
> users" listában lévő Gmail accountok** tudnak bejelentkezni — ez
> elegendő, mert csak az admin használja.

### 3.2 Environment variables

A dashboard `.env`-be:

```bash
# Google OAuth
GOOGLE_OAUTH_CLIENT_ID=<a Google Console-ról>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=<a Google Console-ról>
GOOGLE_OAUTH_REDIRECT_URI=https://dashboard.kessey-records.hu/api/internal/youtube-oauth-callback

# OAuth token titkosítás (32 byte = 64 hex char)
YT_TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>

# A meglévő dashboard URL
NEXT_PUBLIC_APP_URL=https://dashboard.kessey-records.hu
```

## 4. Dashboard implementáció

### 4.1 Token titkosítási helper

Ha még nincs ilyen a dashboardban:

```ts
// src/lib/crypto.ts
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

const KEY = Buffer.from(process.env.YT_TOKEN_ENCRYPTION_KEY!, 'hex');
if (KEY.length !== 32) throw new Error('YT_TOKEN_ENCRYPTION_KEY must be 32 bytes');

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
```

### 4.2 OAuth flow

```ts
// src/app/api/internal/youtube-oauth-start/route.ts
import {NextResponse} from 'next/server';
import {requireAdmin} from '@/lib/auth';

export async function GET() {
  await requireAdmin();

  const state = crypto.randomUUID();
  // CSRF védelem: state-et cookie-ba mentjük, callback ellenőrzi

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', process.env.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set('redirect_uri', process.env.GOOGLE_OAUTH_REDIRECT_URI!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' '));
  url.searchParams.set('access_type', 'offline');         // refresh token
  url.searchParams.set('prompt', 'consent');              // mindig kapjunk refresh tokent
  url.searchParams.set('state', state);

  const res = NextResponse.redirect(url.toString());
  res.cookies.set('yt_oauth_state', state, {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600,
  });
  return res;
}
```

```ts
// src/app/api/internal/youtube-oauth-callback/route.ts
import {NextResponse} from 'next/server';
import {createServiceClient} from '@/lib/supabase/server';
import {requireAdmin} from '@/lib/auth';
import {encrypt} from '@/lib/crypto';

export async function GET(req: Request) {
  await requireAdmin();

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = req.headers.get('cookie')?.match(/yt_oauth_state=([^;]+)/)?.[1];

  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/admin/youtube?error=invalid_state`);
  }

  // Code → token csere
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json() as {
    access_token: string; refresh_token: string;
    expires_in: number; scope: string; token_type: string;
  };

  if (!tokens.refresh_token) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/admin/youtube?error=no_refresh_token`);
  }

  // Channel info
  const channelRes = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',
    {headers: {Authorization: `Bearer ${tokens.access_token}`}},
  );
  const channelJson = await channelRes.json() as {
    items: Array<{id: string; snippet: {title: string}}>;
  };
  const channel = channelJson.items[0];
  if (!channel) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/admin/youtube?error=no_channel`);
  }

  // User email
  const userInfo = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {Authorization: `Bearer ${tokens.access_token}`},
  }).then((r) => r.json()) as {sub: string; email: string};

  const supabase = createServiceClient();
  await supabase.from('youtube_oauth_tokens').upsert({
    google_account_id: userInfo.sub,
    google_email: userInfo.email,
    channel_id: channel.id,
    channel_title: channel.snippet.title,
    access_token: encrypt(tokens.access_token),
    refresh_token: encrypt(tokens.refresh_token),
    scope: tokens.scope,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    is_active: true,
    updated_at: new Date().toISOString(),
  }, {onConflict: 'google_account_id'});

  // Korábbiakat deaktiváljuk (csak egy aktív account egyszerre)
  await supabase
    .from('youtube_oauth_tokens')
    .update({is_active: false})
    .neq('google_account_id', userInfo.sub);

  return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/admin/youtube?success=1`);
}
```

### 4.3 YouTube API kliens (token refresh-szel)

```ts
// src/lib/youtube-client.ts
import {createServiceClient} from './supabase/server';
import {encrypt, decrypt} from './crypto';

type Tokens = {
  google_account_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

export async function getActiveYoutubeAccessToken(): Promise<string> {
  const supabase = createServiceClient();
  const {data} = await supabase
    .from('youtube_oauth_tokens')
    .select('google_account_id, access_token, refresh_token, expires_at')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (!data) throw new Error('No active YouTube account connected');

  const tokens = data as Tokens;
  const expiresAt = new Date(tokens.expires_at).getTime();
  const now = Date.now();

  // Ha 5 percen belül lejár, refresh-eljük
  if (expiresAt - now > 5 * 60_000) {
    return decrypt(tokens.access_token);
  }

  const refreshed = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: decrypt(tokens.refresh_token),
      grant_type: 'refresh_token',
    }),
  });

  if (!refreshed.ok) {
    throw new Error(`Token refresh failed: ${await refreshed.text()}`);
  }

  const newTokens = await refreshed.json() as {
    access_token: string; expires_in: number;
  };

  await supabase
    .from('youtube_oauth_tokens')
    .update({
      access_token: encrypt(newTokens.access_token),
      expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('google_account_id', tokens.google_account_id);

  return newTokens.access_token;
}
```

### 4.4 Video upload — resumable upload

A YouTube `videos.insert` resumable upload-ot vár nagy fájlokra. Egyszerű
egyfázisú formátumban:

```ts
// src/lib/youtube-upload.ts
import {getActiveYoutubeAccessToken} from './youtube-client';

type UploadInput = {
  videoUrl: string;          // Supabase public URL
  title: string;
  description: string;
  tags: string[];
  categoryId: string;        // '10' = Music
  privacyStatus: 'public' | 'unlisted' | 'private';
  playlistId?: string | null;
};

type UploadResult = {
  videoId: string;
  url: string;
};

export async function uploadVideoToYoutube(input: UploadInput): Promise<UploadResult> {
  const accessToken = await getActiveYoutubeAccessToken();

  // 1. Letöltjük a videót Supabase-ből egy stream-be
  const videoRes = await fetch(input.videoUrl);
  if (!videoRes.ok) throw new Error(`Video fetch failed: ${videoRes.status}`);
  const contentLength = videoRes.headers.get('content-length');
  if (!contentLength) throw new Error('Video size unknown');

  // 2. Resumable upload init
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': contentLength,
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: {
          title: input.title.slice(0, 100),               // YT max
          description: input.description.slice(0, 5000),  // YT max
          tags: input.tags.slice(0, 30).map((t) => t.slice(0, 30)),
          categoryId: input.categoryId,
        },
        status: {
          privacyStatus: input.privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      }),
    },
  );

  if (!initRes.ok) {
    throw new Error(`Upload init failed: ${initRes.status} ${await initRes.text()}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('No upload URL returned');

  // 3. Streamelt feltöltés
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': contentLength,
    },
    body: videoRes.body,
    // @ts-expect-error -- Node fetch needs duplex for streams
    duplex: 'half',
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  const result = await uploadRes.json() as {id: string};

  // 4. Playlist hozzáadás (ha van)
  if (input.playlistId) {
    await addToPlaylist(accessToken, result.id, input.playlistId);
  }

  return {
    videoId: result.id,
    url: `https://youtu.be/${result.id}`,
  };
}

async function addToPlaylist(
  accessToken: string,
  videoId: string,
  playlistId: string,
): Promise<void> {
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: {kind: 'youtube#video', videoId},
        },
      }),
    },
  );

  if (!res.ok) {
    // Nem dobunk hibát — a videó már fent van, csak a playlist add ment ki
    console.error(`Playlist add failed (${playlistId}): ${await res.text()}`);
  }
}
```

### 4.5 Trigger: render kész → queue-ba

Két opció — ami stabilabb: **Postgres trigger** a `release_videos` táblán,
ami automatikusan beilleszt egy `youtube_upload_queue` sort, amikor a
`status` `done`-ra vált:

```sql
-- supabase/migrations/<timestamp>_youtube_auto_enqueue_trigger.sql

CREATE OR REPLACE FUNCTION enqueue_youtube_upload()
RETURNS TRIGGER AS $$
DECLARE
  v_artist artists%ROWTYPE;
  v_release releases%ROWTYPE;
  v_track tracks%ROWTYPE;
  v_config youtube_publish_config%ROWTYPE;
  v_title text;
  v_description text;
  v_scheduled timestamptz;
  v_tags text[];
BEGIN
  IF NEW.status <> 'done' OR OLD.status = 'done' THEN
    RETURN NEW;
  END IF;

  -- Skip ha már van queue entry
  IF EXISTS (SELECT 1 FROM youtube_upload_queue WHERE release_video_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_release FROM releases WHERE id = NEW.release_id;
  SELECT * INTO v_artist FROM artists WHERE id = v_release.primary_artist_id;
  SELECT * INTO v_track FROM tracks WHERE id = NEW.track_id;
  SELECT * INTO v_config FROM youtube_publish_config WHERE id = 1;

  -- Cím + leírás template-substitúció (egyszerű replace)
  v_title := v_config.title_template;
  v_title := replace(v_title, '{Artist}', COALESCE(v_artist.display_name, ''));
  v_title := replace(v_title, '{Title}', COALESCE(v_track.title, v_release.title, ''));
  v_title := replace(v_title, '{Year}', COALESCE(EXTRACT(YEAR FROM v_release.release_date)::text, ''));
  v_title := replace(v_title, '{Label}', COALESCE(v_release.label, 'Kessey Records'));
  v_title := replace(v_title, '{Catalog}', COALESCE(v_release.catalog_no, ''));

  v_description := v_config.description_template;
  v_description := replace(v_description, '{Artist}', COALESCE(v_artist.display_name, ''));
  v_description := replace(v_description, '{Title}', COALESCE(v_track.title, v_release.title, ''));
  v_description := replace(v_description, '{Year}', COALESCE(EXTRACT(YEAR FROM v_release.release_date)::text, ''));
  v_description := replace(v_description, '{Label}', COALESCE(v_release.label, 'Kessey Records'));
  v_description := replace(v_description, '{Catalog}', COALESCE(v_release.catalog_no, ''));
  v_description := replace(v_description, '{ReleaseDate}', COALESCE(to_char(v_release.release_date, 'YYYY-MM-DD'), ''));
  v_description := replace(v_description, '{SpotifyUrl}', COALESCE(v_release.spotify_url, v_artist.spotify_artist_url, ''));
  v_description := replace(v_description, '{AppleMusicUrl}', COALESCE(v_release.apple_music_url, v_artist.apple_music_artist_url, ''));
  v_description := replace(v_description, '{DeezerUrl}', COALESCE(v_release.deezer_url, v_artist.deezer_artist_url, ''));
  v_description := replace(v_description, '{BeatportUrl}', COALESCE(v_release.beatport_url, v_artist.beatport_artist_url, ''));
  v_description := replace(v_description, '{LabelTag}', regexp_replace(COALESCE(v_release.label, 'KesseyRecords'), '\W', '', 'g'));
  v_description := replace(v_description, '{ArtistTag}', regexp_replace(COALESCE(v_artist.display_name, ''), '\W', '', 'g'));
  v_description := replace(v_description, '{GenreTag}', regexp_replace(COALESCE(v_release.genre, 'Music'), '\W', '', 'g'));

  -- Tags: default + artist custom + genre
  v_tags := COALESCE(v_config.default_tags, '{}'::text[])
         || COALESCE(v_artist.custom_youtube_tags, '{}'::text[])
         || ARRAY[COALESCE(v_artist.display_name, ''), COALESCE(v_release.genre, '')];

  -- Scheduled time: a következő szabad slot a peak window-on belül
  v_scheduled := compute_next_youtube_slot(v_config);

  INSERT INTO youtube_upload_queue (
    release_video_id, status, scheduled_at,
    title, description, tags, privacy_status, category_id, playlist_id
  ) VALUES (
    NEW.id, 'pending', v_scheduled,
    v_title, v_description, v_tags, 'public', '10', v_artist.youtube_playlist_id
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enqueue_youtube_upload
  AFTER UPDATE ON release_videos
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_youtube_upload();
```

### 4.6 `compute_next_youtube_slot` SQL function

A scheduling logika: peak windowok + napi rate limit (rolling 24h):

```sql
CREATE OR REPLACE FUNCTION compute_next_youtube_slot(
  config youtube_publish_config
) RETURNS timestamptz AS $$
DECLARE
  v_tz text := config.timezone;
  v_now timestamptz := now();
  v_candidate timestamptz;
  v_uploads_in_window integer;
  v_slot_minutes integer;
  v_window jsonb;
  v_day_of_week integer;
  v_window_from time;
  v_window_to time;
  v_max_iterations integer := 14 * 24;  -- 2 hét lookahead
  v_i integer := 0;
BEGIN
  -- Kezdjünk a max(now, last_scheduled + slot_spacing)-tól
  SELECT COALESCE(MAX(scheduled_at), v_now) INTO v_candidate
  FROM youtube_upload_queue
  WHERE status IN ('pending','uploading');

  -- Slot spacing: 24h / daily_upload_limit, kerekítve egész percekre
  v_slot_minutes := GREATEST(60, (config.rolling_window_hours * 60) / config.daily_upload_limit);
  v_candidate := v_candidate + (v_slot_minutes || ' minutes')::interval;
  v_candidate := GREATEST(v_candidate, v_now + interval '5 minutes');

  -- Kerekítjük a következő 5-perces határra
  v_candidate := date_trunc('minute', v_candidate) +
                 (5 - EXTRACT(MINUTE FROM v_candidate)::integer % 5) * interval '1 minute';

  -- Biztos peak window-on belül
  WHILE v_i < v_max_iterations LOOP
    v_day_of_week := EXTRACT(DOW FROM (v_candidate AT TIME ZONE v_tz))::integer;

    FOR v_window IN SELECT * FROM jsonb_array_elements(config.publish_windows) LOOP
      IF v_window->'days' @> to_jsonb(v_day_of_week) THEN
        v_window_from := (v_window->>'from')::time;
        v_window_to := (v_window->>'to')::time;

        IF (v_candidate AT TIME ZONE v_tz)::time BETWEEN v_window_from AND v_window_to THEN
          -- Ellenőrizzük a rolling 24h limitet
          SELECT COUNT(*) INTO v_uploads_in_window
          FROM youtube_upload_queue
          WHERE status IN ('pending','uploading','done')
            AND scheduled_at BETWEEN v_candidate - (config.rolling_window_hours || ' hours')::interval
                                 AND v_candidate;

          IF v_uploads_in_window < config.daily_upload_limit THEN
            RETURN v_candidate;
          END IF;
        END IF;
      END IF;
    END LOOP;

    v_candidate := v_candidate + interval '15 minutes';
    v_i := v_i + 1;
  END LOOP;

  -- Ha 2 hét után sem találtunk, vissza a max+1 nap
  RETURN v_candidate;
END;
$$ LANGUAGE plpgsql;
```

### 4.7 Cron worker — óránként fut

**Vercel Cron** (ha Vercel-en van a dashboard):

```json
// vercel.json
{
  "crons": [
    {
      "path": "/api/internal/youtube-cron",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

Vagy **Supabase pg_cron**:

```sql
SELECT cron.schedule(
  'youtube-upload-tick',
  '*/15 * * * *',
  $$ SELECT net.http_post(
    url := 'https://dashboard.kessey-records.hu/api/internal/youtube-cron',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret'))
  ); $$
);
```

A handler:

```ts
// src/app/api/internal/youtube-cron/route.ts
import {NextResponse} from 'next/server';
import {createServiceClient} from '@/lib/supabase/server';
import {uploadVideoToYoutube} from '@/lib/youtube-upload';

const CRON_SECRET = process.env.CRON_SECRET!;

export async function POST(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({error: 'unauthorized'}, {status: 401});
  }

  const supabase = createServiceClient();

  // Egy job advisory lock-kal (concurrent cron run ellen)
  const {data: jobs} = await supabase
    .from('youtube_upload_queue')
    .select(`
      id, title, description, tags, privacy_status, category_id, playlist_id,
      release_videos!inner(public_url)
    `)
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', {ascending: true})
    .limit(1);

  if (!jobs || jobs.length === 0) {
    return NextResponse.json({uploaded: 0, message: 'no jobs ready'});
  }

  const job = jobs[0];

  // Atomikus átállítás 'uploading'-ra
  const {data: claimed, error: claimErr} = await supabase
    .from('youtube_upload_queue')
    .update({
      status: 'uploading',
      attempted_at: new Date().toISOString(),
      attempts: job.attempts + 1,
    })
    .eq('id', job.id)
    .eq('status', 'pending')         // optimistic lock
    .select()
    .maybeSingle();

  if (!claimed || claimErr) {
    return NextResponse.json({uploaded: 0, message: 'job already claimed'});
  }

  try {
    const result = await uploadVideoToYoutube({
      videoUrl: job.release_videos.public_url,
      title: job.title,
      description: job.description,
      tags: job.tags,
      categoryId: job.category_id,
      privacyStatus: job.privacy_status,
      playlistId: job.playlist_id,
    });

    await supabase.from('youtube_upload_queue').update({
      status: 'done',
      youtube_video_id: result.videoId,
      youtube_url: result.url,
      completed_at: new Date().toISOString(),
    }).eq('id', job.id);

    // Megjelöljük a release_videos-on is
    await supabase.from('release_videos').update({
      youtube_video_id: result.videoId,
      youtube_url: result.url,
      youtube_uploaded_at: new Date().toISOString(),
    }).eq('id', claimed.release_video_id);

    return NextResponse.json({uploaded: 1, video_id: result.videoId});
  } catch (err) {
    const message = (err as Error).message;
    await supabase.from('youtube_upload_queue').update({
      status: claimed.attempts >= 3 ? 'failed' : 'pending',
      error_code: 'upload_failed',
      error_message: message.slice(0, 1000),
      // Retry: 1 óra múlva
      scheduled_at: claimed.attempts >= 3
        ? claimed.scheduled_at
        : new Date(Date.now() + 60 * 60_000).toISOString(),
    }).eq('id', job.id);

    return NextResponse.json({uploaded: 0, error: message}, {status: 500});
  }
}
```

> **Quota védelem:** YouTube `videos.insert` ~1600 unit. Napi 6 upload =
> 9600 unit, kényelmesen a 10 000-es default alatt. Ha mégis átlépnéd
> (pl. retry miatt), a Google `403 quotaExceeded` választ ad → a hiba
> üzenetből detektálni kell és **automatikusan elhalasztani 24 órával**:

```ts
if (message.includes('quotaExceeded')) {
  await supabase.from('youtube_upload_queue').update({
    status: 'pending',
    scheduled_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    error_code: 'quota_exceeded',
    error_message: 'Daily quota exceeded, retrying tomorrow',
  }).eq('id', job.id);
}
```

### 4.8 Optimal time API (jövőbeli enhancement)

> A felhasználó említette: *"lekérni API-n mikor a legaktívabbak majd a
> csatorna nézői és annak megfelelően kirakni mindig amikor a
> legaktívabbak"*. Ez a **YouTube Analytics API** lehetőség.

A `youtube.readonly` scope-pal lekérhető az `audienceWatchRatio` per óra:

```ts
// src/lib/youtube-analytics.ts
export async function getOptimalPublishHours(): Promise<{
  weekday: number[];   // [hour1, hour2, ...] sorted by activity
  weekend: number[];
}> {
  const accessToken = await getActiveYoutubeAccessToken();

  // Last 28 days viewer activity
  const startDate = new Date(Date.now() - 28 * 86400_000).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);

  const res = await fetch(
    `https://youtubeanalytics.googleapis.com/v2/reports?` +
    new URLSearchParams({
      ids: 'channel==MINE',
      startDate, endDate,
      metrics: 'views',
      dimensions: 'day,hour',
      sort: '-views',
    }),
    {headers: {Authorization: `Bearer ${accessToken}`}},
  );

  const data = await res.json() as {rows: [string, number, number][]};
  // Aggregálás óránként hétköznap vs hétvége
  // ... (detailed implementation)

  return {weekday: [], weekend: []};
}
```

**Implementáció később** — egyelőre a fix `19:00–22:00 hétköznap` /
`14:00–22:00 hétvége` window-okat lehet használni a `youtube_publish_config`
alapján. A user szerkesztheti az adminban.

## 5. Új admin oldalak

### 5.1 `/admin/youtube` — OAuth + config

**Tartalom:**
- Aktív OAuth account info (csatorna név, email, csatlakozás dátuma)
- "YouTube fiók csatlakoztatása" gomb → `/api/internal/youtube-oauth-start`
- Disconnect gomb (`is_active = false`)
- Publish config szerkesztő:
  - Daily upload limit (alapból 6)
  - Peak windows (jsonb editor: nap + tól-ig)
  - Title template (textarea)
  - Description template (textarea)
  - Default tags (chips input)

### 5.2 `/admin/youtube/queue` — Queue state

- Pending jobs scheduled_at-szal sortolva
- Uploading (általában 0-1)
- Failed (retry gomb)
- Done (utolsó 100, YT linkkel)
- Manual override gombok:
  - "Skip" (status = `cancelled`)
  - "Reschedule" (új `scheduled_at`)
  - "Upload now" (azonnali upload, manual cron trigger)

### 5.3 `/admin/youtube/playlists` — Artist ↔ Playlist mapping

Egyszerű form:
- Artist lista display_name + jelenlegi `youtube_playlist_id`
- Egy gomb "YouTube playlistek lekérése" — `playlists.list?mine=true`
- Dropdown a kiválasztáshoz, mentés

## 6. Backfill workflow — 600 régi track

A `DASHBOARD_INTEGRATION.md` `6a` pontjában lévő render backfill
**automatikusan kiváltja a YouTube uploadot is** a Postgres trigger miatt.
Vagyis:

1. Indítod a render backfill scriptet
2. ~12 nap alatt minden track render-elődik
3. Ahogy minden render `done`-ra vált, a trigger beilleszt egy
   `youtube_upload_queue` sort `scheduled_at` = `next_optimal_slot()`
4. A cron 15-percenként kiveszi a következőt
5. Napi 6 upload sebességgel **600 / 6 = 100 nap** = ~3.3 hónap

**Kontroll:** ha sok job van pending-ben, az admin oldalon látszani fog,
hogy mi mikor megy ki. Bármikor `cancelled`-be lehet állítani vagy
preview-zni a címet/leírást.

## 7. UX a release detail oldalon

A release oldalon a "Videó" sekcióhoz adjátok hozzá:

```tsx
{video?.status === 'done' && !video.youtube_url && queueEntry?.status === 'pending' && (
  <div className="bg-amber-500/[0.06] border border-amber-500/15 rounded-xl p-4">
    <p className="text-amber-300 text-[13px]">
      YouTube-ra ütemezve: {formatDate(queueEntry.scheduled_at)}
    </p>
    <p className="text-muted text-[11px] mt-1">
      Cím: {queueEntry.title}
    </p>
    <button onClick={() => uploadNow(queueEntry.id)} className="...">
      Azonnali feltöltés
    </button>
  </div>
)}

{video?.youtube_url && (
  <a href={video.youtube_url} target="_blank" className="...">
    Megtekintés YouTube-on →
  </a>
)}
```

## 8. Biztonsági checklist

- [ ] `GOOGLE_OAUTH_CLIENT_SECRET` csak server-side env
- [ ] `YT_TOKEN_ENCRYPTION_KEY` minimum 32 byte (`openssl rand -hex 32`)
- [ ] `CRON_SECRET` random, csak a Vercel/cron-rendszer tudja
- [ ] OAuth state cookie httpOnly + secure
- [ ] OAuth callback CSRF-validált
- [ ] OAuth `access_type=offline` és `prompt=consent` — különben nem kapsz refresh tokent
- [ ] `youtube_oauth_tokens` táblán RLS, csak admin lát
- [ ] Token refresh előtt min 5 perc buffer (clock skew)
- [ ] Retry limit (3 attempt) — különben quota-éhes loop
- [ ] Webhook + cron endpoint **bypass-olja** a `middleware.ts` auth-ot, de
      saját secret-tel védve

## 9. Verifikáció

```bash
# 1. OAuth bejelentkezés tesztelése
# Böngészőben: https://dashboard.kessey-records.hu/admin/youtube
# → "Csatlakoztatás" → Google login → vissza a dashboardra "success=1"-gyel

# 2. Token check (az adminban)
SELECT google_email, channel_title, expires_at, last_used_at
FROM youtube_oauth_tokens WHERE is_active = true;

# 3. Manual trigger egy test release-en
INSERT INTO youtube_upload_queue (
  release_video_id, status, scheduled_at, title, description, tags
) VALUES (
  '<release_video_uuid>', 'pending', now(),
  'Test Upload', 'Test description', '{test}'::text[]
);

# 4. Cron manuális futtatása
curl -X POST https://dashboard.kessey-records.hu/api/internal/youtube-cron \
  -H "Authorization: Bearer $CRON_SECRET"
# Kell egy {"uploaded": 1, "video_id": "..."}

# 5. Ellenőrzés YouTube Studio-ban
# https://studio.youtube.com → Tartalom → ott a frissen feltöltött videó
```

## 10. Mit nem csinál ez a setup (ami később jöhet)

- **Custom thumbnail upload** — a felhasználó döntés szerint az auto thumbnail elég
- **YouTube Analytics-alapú dynamic optimal-time** — manuálisan beállítható
  most, később bővíthető a §4.8 alapján
- **Több YouTube channel** — most egy aktív account; a séma engedi a több
  account-ot, de a routing logikát később hozzá kell adni
- **End screens / cards** automatikus hozzáadása — manuális YouTube Studio
- **Comment moderation** — független YT funkció

---

A teljes integráció **kódmódosítást nem igényel a `kessey-records-visualizer`
repóban**. Mindezt a dashboard repóban kell implementálni. Kérdés esetén a
Visualizer API-t lehet bővíteni (pl. ha YouTube-specifikus visualizer template
kell), de a YouTube workflow tisztán a dashboard felelőssége.
