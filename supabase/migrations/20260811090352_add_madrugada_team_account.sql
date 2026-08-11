alter table failure_portal_private.allowed_accounts
  drop constraint failure_portal_allowed_accounts_normalized_email_check;

alter table failure_portal_private.allowed_accounts
  add constraint failure_portal_allowed_accounts_normalized_email_check
    check (
      email = lower(trim(email))
      and (
        email like '%@claro.com.br'
        or email = 'madrugada@comunicador.invalid'
      )
    );

insert into failure_portal_private.allowed_accounts (email, display_name, role)
values ('madrugada@comunicador.invalid', 'Equipe Madrugada', 'team')
on conflict (email) do update
set display_name = excluded.display_name,
    role = excluded.role;
