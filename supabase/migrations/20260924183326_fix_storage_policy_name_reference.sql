-- Fix: in the original storage policies, the unqualified `name` inside the projects subquery
-- resolved to public.projects.name (the project title) instead of storage.objects.name, so
-- owners could never read, upload or delete their own files. Recreate the three policies with
-- the object name fully qualified. No data is changed.

drop policy if exists "projects bucket: owner read" on storage.objects;
drop policy if exists "projects bucket: owner upload" on storage.objects;
drop policy if exists "projects bucket: owner delete" on storage.objects;

create policy "projects bucket: owner read" on storage.objects for select to authenticated
  using (bucket_id = 'projects' and exists (
    select 1 from public.projects p
     where p.id::text = (storage.foldername(storage.objects.name))[1] and p.user_id = (select auth.uid())));

create policy "projects bucket: owner upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'projects'
    and (storage.foldername(storage.objects.name))[2] in ('audio', 'assets', 'temp')
    and exists (
      select 1 from public.projects p
       where p.id::text = (storage.foldername(storage.objects.name))[1] and p.user_id = (select auth.uid())));

create policy "projects bucket: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'projects' and exists (
    select 1 from public.projects p
     where p.id::text = (storage.foldername(storage.objects.name))[1] and p.user_id = (select auth.uid())));
