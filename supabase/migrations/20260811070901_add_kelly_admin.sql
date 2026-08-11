create or replace function failure_portal_private.is_admin_email(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(p_email, '')) in (
    'nelson.soares@claro.com.br',
    'kelly.lira@claro.com.br'
  );
$$;

revoke all on function failure_portal_private.is_admin_email(text)
  from public, anon, authenticated;

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
        when new.email_confirmed_at is not null
         and failure_portal_private.is_admin_email(new.email) then 'admin'
        else 'reporter'
      end
    )
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function failure_portal_private.handle_portal_signup()
  from public, anon, authenticated;

create or replace function failure_portal_private.handle_admin_email_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.email_confirmed_at is null
     and new.email_confirmed_at is not null
     and failure_portal_private.is_admin_email(new.email)
     and lower(coalesce(new.raw_user_meta_data ->> 'application', '')) = 'failure-portal' then
    update public.failure_portal_memberships
       set role = 'admin'
     where user_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function failure_portal_private.handle_admin_email_confirmation()
  from public, anon, authenticated;

drop trigger if exists failure_portal_on_admin_email_confirmation on auth.users;
create trigger failure_portal_on_admin_email_confirmation
  after update of email_confirmed_at on auth.users
  for each row execute function failure_portal_private.handle_admin_email_confirmation();

insert into public.failure_portal_memberships (user_id, role)
select id, 'admin'
from auth.users
where email_confirmed_at is not null
  and failure_portal_private.is_admin_email(email)
  and lower(coalesce(raw_user_meta_data ->> 'application', '')) = 'failure-portal'
on conflict (user_id) do update set role = excluded.role;
