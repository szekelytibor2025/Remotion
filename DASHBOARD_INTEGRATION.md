# Dashboard ↔ Visualizer API integráció

> Ez a dokumentum a **dashboard csapat számára** készült. Leírja, hogyan kell a
> meglévő Next.js dashboard-ot összekötni a `kessey-records-visualizer-api`
> szolgáltatással. **A dashboard kódját ez a repo nem módosítja** — ez csak
> útmutató arra, hogy ti hogyan tudtok integrálni.
>
> Az API forráskód: `api/` mappa a `kessey-records-visualizer` repóban.
>
> **Kapcsolódó dokumentum:** [`YOUTUBE_INTEGRATION.md`](./YOUTUBE_INTEGRATION.md)
> — auto-publish workflow YouTube-ra (OAuth, queue, cron, playlistek). Ez a
> doksi a render+storage részt írja le, a YouTube-os rész azon kívül van.

## Áttekintés

```
┌─────────────────┐      Bearer auth     ┌─────────────────────┐
│  Dashboard      │ ───────────────────► │  Visualizer API     │
│  (Next.js)      │   POST /api/v1/render │  (OVH VPS · Docker) │
│                 │                       │                     │
│                 │   202 + job_id        │  • Express          │
│                 │ ◄─────────────────────│  • BullMQ + Redis   │
│                 │                       │  • Remotion         │
│                 │                       │  • Supabase upload  │
│  /api/internal/ │                       │                     │
│  render-callback│ ◄─── HMAC webhook ────│                     │
│                 │   POST + signature    │                     │
└─────────────────┘                       └─────────────────────┘
        │                                           │
        └───────────► Supabase Storage ◄───────────┘
                  (bucket: tracks, videos)
```

**Workflow:**

1. A dashboard generál egy **signed URL**-t a Supabase-en a track WAV-jára
   (legalább 2 órás expiry — bőven elég 30 perces renderhez).
2. A dashboard POST-ol a Visualizer API-ra `audio_url` + track metaadatokkal,
   plusz egy `external_ref` (a `releases.id` UUID) és `callback_url`.
3. Az API azonnal `202` választ ad egy `job_id`-vel, és berakja a queue-ba.
4. Mikor a render kész, a worker feltölti az MP4-et a dashboard
   **saját Supabase Storage-jébe** (`videos` bucket), majd a dashboard
   `callback_url`-jére küld egy **HMAC-aláírt webhook**-ot a public URL-lel.
5. A dashboard a webhook-ban kapott `external_ref`-fel megtalálja a release-t,
   és elmenti a `video_url`-t (ehhez egy új tábla kell — lásd lent).

## 1. Új tábla a dashboard sémába: `release_videos`

A meglévő séma alapján (`releases` tábla már van) javasolt új tábla a
videók nyilvántartására. Ez **nem a Visualizer API DB-je** — ez a
dashboard saját Supabase Postgres-e.

```sql
-- supabase/migrations/<timestamp>_release_videos.sql

CREATE TABLE IF NOT EXISTS release_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  track_id uuid REFERENCES tracks(id) ON DELETE SET NULL,

  external_job_id text NOT NULL UNIQUE,         -- a Visualizer API job_id
  status text NOT NULL CHECK (status IN ('queued','rendering','done','failed')) DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0,

  palette_key text NOT NULL,                    -- 'violet' | 'mono' | 'ultra' | 'coronita'
  storage_bucket text NOT NULL DEFAULT 'videos',
  storage_path text NOT NULL,
  public_url text,

  duration_seconds real,
  file_size_bytes bigint,
  render_seconds real,

  error_code text,
  error_message text,

  requested_by uuid REFERENCES profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX idx_release_videos_release ON release_videos(release_id);
CREATE INDEX idx_release_videos_status ON release_videos(status);

-- RLS: csak staff/admin lát/módosít
ALTER TABLE release_videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "release_videos_staff_read"
  ON release_videos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
        AND profiles.role IN ('admin', 'staff')
    )
  );

CREATE POLICY "release_videos_staff_write"
  ON release_videos FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
        AND profiles.role IN ('admin', 'staff')
    )
  );
```

## 2. Új mező az `artists` táblába: per-artist default paletta

Ahogy a felhasználó említette: *"artist-tól függően lesz beállítva hogy
milyen template lesz"*. Ehhez egy új oszlop:

```sql
-- supabase/migrations/<timestamp>_artists_visualizer_palette.sql

ALTER TABLE artists
  ADD COLUMN visualizer_palette_key text
    CHECK (visualizer_palette_key IN ('violet','mono','ultra','coronita'))
    DEFAULT 'violet';

-- pl. Coronita kiadványoknál:
-- UPDATE artists SET visualizer_palette_key = 'coronita' WHERE display_name ILIKE '%coronita%';
```

