create table public.failure_portal_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'reporter' check (role in ('reporter', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.failure_portal_memberships enable row level security;

create or replace function failure_portal_private.current_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from public.failure_portal_memberships
  where user_id = (select auth.uid())
  limit 1;
$$;

revoke all on function failure_portal_private.current_role() from public, anon;
grant execute on function failure_portal_private.current_role() to authenticated;

drop trigger if exists failure_portal_on_auth_user_created on auth.users;
drop function if exists failure_portal_private.handle_new_user();

create or replace function failure_portal_private.handle_new_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
begin
  select * into v_user from auth.users where id = new.user_id;
  insert into public.failure_portal_profiles (user_id, display_name)
  values (
    new.user_id,
    left(coalesce(nullif(trim(v_user.raw_user_meta_data ->> 'display_name'), ''), v_user.email, new.user_id::text), 120)
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function failure_portal_private.handle_new_member() from public, anon, authenticated;

create trigger failure_portal_on_member_created
  after insert on public.failure_portal_memberships
  for each row execute function failure_portal_private.handle_new_member();

create or replace function failure_portal_private.handle_portal_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if lower(coalesce(new.raw_user_meta_data ->> 'application', '')) = 'failure-portal'
     and lower(coalesce(new.email, '')) like '%@claro.com.br' then
    insert into public.failure_portal_memberships (user_id, role)
    values (
      new.id,
      case
        when lower(new.email) = 'nelson.soares@claro.com.br' then 'admin'
        else 'reporter'
      end
    )
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function failure_portal_private.handle_portal_signup() from public, anon, authenticated;

create trigger failure_portal_on_auth_signup
  after insert on auth.users
  for each row execute function failure_portal_private.handle_portal_signup();

drop policy if exists profiles_read_authenticated on public.failure_portal_profiles;
drop policy if exists profiles_update_own on public.failure_portal_profiles;
drop policy if exists failure_reports_read_authenticated on public.failure_portal_reports;
drop policy if exists failure_reports_insert_own on public.failure_portal_reports;
drop policy if exists failure_reports_delete_admin on public.failure_portal_reports;
drop policy if exists service_tickets_read_authenticated on public.failure_portal_tickets;
drop policy if exists service_tickets_insert_own on public.failure_portal_tickets;
drop policy if exists service_tickets_update_owner_or_admin on public.failure_portal_tickets;
drop policy if exists service_tickets_delete_admin on public.failure_portal_tickets;

create policy failure_portal_memberships_read
  on public.failure_portal_memberships for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or failure_portal_private.current_role() = 'admin'
  );

create policy failure_portal_profiles_read
  on public.failure_portal_profiles for select
  to authenticated
  using (failure_portal_private.current_role() is not null);

create policy failure_portal_profiles_update_own
  on public.failure_portal_profiles for update
  to authenticated
  using (
    failure_portal_private.current_role() is not null
    and user_id = (select auth.uid())
  )
  with check (
    failure_portal_private.current_role() is not null
    and user_id = (select auth.uid())
  );

create policy failure_portal_reports_read
  on public.failure_portal_reports for select
  to authenticated
  using (failure_portal_private.current_role() is not null);

create policy failure_portal_reports_insert_own
  on public.failure_portal_reports for insert
  to authenticated
  with check (
    failure_portal_private.current_role() in ('reporter', 'admin')
    and reporter_id = (select auth.uid())
  );

create policy failure_portal_reports_delete_admin
  on public.failure_portal_reports for delete
  to authenticated
  using (failure_portal_private.current_role() = 'admin');

create policy failure_portal_tickets_read
  on public.failure_portal_tickets for select
  to authenticated
  using (failure_portal_private.current_role() is not null);

create policy failure_portal_tickets_insert_own
  on public.failure_portal_tickets for insert
  to authenticated
  with check (
    failure_portal_private.current_role() in ('reporter', 'admin')
    and reporter_id = (select auth.uid())
  );

create policy failure_portal_tickets_update_owner_or_admin
  on public.failure_portal_tickets for update
  to authenticated
  using (
    failure_portal_private.current_role() = 'admin'
    or reporter_id = (select auth.uid())
  )
  with check (
    failure_portal_private.current_role() = 'admin'
    or reporter_id = (select auth.uid())
  );

create policy failure_portal_tickets_delete_admin
  on public.failure_portal_tickets for delete
  to authenticated
  using (failure_portal_private.current_role() = 'admin');

revoke all on table public.failure_portal_memberships from anon;
grant select on table public.failure_portal_memberships to authenticated;
