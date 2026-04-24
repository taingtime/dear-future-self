-- Dear Future Self — initial schema
-- Run this in the Supabase SQL editor, or via `supabase db push`.

-- =========================================================
-- Extensions
-- =========================================================
create extension if not exists "pgcrypto";
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- =========================================================
-- profiles: one row per auth user
-- =========================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

-- auto-create profile row on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =========================================================
-- capsules: the core deliverable
-- =========================================================
do $$ begin
  create type capsule_type as enum (
    'letter_self',
    'letter_other',
    'gesture',
    'experience',
    'micro_gift'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type capsule_status as enum ('scheduled', 'delivered', 'cancelled', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.capsules (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  type capsule_type not null,

  -- content
  title text,
  body text not null,
  seal_note text,                 -- "what's going on in my life right now" context
  gesture_prompt text,            -- the small ask for gesture-type capsules

  -- recipient (null for letter_self / experience / gesture-to-self)
  recipient_email text,
  recipient_name text,
  from_name text,                 -- how to sign it

  -- micro gift fields (pledge model in v1 — no money moves)
  gift_amount_cents integer,      -- amount pledged in cents, if any
  gift_currency text default 'USD',
  gift_link text,                 -- optional link (gift card, playlist, photo)

  -- delivery
  deliver_at timestamptz not null,
  delivered_at timestamptz,
  status capsule_status not null default 'scheduled',
  delivery_error text,

  created_at timestamptz not null default now(),

  constraint deliver_in_future check (deliver_at > created_at),
  constraint recipient_required_for_other
    check (type <> 'letter_other' or (recipient_email is not null))
);

create index if not exists capsules_author_idx on public.capsules(author_id);
create index if not exists capsules_due_idx
  on public.capsules(deliver_at)
  where status = 'scheduled';

-- =========================================================
-- Row Level Security
-- =========================================================
alter table public.profiles enable row level security;
alter table public.capsules enable row level security;

drop policy if exists "profiles self-read" on public.profiles;
create policy "profiles self-read" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles self-update" on public.profiles;
create policy "profiles self-update" on public.profiles
  for update using (auth.uid() = id);

drop policy if exists "capsules self-read" on public.capsules;
create policy "capsules self-read" on public.capsules
  for select using (auth.uid() = author_id);

drop policy if exists "capsules self-insert" on public.capsules;
create policy "capsules self-insert" on public.capsules
  for insert with check (auth.uid() = author_id);

drop policy if exists "capsules self-update-while-scheduled" on public.capsules;
create policy "capsules self-update-while-scheduled" on public.capsules
  for update using (auth.uid() = author_id and status = 'scheduled');

drop policy if exists "capsules self-delete-while-scheduled" on public.capsules;
create policy "capsules self-delete-while-scheduled" on public.capsules
  for delete using (auth.uid() = author_id and status = 'scheduled');

-- =========================================================
-- Scheduled delivery
-- =========================================================
-- This cron job runs every 5 minutes and pings the deliver-capsules edge
-- function, which finds capsules with deliver_at <= now() and sends emails.
--
-- Replace <PROJECT_REF> and set the service role key in Vault before enabling.
-- See README for step-by-step setup.
--
-- Example (run once after deploying the edge function):
--
--   select cron.schedule(
--     'deliver-capsules-every-5-min',
--     '*/5 * * * *',
--     $$
--       select net.http_post(
--         url := 'https://<PROJECT_REF>.functions.supabase.co/deliver-capsules',
--         headers := jsonb_build_object(
--           'Content-Type', 'application/json',
--           'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
--         ),
--         body := '{}'::jsonb
--       ) as request_id;
--     $$
--   );