A render kérésnél ezt használjátok defaultnak; az API-hívásnál egy override
prop is mehet (ha pl. egy konkrét release más palettát kap).

## 3. Supabase Storage bucket: `videos` (PERMANENT — soha nem törlünk)

Új bucket kell a renderelt videóknak. **A Visualizer API ide tölt fel
service-role kulccsal** (lentebb env beállítás).

> **Fontos:** A videók **örökre** itt maradnak. Nincs lifecycle rule,
> nincs auto-delete, nincs cold storage transition. A `release_videos.public_url`
> állandó, mert public bucket egyszer feltöltött fájlt nem ír felül és nem
> töröl magától.
>
> **Capacity tervezés:** ~300-500 MB / videó (4K@60fps, ~3-4 perc). 600
> visszamenőleges track ≈ 240 GB, évente +25 GB. Supabase Pro tier 100 GB
> included, $0.021/GB/hó utána → ~$3-6/hó storage költség kezdetben.
> Részletek a [`YOUTUBE_INTEGRATION.md` §1](./YOUTUBE_INTEGRATION.md#1-permanent-supabase-storage)-ben.

```sql
-- supabase/migrations/<timestamp>_videos_bucket.sql

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('videos', 'videos', true, 1073741824, ARRAY['video/mp4'])  -- 1 GB / fájl limit, public, permanent
ON CONFLICT (id) DO NOTHING;

-- Public read (mindenki láthatja a generált videókat)
CREATE POLICY "videos_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'videos');

-- Csak service-role írhat (a Visualizer API ezt használja)
-- A service-role amúgy is bypassolja az RLS-t, de explicit policy:
CREATE POLICY "videos_service_write"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'videos' AND auth.role() = 'service_role');
```

> Ha a kiadott videók **nem nyilvánosak** kell legyenek (csak bejelentkezett
> dashboardban látsszanak), akkor `public: false` és olvasási policy-t adjatok
> hozzá `auth.role() = 'authenticated'`-tal. Akkor a webhookban kapott
> `video_url` helyett a dashboard saját signed URL-t generál minden megnyitáshoz.

## 4. Environment variables a dashboard-on

A dashboard `.env`-jébe (Vercel / OVH-os Next.js env-ekbe is):

```bash
# Visualizer API hívásához
VISUALIZER_API_URL=https://render.kessey-records.hu
VISUALIZER_API_KEY=krv_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Webhook signature verifikációhoz (UGYANAZ a string, mint a Visualizer API
# WEBHOOK_HMAC_SECRET-je — egyeztessétek!)
VISUALIZER_WEBHOOK_SECRET=<random_32_char_minimum>

# A dashboard saját Supabase URL-je és service key-e már megvan a meglévő
# .env-ben — ezt a Visualizer API is megkapja, hogy ide töltse a videókat
```

A Visualizer API `.env`-jébe a server-en:

```bash
SUPABASE_URL=<dashboard saját Supabase URL>
SUPABASE_SERVICE_ROLE_KEY=<dashboard saját service-role key>
SUPABASE_VIDEO_BUCKET=videos
WEBHOOK_HMAC_SECRET=<ugyanaz a 32+ char string mint a dashboard-on>
```

## 5. Kliens kód a dashboardban — két útvonal

### 5a. `POST /api/internal/render-request` (új, dashboardban implementálandó)

Server-side route a dashboardban, ami a Visualizer API-t hívja. **A Bearer
tokent NE küldjétek a kliensbe** — kizárólag server-side (route handler vagy
server action) használhatja.

```ts
// src/app/api/internal/render-request/route.ts (Next.js App Router)
import {NextResponse} from 'next/server';
import {createServiceClient} from '@/lib/supabase/server';
import {requireStaff} from '@/lib/auth';

const VISUALIZER_API_URL = process.env.VISUALIZER_API_URL!;
const VISUALIZER_API_KEY = process.env.VISUALIZER_API_KEY!;

export async function POST(req: Request) {
  await requireStaff();  // RBAC

  const body = await req.json();
  const {release_id, track_id, palette_override} = body;

  const supabase = createServiceClient();

  // 1. Release + track + artist + audio path lekérése
  const {data: track} = await supabase
    .from('tracks')
    .select(`
      id, title, audio_url, duration_seconds,
      releases!inner(id, catalog_no, release_date,
        artists!inner(id, display_name, visualizer_palette_key))
    `)
    .eq('id', track_id)
    .single();

  if (!track) return NextResponse.json({error: 'track_not_found'}, {status: 404});

  const release = track.releases;
  const artist = release.artists;

  // 2. Signed URL generálás a WAV-hoz (2 óra)
  const audioStoragePath = track.audio_url; // pl. "tracks/DEH742203420.wav"
  const {data: signed, error: signErr} = await supabase
    .storage.from('tracks')
    .createSignedUrl(audioStoragePath, 7200);

  if (signErr || !signed) {
    return NextResponse.json({error: 'audio_signing_failed'}, {status: 500});
  }

  // 3. Output path eldöntése
  const outputPath = `${release.catalog_no.toLowerCase().replace(/\W+/g, '-')}/${track.id}.mp4`;
  const palette = palette_override ?? artist.visualizer_palette_key ?? 'violet';

  // 4. Visualizer API hívása
  const renderRes = await fetch(`${VISUALIZER_API_URL}/api/v1/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VISUALIZER_API_KEY}`,
    },
    body: JSON.stringify({
      artist: artist.display_name,
      title: track.title,
      catalog: release.catalog_no,
      year: new Date(release.release_date).getFullYear().toString(),
      audio_url: signed.signedUrl,
      palette_key: palette,
      output_bucket: 'videos',
      output_path: outputPath,
      external_ref: release.id,
      callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/internal/render-callback`,
    }),
  });

  if (!renderRes.ok) {
    const err = await renderRes.json().catch(() => ({}));
    return NextResponse.json({error: 'render_api_failed', details: err}, {status: 502});
  }

  const renderJob = await renderRes.json();

  // 5. Saját DB-be is mentjük
  await supabase.from('release_videos').insert({
    release_id: release.id,
    track_id: track.id,
    external_job_id: renderJob.job_id,
    status: 'queued',
    palette_key: palette,
    storage_bucket: 'videos',
    storage_path: outputPath,
    requested_by: (await supabase.auth.getUser()).data.user?.id,
  });

  return NextResponse.json({job_id: renderJob.job_id, status: 'queued'});
}
```

### 5b. `POST /api/internal/render-callback` (új, webhook fogadó)

Ez fogadja a Visualizer API HMAC-aláírt webhookjait.

```ts
// src/app/api/internal/render-callback/route.ts
import {NextResponse} from 'next/server';
import crypto from 'node:crypto';
import {createServiceClient} from '@/lib/supabase/server';

