-- =====================================================================
-- JSP Extender Control — Supabase schema, RLS and realtime
-- Run this whole file in Supabase → SQL Editor → New query → Run.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Admin allow-list
-- The GitHub Pages frontend uses the PUBLIC anon key, so access is gated
-- by the authenticated user's email being present in this table.
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  email      text primary key,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Admins may read the allow-list (needed for the client's own check).
drop policy if exists "admins read allow-list" on public.admins;
create policy "admins read allow-list"
  on public.admins for select
  to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Helper used by every policy below. SECURITY DEFINER avoids recursive RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------
-- Extender subscriptions (one row per Tapo P100 plug)
-- ---------------------------------------------------------------------
create table if not exists public.extender_subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  device_name         text not null default 'Extender Unit',
  tapo_ip             text not null default '192.168.1.50',
  subscriber_name     text,
  status              text not null default 'EXPIRED'
                        check (status in ('ACTIVE', 'EXPIRED')),
  expires_at          timestamptz not null default now(),
  last_renewed_at     timestamptz,
  desired_power_state boolean not null default false,
  actual_power_state  boolean not null default false,
  last_heartbeat      timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists extender_subscriptions_expires_at_idx
  on public.extender_subscriptions (expires_at);

alter table public.extender_subscriptions enable row level security;

drop policy if exists "admins read subscriptions"   on public.extender_subscriptions;
drop policy if exists "admins insert subscriptions" on public.extender_subscriptions;
drop policy if exists "admins update subscriptions" on public.extender_subscriptions;
drop policy if exists "admins delete subscriptions" on public.extender_subscriptions;

create policy "admins read subscriptions"
  on public.extender_subscriptions for select
  to authenticated
  using (public.is_admin());

create policy "admins insert subscriptions"
  on public.extender_subscriptions for insert
  to authenticated
  with check (public.is_admin());

create policy "admins update subscriptions"
  on public.extender_subscriptions for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "admins delete subscriptions"
  on public.extender_subscriptions for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- Renewal logs (30-day renewal history)
-- ---------------------------------------------------------------------
create table if not exists public.renewal_logs (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null
                    references public.extender_subscriptions (id) on delete cascade,
  renewed_at      timestamptz not null default now(),
  previous_expiry timestamptz,
  new_expiry      timestamptz not null,
  amount_paid     numeric(10, 2)
);

create index if not exists renewal_logs_subscription_id_idx
  on public.renewal_logs (subscription_id, renewed_at desc);

alter table public.renewal_logs enable row level security;

drop policy if exists "admins read renewal logs"   on public.renewal_logs;
drop policy if exists "admins insert renewal logs" on public.renewal_logs;
drop policy if exists "admins update renewal logs" on public.renewal_logs;
drop policy if exists "admins delete renewal logs" on public.renewal_logs;

create policy "admins read renewal logs"
  on public.renewal_logs for select
  to authenticated
  using (public.is_admin());

create policy "admins insert renewal logs"
  on public.renewal_logs for insert
  to authenticated
  with check (public.is_admin());

create policy "admins update renewal logs"
  on public.renewal_logs for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "admins delete renewal logs"
  on public.renewal_logs for delete
  to authenticated
  using (public.is_admin());

-- The local Python bridge uses the service_role key and bypasses RLS.
-- Do NOT create anon policies for these tables.

-- ---------------------------------------------------------------------
-- Realtime: push plug/bridge changes to the dashboard
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.extender_subscriptions;
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.renewal_logs;
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Setup steps after running this file:
--
-- 1. Authentication → Users → Add user (email + password). Copy the email.
-- 2. Insert that email into the allow-list:
--
--      insert into public.admins (email) values ('admin@example.com');
--
-- 3. Optionally seed a plug (then renew it from the app):
--
--      insert into public.extender_subscriptions
--        (device_name, subscriber_name, tapo_ip, status, expires_at,
--         desired_power_state, actual_power_state)
--      values
--        ('Extender Unit 1', 'Juan Dela Cruz', '192.168.1.50',
--         'EXPIRED', now(), false, false);
--
-- 4. Copy Project URL + anon public key into config.js (or the in-app
--    "Supabase configuration" dialog).
-- ---------------------------------------------------------------------
