create table failure_portal_private.allowed_accounts (
  email text primary key,
  display_name text not null check (char_length(display_name) between 3 and 120),
  role text not null check (role in ('team', 'admin')),
  created_at timestamptz not null default now(),
  constraint failure_portal_allowed_accounts_normalized_email_check
    check (email = lower(trim(email)) and email like '%@claro.com.br')
);

alter table failure_portal_private.allowed_accounts enable row level security;
revoke all on table failure_portal_private.allowed_accounts from public, anon, authenticated;

insert into failure_portal_private.allowed_accounts (email, display_name, role)
values
  ('kelly.lira@claro.com.br', 'Kelly Lira', 'admin'),
  ('nelson.soares@claro.com.br', 'Nelson Soares', 'admin');

alter table public.failure_portal_memberships
  drop constraint failure_portal_memberships_role_check;

update public.failure_portal_memberships
set role = 'team'
where role = 'reporter';

alter table public.failure_portal_memberships
  alter column role set default 'team',
  add constraint failure_portal_memberships_role_check
    check (role in ('team', 'admin'));

-- Somente contas explicitamente autorizadas permanecem no Comunicador.
delete from public.failure_portal_memberships m
where not exists (
  select 1
  from auth.users u
  join failure_portal_private.allowed_accounts a on a.email = lower(u.email)
  where u.id = m.user_id
);

create or replace function failure_portal_private.is_admin_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from failure_portal_private.allowed_accounts
    where email = lower(coalesce(p_email, ''))
      and role = 'admin'
  );
$$;

revoke all on function failure_portal_private.is_admin_email(text)
  from public, anon, authenticated;

create or replace function failure_portal_private.handle_new_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
begin
  select a.display_name
    into v_display_name
  from auth.users u
  join failure_portal_private.allowed_accounts a on a.email = lower(u.email)
  where u.id = new.user_id;

  if v_display_name is null then
    raise exception 'Conta não autorizada para o Comunicador de Falhas';
  end if;

  insert into public.failure_portal_profiles (user_id, display_name)
  values (new.user_id, v_display_name)
  on conflict (user_id) do update set display_name = excluded.display_name;
  return new;
end;
$$;

revoke all on function failure_portal_private.handle_new_member()
  from public, anon, authenticated;

create or replace function failure_portal_private.handle_portal_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if lower(coalesce(new.raw_user_meta_data ->> 'application', '')) = 'failure-portal'
     and new.email_confirmed_at is not null then
    select role into v_role
    from failure_portal_private.allowed_accounts
    where email = lower(coalesce(new.email, ''));

    if v_role is not null then
      insert into public.failure_portal_memberships (user_id, role)
      values (new.id, v_role)
      on conflict (user_id) do update set role = excluded.role;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function failure_portal_private.handle_portal_signup()
  from public, anon, authenticated;

drop trigger if exists failure_portal_on_admin_email_confirmation on auth.users;
drop function if exists failure_portal_private.handle_admin_email_confirmation();

create or replace function failure_portal_private.handle_portal_email_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.email_confirmed_at is null
     and new.email_confirmed_at is not null
     and lower(coalesce(new.raw_user_meta_data ->> 'application', '')) = 'failure-portal' then
    insert into public.failure_portal_memberships (user_id, role)
    select new.id, a.role
    from failure_portal_private.allowed_accounts a
    where a.email = lower(coalesce(new.email, ''))
    on conflict (user_id) do update set role = excluded.role;
  end if;
  return new;
end;
$$;

revoke all on function failure_portal_private.handle_portal_email_confirmation()
  from public, anon, authenticated;

create trigger failure_portal_on_email_confirmation
  after update of email_confirmed_at on auth.users
  for each row execute function failure_portal_private.handle_portal_email_confirmation();

-- Sincroniza as duas contas existentes sem tocar em usuários de outros sistemas.
insert into public.failure_portal_memberships (user_id, role)
select u.id, a.role
from auth.users u
join failure_portal_private.allowed_accounts a on a.email = lower(u.email)
where u.email_confirmed_at is not null
  and lower(coalesce(u.raw_user_meta_data ->> 'application', '')) = 'failure-portal'
on conflict (user_id) do update set role = excluded.role;

update public.failure_portal_profiles p
set display_name = a.display_name
from auth.users u
join failure_portal_private.allowed_accounts a on a.email = lower(u.email)
where p.user_id = u.id;

alter table public.failure_portal_reports
  add column reporter_name text;

alter table public.failure_portal_tickets
  add column reporter_name text;

update public.failure_portal_reports r
set reporter_name = case
  when m.role = 'admin' then a.display_name
  else 'EQUIPE MADRUGADA (ANÔNIMO)'