const SECRET = process.env.VISUALIZER_WEBHOOK_SECRET!;

export async function POST(req: Request) {
  const signatureHeader = req.headers.get('x-krv-signature');
  if (!signatureHeader) {
    return NextResponse.json({error: 'missing_signature'}, {status: 401});
  }

  const rawBody = await req.text();

  // signature: "t=<timestamp>,v1=<hex>"
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => kv.split('='))
  );
  const ts = parts.t;
  const sig = parts.v1;
  if (!ts || !sig) {
    return NextResponse.json({error: 'malformed_signature'}, {status: 401});
  }

  // Replay védelem: 5 percnél régebbi requestet eldobunk
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(ts);
  if (ageSeconds > 300 || ageSeconds < -60) {
    return NextResponse.json({error: 'expired'}, {status: 401});
  }

  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`${ts}.${rawBody}`)
    .digest('hex');

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(sig, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return NextResponse.json({error: 'invalid_signature'}, {status: 401});
  }

  const payload = JSON.parse(rawBody) as {
    event: 'render.completed' | 'render.failed';
    job_id: string;
    external_ref: string;
    status: 'done' | 'failed';
    video_url?: string;
    duration_seconds?: number;
    render_seconds?: number;
    file_size_bytes?: number;
    error_code?: string;
    error_message?: string;
  };

  const supabase = createServiceClient();

  if (payload.event === 'render.completed') {
    await supabase
      .from('release_videos')
      .update({
        status: 'done',
        progress: 100,
        public_url: payload.video_url ?? null,
        duration_seconds: payload.duration_seconds ?? null,
        render_seconds: payload.render_seconds ?? null,
        file_size_bytes: payload.file_size_bytes ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq('external_job_id', payload.job_id);
  } else {
    await supabase
      .from('release_videos')
      .update({
        status: 'failed',
        error_code: payload.error_code ?? 'unknown',
        error_message: payload.error_message ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq('external_job_id', payload.job_id);
  }

  // 200 OK — különben az API újrapróbálja
  return NextResponse.json({received: true});
}
```

**Fontos:** a webhook endpoint-nak `public` (nem auth-os) kell lennie, mert a
Visualizer API-nak nincs Supabase session-je. A védelmet a HMAC signature
adja. **Vegyétek ki ezt az URL-t a `middleware.ts` auth ellenőrzéséből**, vagy
helyezzétek be egy bypass listába.

## 6. Visszamenőleges batch render — 500-600 régi track

A felhasználó említette: *"500-600 kiadott zene amihez visszamenőleg kell majd
generálni videót"*. Erre két stratégia:

> **Megjegyzés:** Ha a YouTube auto-publish workflow be van kapcsolva
> (lásd [`YOUTUBE_INTEGRATION.md`](./YOUTUBE_INTEGRATION.md)), akkor a render
> kész állapotba kerülésekor **automatikusan beilleszt egy YouTube upload jobot**
> a `youtube_upload_queue`-ba a Postgres trigger segítségével. Vagyis ezt a
> batch render scriptet futtatva **mind a render mind a YT upload elindul**, és
> a napi 6-os YT rate limit miatt fokozatosan, ~3.3 hónap alatt fognak kikerülni
> a videók. Ha csak rendert akartok futtatni YouTube-ra publikálás nélkül,
> előbb **deaktiváljátok a triggert** (`ALTER TABLE release_videos DISABLE TRIGGER trg_enqueue_youtube_upload`),
> vagy a `youtube_upload_queue.status`-t manuálisan `'cancelled'`-re állítva
> letiltjátok az upload-ot.

### 6a. Egyszeri admin script

```ts
// scripts/backfill-videos.ts (a dashboard repo-jában futtatandó)
import {createServiceClient} from '@/lib/supabase/server';

const VISUALIZER_API_URL = process.env.VISUALIZER_API_URL!;
const VISUALIZER_API_KEY = process.env.VISUALIZER_API_KEY!;

const supabase = createServiceClient();

async function main() {
  // Minden track, aminek még nincs videója
  const {data: tracks} = await supabase
    .from('tracks')
    .select(`
      id, title, audio_url,
      releases!inner(id, catalog_no, release_date,
        artists!inner(display_name, visualizer_palette_key))
    `)
    .not('audio_url', 'is', null)
    .order('created_at', {ascending: true});

  if (!tracks) return;

  for (const track of tracks) {
    // skip ha már van done-status video
    const {data: existing} = await supabase
      .from('release_videos')
      .select('status')
      .eq('track_id', track.id)
      .in('status', ['done', 'queued', 'rendering'])
      .maybeSingle();

    if (existing) {
      console.log(`Skipping ${track.title} — already has ${existing.status} video`);
      continue;
    }

    console.log(`Enqueueing ${track.title}...`);
    const release = track.releases;
    const artist = release.artists;

    const {data: signed} = await supabase
      .storage.from('tracks')
      .createSignedUrl(track.audio_url, 86400); // 24 óra a batch-hez

    if (!signed) continue;

    const res = await fetch(`${VISUALIZER_API_URL}/api/v1/render`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VISUALIZER_API_KEY}`,
      },
      body: JSON.stringify({
        artist: artist.display_name,
        title: track.title,
        catalog: release.catalog_no,
        year: new Date(release.release_date).getFullYear().toString(),
        audio_url: signed.signedUrl,
        palette_key: artist.visualizer_palette_key ?? 'violet',
        output_bucket: 'videos',
        output_path: `${release.catalog_no.toLowerCase().replace(/\W+/g, '-')}/${track.id}.mp4`,
        external_ref: release.id,
        callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/internal/render-callback`,
      }),
    });

    if (!res.ok) {
      console.error(`  Failed: ${await res.text()}`);
      continue;
    }

    const job = await res.json();
    await supabase.from('release_videos').insert({
      release_id: release.id,
      track_id: track.id,
      external_job_id: job.job_id,
      status: 'queued',
      palette_key: artist.visualizer_palette_key ?? 'violet',
      storage_bucket: 'videos',
      storage_path: `${release.catalog_no.toLowerCase().replace(/\W+/g, '-')}/${track.id}.mp4`,
    });

    // throttle: max ~50 új job/perc, hogy a queue-t ne robbantsd szét
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch(console.error);
```

A queue-ban sorba állnak, és a worker (1 párhuzamos) sorra renderel. 600 ×
~30 perc ≈ **300 óra = ~12 nap** folyamatos rendereléssel. Ez elsőre soknak
hangzik, de érdemes egyszer elindítani és hagyni futni — semmi nem blokkol.

**Status monitoring batch közben:**
```bash
# A dashboardon egy admin oldalt érdemes csinálni, ami listázza:
SELECT
  COUNT(*) FILTER (WHERE status = 'queued')   AS queued,
  COUNT(*) FILTER (WHERE status = 'rendering') AS rendering,
  COUNT(*) FILTER (WHERE status = 'done')     AS done,
  COUNT(*) FILTER (WHERE status = 'failed')   AS failed,
  MIN(created_at) AS oldest_pending,
  MAX(finished_at) AS latest_finish
FROM release_videos;
```

### 6b. Lassan, ütemezve

Ha nem akarjátok 12 napig terhelni a VPS-t, futtassátok napi 50 trackes
batch-ekben (`LIMIT 50` a `tracks`-en). Akkor ~12 napon át reggelente indítjátok,
és dél körül kész.

## 7. UI változások a dashboardban (javaslatok)

Ezek mind opcionálisak, de valószínűleg kelleni fognak:

1. **Release detail oldal**: új sekció "Videó" gombbal
   - Ha van `release_videos.public_url` → embed `<video>` + download gomb
   - Ha `status = queued/rendering` → progress bar (pollozva minden 30 mp-en
     vagy `useEffect` + `EventSource`)
   - Ha nincs még → "Videó generálása" gomb, ami a `POST /api/internal/render-request`-et hívja
   - Paletta override dropdown (artist defaulttal)

2. **Artist detail oldal**: a `visualizer_palette_key` szerkesztő (admin only)

3. **Admin > Videók oldal**:
   - Listázza az összes `release_videos`-t status szerint
   - Failed job-okat manuálisan újra lehet indítani
   - Batch backfill indítása + folyamatban lévő státusz

## 8. Tesztelés

A Visualizer API-nak van `GET /health` endpointja:

```bash
curl https://render.kessey-records.hu/health
# {"ok":true,"checks":{"db":true,"redis":true},"timestamp":...}
```

Egy konkrét render dry-run:

```bash
curl -X POST https://render.kessey-records.hu/api/v1/render \
  -H "Authorization: Bearer $VISUALIZER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "artist":"R.DAWE & DANK.L","title":"Fortune Dream","catalog":"KSY—026","year":"2026",
    "audio_url":"https://your-supabase.co/storage/v1/object/sign/tracks/test.wav?token=...",
    "palette_key":"coronita","output_bucket":"videos","output_path":"test/fortune-dream.mp4",
    "external_ref":"test-001"
  }'
