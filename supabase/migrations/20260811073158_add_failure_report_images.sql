alter table public.failure_portal_reports
  add column attachment_path text,
  add column attachment_name text,
  add column attachment_mime text,
  add column attachment_size bigint;

alter table public.failure_portal_reports
  add constraint failure_portal_reports_attachment_complete_check
  check (
    (attachment_path is null
      and attachment_name is null
      and attachment_mime is null
      and attachment_size is null)
    or
    (attachment_path is not null
      and attachment_name is not null
      and attachment_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
      and attachment_size between 1 and 5242880)
  ),
  add constraint failure_portal_reports_attachment_name_check
  check (attachment_name is null or char_length(attachment_name) between 1 and 255),
  add constraint failure_portal_reports_attachment_owner_check
  check (attachment_path is null or attachment_path like reporter_id::text || '/%');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'failure-portal-images',
  'failure-portal-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy failure_portal_images_read
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'failure-portal-images'
    and (select failure_portal_private.current_role()) is not null
  );

create policy failure_portal_images_insert_own
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'failure-portal-images'
    and (select failure_portal_private.current_role()) in ('reporter', 'admin')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy failure_portal_images_delete_owner_or_admin
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'failure-portal-images'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (select failure_portal_private.current_role()) = 'admin'
    )
  );
