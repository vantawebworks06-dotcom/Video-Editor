-- DocuCut AI — initial schema.
-- Safe on a fresh project: only CREATEs; no data is modified or dropped.
-- Every table has Row Level Security. Tables holding secrets or shared caches have NO client
-- policies at all and are only reachable with the service-role key from server code.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.rights_status as enum ('CLEAR', 'ATTRIBUTION_REQUIRED', 'USER_REVIEW', 'UNKNOWN', 'RESTRICTED');
create type public.render_status as enum ('QUEUED', 'DOWNLOADING', 'PREPARING', 'RENDERING', 'FINALIZING', 'COMPLETE', 'FAILED');
create type public.pipeline_status as enum ('QUEUED', 'RUNNING', 'COMPLETE', 'FAILED');
create type public.pipeline_kind as enum ('generate', 'regenerate_scenes', 'analyze_reference');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users (profile mirror of auth.users)
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- style_profiles (reference-video analyses and custom styles; built-in presets live in code)
-- ---------------------------------------------------------------------------
create table public.style_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  source text not null default 'custom' check (source in ('custom', 'reference')),
  profile jsonb not null,
  metrics jsonb,
  created_at timestamptz not null default now()
);
create index style_profiles_user_idx on public.style_profiles (user_id);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  status text not null default 'draft' check (status in ('draft', 'processing', 'ready', 'error')),
  is_demo boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  style_profile_id uuid references public.style_profiles (id) on delete set null,
  narration_path text,
  narration_duration numeric,
  script text check (script is null or char_length(script) <= 200000),
  transcript jsonb,
  reference_video_path text,
  music_path text,
  timeline jsonb,
  timeline_version integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user_idx on public.projects (user_id, updated_at desc);
create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- scenes
-- ---------------------------------------------------------------------------
create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  idx integer not null,
  scene_key text not null,
  start_time numeric not null,
  end_time numeric not null check (end_time >= start_time),
  narration text not null,
  importance text not null default 'medium' check (importance in ('low', 'medium', 'high')),
  visual_strategy text not null,
  plan jsonb not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, scene_key)
);
create index scenes_project_idx on public.scenes (project_id, idx);
create trigger scenes_updated_at before update on public.scenes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- assets — source/licence information is stored permanently with every asset
-- ---------------------------------------------------------------------------
create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  provider text not null,
  provider_asset_id text not null,
  type text not null check (type in ('video', 'photo', 'gif', 'sticker')),
  title text not null,
  description text,
  thumbnail_url text,
  media_url text not null,
  preview_url text,
  download_url text not null,
  width integer,
  height integer,
  duration numeric,
  author text,
  author_url text,
  source_url text not null,
  license text not null,
  license_url text,
  attribution text,
  attribution_required boolean not null default false,
  rights_status public.rights_status not null,
  rights_notes text[] not null default '{}',
  user_approved boolean not null default false,
  is_favorite boolean not null default false,
  archival boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  storage_path text,
  retrieved_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, provider, provider_asset_id)
);
create index assets_user_idx on public.assets (user_id, created_at desc);
create index assets_user_filters_idx on public.assets (user_id, provider, type, rights_status);

-- ---------------------------------------------------------------------------
-- scene_assets — a placed visual on the timeline
-- ---------------------------------------------------------------------------
create table public.scene_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_id uuid not null references public.scenes (id) on delete cascade,
  asset_id uuid not null references public.assets (id) on delete restrict,
  user_id uuid not null references public.users (id) on delete cascade,
  clip_key text not null,
  position integer not null,
  role text not null default 'primary' check (role in ('primary', 'meme')),
  start_time numeric not null,
  duration numeric not null check (duration > 0),
  trim_start numeric not null default 0 check (trim_start >= 0),
  need_type text not null,
  need_description text,
  queries text[] not null default '{}',
  layout text not null default 'fullscreen',
  motion jsonb not null default '{"type":"none","intensity":0.08}'::jsonb,
  treatment jsonb not null default '{"blackAndWhite":false,"grain":false}'::jsonb,
  annotations jsonb not null default '[]'::jsonb,
  alternates jsonb not null default '[]'::jsonb,
  scores jsonb,
  overall_score numeric,
  reason text,
  selected_by text not null default 'ai' check (selected_by in ('ai', 'heuristic', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, clip_key)
);
create index scene_assets_project_idx on public.scene_assets (project_id, start_time);
create index scene_assets_scene_idx on public.scene_assets (scene_id);
create index scene_assets_asset_idx on public.scene_assets (asset_id);
create trigger scene_assets_updated_at before update on public.scene_assets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- render_jobs
-- ---------------------------------------------------------------------------
create table public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  status public.render_status not null default 'QUEUED',
  progress numeric not null default 0 check (progress between 0 and 1),
  current_stage text,
  format text not null default 'landscape' check (format in ('landscape', 'vertical', 'draft')),
  timeline_version integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  output_path text,
  output_url text,
  warnings text[] not null default '{}',
  worker_id text,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now()
);
create index render_jobs_project_idx on public.render_jobs (project_id, created_at desc);
create index render_jobs_queue_idx on public.render_jobs (created_at) where status = 'QUEUED';

