# DocuCut AI

Turns a narration (and optional script) into a documentary-style edit in the visual language of modern YouTube documentary / video-essay channels: AI visual research across licensed media sources, rights-aware selection, reaction memes, paper/document compositions, photo motion, text emphasis, captions, sound design and an FFmpeg render.

```
Narration ─► transcript (script alignment or Whisper) ─► Claude: scenes + plans + queries
   ─► providers (Pexels · Pixabay · Wikimedia · Internet Archive · GIPHY) ─► normalise · dedupe · rights filter
   ─► Claude ranking + diversity/pacing/meme engines ─► timeline (Zod-validated EDL) ─► FFmpeg ─► MP4
```

## Architecture

| Part | Where it runs | What it does |
|---|---|---|
| Web app (Next.js 16) | `npm run dev` locally, or Vercel | UI, auth, API routes, search, uploads, job enqueueing |
| Worker (`worker/index.ts`) | Your machine or a VPS (`npm run worker`) | Transcription/alignment, AI planning, media selection, FFmpeg rendering, cleanup |
| Supabase | Hosted | Postgres (RLS on every table), Auth, Storage bucket `projects` |

Rendering takes minutes and needs FFmpeg, so it runs in the worker, not in Vercel functions. The web app and worker talk through `pipeline_jobs` / `render_jobs` tables (claimed with `FOR UPDATE SKIP LOCKED`).

Key code:

| Path | Purpose |
|---|---|
| `src/lib/domain/types.ts` | Zod schemas: assets, rights, scene plans, **timeline (the only renderer input)**, settings, style profiles |
| `src/lib/media/providers/*` | `MediaProvider` adapters: Pexels, Pixabay, Wikimedia Commons, Internet Archive, GIPHY |
| `src/lib/media/searchOrchestrator.ts` | Multi-provider search, normalise, dedupe, filter (resolution/aspect/duration/rights), score, cache |
| `src/lib/ai/claude/` | Claude service: `analyzeScript`, `generateScenePlans`, `generateSearchQueries`, `rankMedia`, `createTimeline`, `analyzeReferenceStyle`, `suggestMeme`, `suggestSoundEffects` — structured outputs, Zod re-validation, repair/retry, response cache, usage/cost |
| `src/lib/pipeline/` | Director interface (Claude + labelled heuristic fallback), pacing / diversity / meme / motion engines, `generateEdit`, `buildTimeline` |
| `src/lib/render/` | FFmpeg: asset preparation, per-clip segment filter graphs (cached), libass text + captions, audio mix with ducking |
| `src/lib/reference/analyze.ts` | Reference video analysis (FFmpeg cut/freeze/saturation measurement + optional Claude frame classification) |
| `supabase/migrations/` | Database schema, RLS, storage bucket, job-claim functions |

## Setup

Requires Node.js 20.9+ (developed on Node 24). FFmpeg/ffprobe are installed by npm (`ffmpeg-static`, `ffprobe-static`); override with `FFMPEG_PATH`/`FFPROBE_PATH`.

```bash
npm ci
cp .env.example .env.local        # fill in values (see below)
npm run assets:generate           # textures, overlays, SFX, music beds, fonts, demo narration
npx supabase login                # once per machine
npx supabase link --project-ref hlkzcxgoevjvkbllehdh
npm run db:push:dry               # review the migration
npm run db:push                   # apply it
npm run dev                       # http://localhost:3000
npm run worker                    # in a second terminal — processes generation and render jobs
```

## Environment variables

See `.env.example` for the full list with instructions.

| Variable | Scope | Needed for |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Everything |
| `SUPABASE_SERVICE_ROLE_KEY` | Server/worker only | Worker (required), saving API keys in Settings, shared caches |
| `APP_ENCRYPTION_KEY` | Server only | Encrypting API keys saved in Settings |
| `ANTHROPIC_API_KEY` | Server only | Optional: Claude director. Without it the built-in keyword-rule director is used (no AI cost) |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | Server only | Stock photo/video search |
| `GIPHY_API_KEY` | Server only | Reaction GIFs/memes |
| `OPENAI_API_KEY` | Server only | Optional: transcribing narration when no script is given |
| `WIKIMEDIA_ACCESS_TOKEN`, `INTERNET_ARCHIVE_KEYS` | Server only | Optional: higher limits (both work without keys) |

