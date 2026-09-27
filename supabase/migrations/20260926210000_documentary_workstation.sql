-- DocuCut — documentary workstation: transcript analysis, research/media library with approval
-- states and source provenance, source clips with narration pause/duck modes, undo/redo
-- snapshots, saved presets, 720p export and new integrations.
-- Additive only: new types/tables/columns/enum values and widened CHECK constraints. No data is
-- modified or dropped.

-- ---------------------------------------------------------------------------
-- New pipeline job kinds (worker): narration processing preview, screenshot capture of a
-- source, and probing/transcribing an imported media file.
-- ---------------------------------------------------------------------------
alter type public.pipeline_kind add value if not exists 'process_audio';
alter type public.pipeline_kind add value if not exists 'capture';
alter type public.pipeline_kind add value if not exists 'import_media';

-- ---------------------------------------------------------------------------
-- Transcript analysis (sentences, scenes, entities, visual intents) cached on the project.
-- ---------------------------------------------------------------------------
alter table public.projects add column if not exists analysis jsonb;

-- ---------------------------------------------------------------------------
-- media_items — every researched, captured, imported or uploaded item of a project, with its
-- editorial status and full provenance. Items that can be placed on the timeline link to an
-- `assets` row (the renderable file + licence); references (e.g. a YouTube video, which may not
-- be downloaded) never do.
-- ---------------------------------------------------------------------------
create type public.media_status as enum ('DISCOVERED', 'REVIEW', 'APPROVED', 'REJECTED', 'USED');

create table public.media_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  status public.media_status not null default 'DISCOVERED',
  category text not null check (category in ('video', 'photo', 'social', 'article', 'screenshot', 'interview', 'audio', 'music', 'document', 'web')),
  provider text not null check (char_length(provider) between 1 and 40),
  external_id text check (external_id is null or char_length(external_id) <= 400),
  title text not null check (char_length(title) between 1 and 500),
  description text check (description is null or char_length(description) <= 5000),
  excerpt text check (excerpt is null or char_length(excerpt) <= 5000),
  source_url text check (source_url is null or char_length(source_url) <= 2000),
  platform text,
  account text,
  account_url text,
  published_at timestamptz,
  found_at timestamptz not null default now(),
  imported_at timestamptz,
  duration numeric,
  thumbnail_url text,
  embed jsonb,
  segment jsonb,
  relevance jsonb,
  query text,
  sentence_idx integer,
  scene_key text,
  rights_notes text check (rights_notes is null or char_length(rights_notes) <= 4000),
  license text,
  asset_id uuid references public.assets (id) on delete set null,
  storage_path text,
  derived_from uuid references public.media_items (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, provider, external_id)
);
create index media_items_project_idx on public.media_items (project_id, created_at desc);
create index media_items_project_status_idx on public.media_items (project_id, status);
create index media_items_sentence_idx on public.media_items (project_id, sentence_idx);
create trigger media_items_updated_at before update on public.media_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Source clips (interview/news footage with its own audio) and their narration behaviour.
-- ---------------------------------------------------------------------------
alter table public.scene_assets drop constraint if exists scene_assets_role_check;
alter table public.scene_assets add constraint scene_assets_role_check check (role in ('primary', 'meme', 'source'));
alter table public.scene_assets add column if not exists audio jsonb;
alter table public.scene_assets add column if not exists media_item_id uuid references public.media_items (id) on delete set null;
create index if not exists scene_assets_media_item_idx on public.scene_assets (media_item_id);

-- ---------------------------------------------------------------------------
-- 720p export.
-- ---------------------------------------------------------------------------
alter table public.render_jobs drop constraint if exists render_jobs_format_check;
alter table public.render_jobs add constraint render_jobs_format_check check (format in ('landscape', 'vertical', 'draft', 'hd720'));

-- ---------------------------------------------------------------------------
-- New integrations whose credentials can be saved (encrypted) in Settings.
-- ---------------------------------------------------------------------------
alter table public.api_settings drop constraint if exists api_settings_provider_check;
alter table public.api_settings add constraint api_settings_provider_check check (provider in (
  'anthropic', 'pexels', 'pixabay', 'giphy', 'wikimediaToken', 'internetArchive', 'openai',
  'youtube', 'xBearer', 'metaOembed', 'reddit', 'brave'));

-- ---------------------------------------------------------------------------
-- edit_snapshots — server-side undo/redo. Before each edit the affected state is saved; undo
-- restores the newest 'undo' snapshot (saving the current state as 'redo').
-- ---------------------------------------------------------------------------
create table public.edit_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('undo', 'redo')),
  label text not null check (char_length(label) between 1 and 200),
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index edit_snapshots_project_idx on public.edit_snapshots (project_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- user_presets — saved audio chains, image looks and visual styles.
-- ---------------------------------------------------------------------------
create table public.user_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('audio', 'image', 'style')),
  name text not null check (char_length(name) between 1 and 80),
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, kind, name)
);
create index user_presets_user_idx on public.user_presets (user_id, kind);

-- ---------------------------------------------------------------------------
-- Row Level Security — owner-scoped, like every other user-content table.
-- ---------------------------------------------------------------------------
alter table public.media_items enable row level security;
alter table public.edit_snapshots enable row level security;
alter table public.user_presets enable row level security;

create policy "media_items: owner" on public.media_items for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "edit_snapshots: owner" on public.edit_snapshots for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "user_presets: owner" on public.user_presets for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Imported GIFs (user uploads / captures) are allowed in the project bucket.
update storage.buckets
   set allowed_mime_types = array(select distinct unnest(allowed_mime_types || array['image/gif']))
 where id = 'projects';