-- ---------------------------------------------------------------------------
-- pipeline_jobs (generation, scene regeneration, reference analysis)
-- ---------------------------------------------------------------------------
create table public.pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  kind public.pipeline_kind not null,
  payload jsonb not null default '{}'::jsonb,
  status public.pipeline_status not null default 'QUEUED',
  progress numeric not null default 0 check (progress between 0 and 1),
  current_stage text,
  result jsonb,
  error text,
  worker_id text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index pipeline_jobs_project_idx on public.pipeline_jobs (project_id, created_at desc);
create index pipeline_jobs_queue_idx on public.pipeline_jobs (created_at) where status = 'QUEUED';

-- ---------------------------------------------------------------------------
-- exports
-- ---------------------------------------------------------------------------
create table public.exports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  render_job_id uuid references public.render_jobs (id) on delete set null,
  format text not null,
  storage_path text not null,
  size_bytes bigint,
  duration numeric,
  attributions text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index exports_project_idx on public.exports (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- media_providers (reference data)
-- ---------------------------------------------------------------------------
create table public.media_providers (
  id text primary key,
  name text not null,
  supports_images boolean not null,
  supports_video boolean not null,
  supports_gifs boolean not null default false,
  requires_key boolean not null,
  docs_url text not null,
  attribution_text text,
  enabled boolean not null default true
);
insert into public.media_providers (id, name, supports_images, supports_video, supports_gifs, requires_key, docs_url, attribution_text) values
  ('pexels', 'Pexels', true, true, false, true, 'https://www.pexels.com/api/documentation/', 'Photos and videos provided by Pexels'),
  ('pixabay', 'Pixabay', true, true, false, true, 'https://pixabay.com/api/docs/', 'Images and videos from Pixabay'),
  ('wikimedia', 'Wikimedia Commons', true, true, false, false, 'https://commons.wikimedia.org/w/api.php', 'Media from Wikimedia Commons (licence per file)'),
  ('internet_archive', 'Internet Archive', true, true, false, false, 'https://archive.org/developers/', 'Material from the Internet Archive (rights per item)'),
  ('giphy', 'GIPHY', true, false, true, true, 'https://developers.giphy.com/docs/api/', 'Powered By GIPHY');

-- ---------------------------------------------------------------------------
-- api_settings — encrypted user API keys. Server-only (service role); no client policies.
-- ---------------------------------------------------------------------------
create table public.api_settings (
  user_id uuid not null references public.users (id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'pexels', 'pixabay', 'giphy', 'wikimediaToken', 'internetArchive', 'openai')),
  encrypted_key text not null,
  key_hint text not null,
  status text not null default 'untested',
  last_tested_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

-- ---------------------------------------------------------------------------
-- Caches and AI usage (server-only)
-- ---------------------------------------------------------------------------
create table public.search_cache (
  cache_key text primary key,
  provider text not null,
  query text not null,
  results jsonb not null,
  created_at timestamptz not null default now()
);
create index search_cache_created_idx on public.search_cache (created_at);

create table public.ai_responses (
  fn text not null,
  input_hash text not null,
  model text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (fn, input_hash)
);

create table public.ai_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  fn text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  cached boolean not null default false,
  created_at timestamptz not null default now()
);
create index ai_usage_project_idx on public.ai_usage_events (project_id, created_at desc);
create index ai_usage_user_idx on public.ai_usage_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.style_profiles enable row level security;
alter table public.projects enable row level security;
alter table public.scenes enable row level security;
alter table public.assets enable row level security;
alter table public.scene_assets enable row level security;
alter table public.render_jobs enable row level security;
alter table public.pipeline_jobs enable row level security;
alter table public.exports enable row level security;
alter table public.media_providers enable row level security;
alter table public.api_settings enable row level security;
alter table public.search_cache enable row level security;
alter table public.ai_responses enable row level security;
alter table public.ai_usage_events enable row level security;