# {"job_id":"job_abc...","status":"queued","external_ref":"test-001","created_at":...}

curl https://render.kessey-records.hu/api/v1/render/job_abc... \
  -H "Authorization: Bearer $VISUALIZER_API_KEY"
```

## 9. Hibakezelés

| Visualizer API hiba | Mit csináljon a dashboard |
|---|---|
| `401` invalid API key | Logolni; admin értesítés (vsz. lejárt vagy revoked key) |
| `429` rate limit | Várni 1 percet, retry-olni; ha gyakori, növelni a key rate limit-jét |
| `400` validation | A request body hibás — fix a dashboard kódban |
| `500/503` | Retry exponential backoff-fal (3 attempt); ha tartós, monitor riasztás |
| Webhook nem érkezik 1 órán belül | Polling fallback `GET /api/v1/render/:job_id` |

## 10. Biztonság — checklist

- [ ] `VISUALIZER_API_KEY` **csak server-side env**, sosem `NEXT_PUBLIC_*`
- [ ] `VISUALIZER_WEBHOOK_SECRET` ugyanaz a stringa mint az API `WEBHOOK_HMAC_SECRET`
- [ ] Webhook endpoint **nem auth-os**, de signature-validált
- [ ] Webhook endpoint **timing-safe compare** (lásd a kódban)
- [ ] Webhook endpoint **timestamp-ellenőrzés** (5 perces ablak — replay védelem)
- [ ] Signed URL minimum 2 órás (de ne tovább, mint kell)
- [ ] `videos` bucket policy: csak service-role írhat
- [ ] `release_videos` RLS: csak staff/admin lát/módosít
- [ ] A Visualizer API URL HTTPS (Let's Encrypt) — soha plain HTTP

---

Ha kérdés merül fel, vagy a séma változik a dashboard oldalon (új mezők stb.),
**ne nyúljatok ehhez a Visualizer API-hoz** — egyszerűen küldjétek el az új
adatokat a meglévő `POST /api/v1/render` body-ban (extra mezők
ignorálódnak a Zod schema miatt). Ha új paletta vagy új template kell, az a
`remotion/` projekt változtatása, és onnan szól vissza, hogy a `palette_key`
enum bővüljön a Zod schemán is.
