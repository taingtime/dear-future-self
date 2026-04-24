-- Starter migration. Profiles + auth trigger + RLS.
-- Add your own domain tables in 002_*.sql, 003_*.sql, etc.

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

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

alter table public.profiles enable row level security;
drop policy if exists "profiles self-read" on public.profiles;
create policy "profiles self-read" on public.profiles for select using (auth.uid() = id);
drop policy if exists "profiles self-update" on public.profiles;
create policy "profiles self-update" on public.profiles for update using (auth.uid() = id);