create policy "users: read own" on public.users for select to authenticated using ((select auth.uid()) = id);
create policy "users: update own" on public.users for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Owner-scoped CRUD for user content.
create policy "style_profiles: owner" on public.style_profiles for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "projects: owner" on public.projects for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "scenes: owner" on public.scenes for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "assets: owner" on public.assets for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "scene_assets: owner" on public.scene_assets for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "exports: owner read" on public.exports for select to authenticated using ((select auth.uid()) = user_id);

-- Jobs: users may read their own and enqueue new ones; status is only written by the worker.
create policy "render_jobs: owner read" on public.render_jobs for select to authenticated using ((select auth.uid()) = user_id);
create policy "render_jobs: owner enqueue" on public.render_jobs for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'QUEUED'
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = (select auth.uid())));
create policy "pipeline_jobs: owner read" on public.pipeline_jobs for select to authenticated using ((select auth.uid()) = user_id);
create policy "pipeline_jobs: owner enqueue" on public.pipeline_jobs for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'QUEUED'
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = (select auth.uid())));

create policy "media_providers: read" on public.media_providers for select to authenticated using (true);
create policy "ai_usage: owner read" on public.ai_usage_events for select to authenticated using ((select auth.uid()) = user_id);
-- api_settings, search_cache, ai_responses: intentionally no policies (service role only).

-- ---------------------------------------------------------------------------
-- Worker job claiming (service role only). SKIP LOCKED lets several workers run safely.
-- ---------------------------------------------------------------------------
create or replace function public.claim_render_job(p_worker text)
returns setof public.render_jobs
language sql
set search_path = ''
as $$
  update public.render_jobs j
     set status = 'DOWNLOADING', started_at = now(), heartbeat_at = now(), worker_id = p_worker, current_stage = 'Starting'
   where j.id = (
     select id from public.render_jobs
      where status = 'QUEUED'
      order by created_at
      for update skip locked
      limit 1)
  returning j.*;
$$;

create or replace function public.claim_pipeline_job(p_worker text)
returns setof public.pipeline_jobs
language sql
set search_path = ''
as $$
  update public.pipeline_jobs j
     set status = 'RUNNING', started_at = now(), heartbeat_at = now(), worker_id = p_worker, current_stage = 'Starting'
   where j.id = (
     select id from public.pipeline_jobs
      where status = 'QUEUED'
      order by created_at
      for update skip locked
      limit 1)
  returning j.*;
$$;

revoke execute on function public.claim_render_job(text) from public, anon, authenticated;
revoke execute on function public.claim_pipeline_job(text) from public, anon, authenticated;
grant execute on function public.claim_render_job(text) to service_role;
grant execute on function public.claim_pipeline_job(text) to service_role;

-- Per-project AI usage totals (respects the caller's RLS).
create view public.project_ai_usage
with (security_invoker = true)
as
select project_id,
       count(*) filter (where not cached) as calls,
       count(*) filter (where cached) as cached_calls,
       coalesce(sum(input_tokens), 0) as input_tokens,
       coalesce(sum(output_tokens), 0) as output_tokens,
       coalesce(sum(cost_usd), 0) as cost_usd
  from public.ai_usage_events
 group by project_id;

-- ---------------------------------------------------------------------------
-- Storage: private "projects" bucket, laid out as {projectId}/{audio|assets|thumbnails|renders|temp}/...
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'projects', 'projects', false, 52428800,
  array[
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/flac',
    'video/mp4', 'video/quicktime', 'video/webm',
    'image/jpeg', 'image/png', 'image/webp',
    'text/plain'
  ]
)
on conflict (id) do nothing;

-- Users can read/write objects only inside folders of projects they own.
create policy "projects bucket: owner read" on storage.objects for select to authenticated
  using (bucket_id = 'projects' and exists (
    select 1 from public.projects p
     where p.id::text = (storage.foldername(name))[1] and p.user_id = (select auth.uid())));
create policy "projects bucket: owner upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'projects'
    and (storage.foldername(name))[2] in ('audio', 'assets', 'temp')
    and exists (
      select 1 from public.projects p
       where p.id::text = (storage.foldername(name))[1] and p.user_id = (select auth.uid())));
create policy "projects bucket: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'projects' and exists (
    select 1 from public.projects p
     where p.id::text = (storage.foldername(name))[1] and p.user_id = (select auth.uid())));