Keys can also be entered per user in **Settings → API Connections** (stored AES-256-GCM encrypted; never returned to the browser). Saved keys override environment variables.

## Using it

1. **Projects → Try the demo project** (fictional script + generated TTS narration), or create a project.
2. **Project tab**: upload narration (audio or video) and ideally the script (`.txt`). Without a script, transcription needs `OPENAI_API_KEY`. Optional: reference video → *Analyse reference style*.
3. **Generate**. The worker aligns the transcript, plans scenes, searches providers, ranks media and builds the timeline.
4. Edit: select clips/scenes on the timeline; Inspector tabs **Visual / Text / Motion / Audio / Source / AI**. *Replace* opens Find Better Footage (AI recommendations + search). *Regenerate Scene* re-plans only chosen scenes.
5. **Render** (Draft 960×540, YouTube 1920×1080, Shorts 1080×1920). Each clip renders to a cached segment, so edits re-render only the changed clips. **Export MP4** downloads the result.
6. **Asset Rights** lists every visual's source and licence, whether it will render, and ready-to-paste credits.

CLI demo without the database: `npm run demo -- --draft` (writes `output/demo-draft.mp4`), `npm run demo` (1080p), `npm run demo -- --vertical`. Provider/Claude connectivity: `npm run test:providers`. Full end-to-end check (needs the app on BASE_URL, default http://localhost:3100, and a running worker; creates and deletes a throwaway user): `npm run test:e2e`.

## Media rights

Every asset stores provider, source URL, author, licence, licence URL, attribution, download URL, provider asset ID and retrieval date. Statuses:

| Status | Auto-selected? | Rendered? |
|---|---|---|
| CLEAR | Yes | Yes |
| ATTRIBUTION_REQUIRED | Yes | Yes (credits listed) |
| USER_REVIEW | Memes only, when "Allow needs-review assets" is on | If allowed or approved |
| UNKNOWN | Never | Only if you approve it **and** enable "Render approved unknown-rights assets" |
| RESTRICTED | Never | Never |

Notable rules: Internet Archive items are only CLEAR from curated public-domain collections (uploader-declared licences become USER_REVIEW); TV news collections are RESTRICTED; video whose metadata looks like broadcast/news/film footage is downgraded to USER_REVIEW regardless of its tag; GIPHY content is USER_REVIEW and credited "Powered By GIPHY". No scraping, no YouTube downloads; downloads are restricted to provider CDN hosts.

## Migrations

Schema changes go in `supabase/migrations/` (`npm run db:new -- name`), are reviewed with `npm run db:push:dry`, then applied with `npm run db:push`. Never edit a pushed migration.

## Deploying (Vercel)

Import the GitHub repo in Vercel; add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_ENCRYPTION_KEY` and any provider keys. Run the worker separately (local machine or VPS with the same env vars). Supabase's free tier caps uploads at 50 MB, which limits narration uploads and long 1080p renders; renders that exceed it stay on the worker and the job reports the local path.

## Security

- Secrets are server-only; only `NEXT_PUBLIC_*` reaches the browser. `.env*` (except `.env.example`) is git-ignored.
- RLS on every table; `api_settings`, caches and job claiming are service-role only.
- Uploads: allow-listed extensions/MIME types, size limits, server-generated storage paths, magic-byte sniffing, ffprobe validation in the worker.
- FFmpeg is always spawned with argument arrays built from the validated timeline; text goes through an ASS file, never the command line; network inputs use a protocol whitelist.
- Replacement assets are re-fetched from the provider server-side; the browser never supplies media URLs or licence data.
