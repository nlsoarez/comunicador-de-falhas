create schema if not exists failure_portal_private;
revoke all on schema failure_portal_private from public, anon, authenticated;

create table public.failure_portal_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.failure_portal_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null default auth.uid()
    references public.failure_portal_profiles(user_id) on delete restrict,
  occurred_at timestamptz not null,
  title text not null check (char_length(title) between 1 and 160),
  cluster text not null check (cluster in ('RJ', 'ES', 'BA', 'NE', 'NO', 'CO', 'MG', 'N/A')),
  incident text check (incident is null or char_length(incident) <= 120),
  task_or_system text check (task_or_system is null or char_length(task_or_system) <= 180),
  description text not null check (char_length(description) between 1 and 5000),
  created_at timestamptz not null default now()
);

create table public.failure_portal_tickets (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null default auth.uid()
    references public.failure_portal_profiles(user_id) on delete restrict,
  opened_at timestamptz not null,
  closed_at timestamptz,
  ticket_number text not null check (char_length(ticket_number) between 1 and 120),
  reason text not null check (char_length(reason) between 1 and 180),
  created_at timestamptz not null default now(),
  constraint failure_portal_tickets_valid_period check (closed_at is null or closed_at >= opened_at)
);

create index failure_portal_reports_occurred_at_idx on public.failure_portal_reports (occurred_at desc);
create index failure_portal_reports_reporter_id_idx on public.failure_portal_reports (reporter_id);
create index failure_portal_tickets_opened_at_idx on public.failure_portal_tickets (opened_at desc);
create index failure_portal_tickets_reporter_id_idx on public.failure_portal_tickets (reporter_id);

create or replace function failure_portal_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.failure_portal_profiles (user_id, display_name)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), new.email, new.id::text), 120)
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function failure_portal_private.handle_new_user() from public, anon, authenticated;

create trigger failure_portal_on_auth_user_created
  after insert on auth.users
  for each row execute function failure_portal_private.handle_new_user();

insert into public.failure_portal_profiles (user_id, display_name)
select
  id,
  left(coalesce(nullif(trim(raw_user_meta_data ->> 'display_name'), ''), email, id::text), 120)
from auth.users
on conflict (user_id) do nothing;

alter table public.failure_portal_profiles enable row level security;
alter table public.failure_portal_reports enable row level security;
alter table public.failure_portal_tickets enable row level security;

create policy profiles_read_authenticated
  on public.failure_portal_profiles for select
  to authenticated
  using (true);

create policy profiles_update_own
  on public.failure_portal_profiles for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy failure_reports_read_authenticated
  on public.failure_portal_reports for select
  to authenticated
  using (true);

create policy failure_reports_insert_own
  on public.failure_portal_reports for insert
  to authenticated
  with check ((select auth.uid()) = reporter_id);

create policy failure_reports_delete_admin
  on public.failure_portal_reports for delete
  to authenticated
  using (coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin');

create policy service_tickets_read_authenticated
  on public.failure_portal_tickets for select
  to authenticated
  using (true);

create policy service_tickets_insert_own
  on public.failure_portal_tickets for insert
  to authenticated
  with check ((select auth.uid()) = reporter_id);

create policy service_tickets_update_owner_or_admin
  on public.failure_portal_tickets for update
  to authenticated
  using (
    (select auth.uid()) = reporter_id
    or coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin'
  )
  with check (
    (select auth.uid()) = reporter_id
    or coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin'
  );

create policy service_tickets_delete_admin
  on public.failure_portal_tickets for delete
  to authenticated
  using (coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin');

revoke all on table public.failure_portal_profiles, public.failure_portal_reports, public.failure_portal_tickets from anon;
grant select on table public.failure_portal_profiles, public.failure_portal_reports, public.failure_portal_tickets to authenticated;
grant insert on table public.failure_portal_reports, public.failure_portal_tickets to authenticated;
grant delete on table public.failure_portal_reports, public.failure_portal_tickets to authenticated;
grant update (display_name) on table public.failure_portal_profiles to authenticated;
grant update (closed_at) on table public.failure_portal_tickets to authenticated;
