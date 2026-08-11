drop policy if exists failure_portal_memberships_read
  on public.failure_portal_memberships;

create policy failure_portal_memberships_read_own
  on public.failure_portal_memberships for select
  to authenticated
  using (user_id = (select auth.uid()));