end
from public.failure_portal_memberships m
join auth.users u on u.id = m.user_id
join failure_portal_private.allowed_accounts a on a.email = lower(u.email)
where r.reporter_id = m.user_id;

update public.failure_portal_tickets t
set reporter_name = case
  when m.role = 'admin' then a.display_name
  else 'EQUIPE MADRUGADA (ANÔNIMO)'
end
from public.failure_portal_memberships m
join auth.users u on u.id = m.user_id
join failure_portal_private.allowed_accounts a on a.email = lower(u.email)
where t.reporter_id = m.user_id;

update public.failure_portal_reports
set reporter_name = 'EQUIPE MADRUGADA (ANÔNIMO)'
where reporter_name is null;

update public.failure_portal_tickets
set reporter_name = 'EQUIPE MADRUGADA (ANÔNIMO)'
where reporter_name is null;

alter table public.failure_portal_reports
  alter column reporter_name set not null,
  add constraint failure_portal_reports_reporter_name_check
    check (char_length(reporter_name) between 3 and 120);

alter table public.failure_portal_tickets
  alter column reporter_name set not null,
  add constraint failure_portal_tickets_reporter_name_check
    check (char_length(reporter_name) between 3 and 120);

create or replace function failure_portal_private.set_submission_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_display_name text;
begin
  select m.role, a.display_name
    into v_role, v_display_name
  from public.failure_portal_memberships m
  join auth.users u on u.id = m.user_id
  join failure_portal_private.allowed_accounts a on a.email = lower(u.email)
  where m.user_id = v_user_id;

  if v_role is null then
    raise exception 'Conta não autorizada para o Comunicador de Falhas';
  end if;

  new.reporter_id := v_user_id;
  new.reporter_name := case
    when v_role = 'admin' then v_display_name
    else 'EQUIPE MADRUGADA (ANÔNIMO)'
  end;
  return new;
end;
$$;

revoke all on function failure_portal_private.set_submission_identity()
  from public, anon, authenticated;

create trigger failure_portal_reports_set_identity
  before insert on public.failure_portal_reports
  for each row execute function failure_portal_private.set_submission_identity();

create trigger failure_portal_tickets_set_identity
  before insert on public.failure_portal_tickets
  for each row execute function failure_portal_private.set_submission_identity();

drop policy if exists failure_portal_reports_insert_own on public.failure_portal_reports;
create policy failure_portal_reports_insert_member
  on public.failure_portal_reports for insert
  to authenticated
  with check (
    (select failure_portal_private.current_role()) in ('team', 'admin')
    and reporter_id = (select auth.uid())
  );

drop policy if exists failure_portal_tickets_insert_own on public.failure_portal_tickets;
create policy failure_portal_tickets_insert_member
  on public.failure_portal_tickets for insert
  to authenticated
  with check (
    (select failure_portal_private.current_role()) in ('team', 'admin')
    and reporter_id = (select auth.uid())
  );

drop policy if exists failure_portal_tickets_update_owner_or_admin on public.failure_portal_tickets;
create policy failure_portal_tickets_update_admin
  on public.failure_portal_tickets for update
  to authenticated
  using ((select failure_portal_private.current_role()) = 'admin')
  with check ((select failure_portal_private.current_role()) = 'admin');

drop policy if exists failure_portal_profiles_update_own on public.failure_portal_profiles;

drop policy if exists failure_portal_images_insert_own on storage.objects;
create policy failure_portal_images_insert_member
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'failure-portal-images'
    and (select failure_portal_private.current_role()) in ('team', 'admin')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists failure_portal_images_delete_owner_or_admin on storage.objects;
create policy failure_portal_images_delete_admin
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'failure-portal-images'
    and (select failure_portal_private.current_role()) = 'admin'
  );

-- A coluna reporter_id continua no banco para auditoria, mas nunca é exposta ao navegador.
revoke all on table public.failure_portal_profiles,
  public.failure_portal_reports,
  public.failure_portal_tickets
from authenticated;

grant select on table public.failure_portal_profiles to authenticated;

grant select (
  id, occurred_at, title, cluster, incident, task_or_system, description,
  attachment_path, attachment_name, attachment_mime, attachment_size, reporter_name
) on public.failure_portal_reports to authenticated;

grant insert (
  id, occurred_at, title, cluster, incident, task_or_system, description,
  attachment_path, attachment_name, attachment_mime, attachment_size
) on public.failure_portal_reports to authenticated;

grant delete on table public.failure_portal_reports to authenticated;

grant select (
  id, opened_at, closed_at, ticket_number, reason, reporter_name
) on public.failure_portal_tickets to authenticated;

grant insert (opened_at, ticket_number, reason)
  on public.failure_portal_tickets to authenticated;

grant update (closed_at) on public.failure_portal_tickets to authenticated;
grant delete on table public.failure_portal_tickets to authenticated;
