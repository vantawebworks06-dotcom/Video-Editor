-- Narrator: synthetic narration in a voice matched to the user's own recordings (local, free TTS).
--
-- voice_profiles: per user, reusable across projects. Samples live in the project bucket under the
--   project they were recorded in ({projectId}/audio/voice-samples/{profileId}/...); the analysis
--   (pitch, pace, pauses, level) and the matched engine voice are stored here.
-- projects.narrator: the project's narrator session (script, sentences, style, controls,
--   processing, generated output).
-- New worker job kinds: voice_profile (analyse samples, match a voice), narrate (generate/assemble).

alter type public.pipeline_kind add value if not exists 'voice_profile';
alter type public.pipeline_kind add value if not exists 'narrate';

create table public.voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  accent text not null default 'us' check (accent in ('us', 'uk')),
  samples jsonb not null default '[]'::jsonb,
  analysis jsonb,
  match jsonb,
  pronunciations jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index voice_profiles_user_idx on public.voice_profiles (user_id, created_at desc);

alter table public.voice_profiles enable row level security;
create policy "voice_profiles: owner" on public.voice_profiles for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

alter table public.projects add column if not exists narrator jsonb;

-- Voice samples recorded in the browser arrive as WebM/Opus.
update storage.buckets
   set allowed_mime_types = array(select distinct unnest(allowed_mime_types || array['audio/webm']))
 where id = 'projects';
