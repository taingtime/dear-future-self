-- Dear Future Self — preference pins
-- Context-triggered reminders (location + tags). Separate from capsules
-- because pins have no delivery date; they fire when context matches.

do $$ begin
  create type pin_sentiment as enum ('positive', 'negative', 'neutral');
exception when duplicate_object then null; end $$;

create table if not exists public.preference_pins (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,

  -- the reminder itself
  title text not null,          -- e.g. "Mala noodles were the good order"
  body text,                    -- longer note / details
  sentiment pin_sentiment default 'neutral',

  -- geofence (all optional; a pin can be tag-only)
  place_name text,              -- e.g. "Golden Wok"
  place_address text,           -- free-form address (human-readable)
  latitude double precision,
  longitude double precision,
  radius_meters integer default 150,

  -- tags for text/keyword triggering
  tags text[] not null default '{}',

  -- state
  active boolean not null default true,
  last_triggered_at timestamptz,
  trigger_count integer not null default 0,

  created_at timestamptz not null default now(),

  -- a pin must anchor on either a location OR at least one tag
  constraint at_least_one_anchor
    check (
      (latitude is not null and longitude is not null)
      or array_length(tags, 1) >= 1
    )
);

create index if not exists pins_author_idx on public.preference_pins(author_id);
create index if not exists pins_active_idx on public.preference_pins(active) where active = true;
create index if not exists pins_tags_idx on public.preference_pins using gin(tags);

-- RLS
alter table public.preference_pins enable row level security;

drop policy if exists "pins self-read" on public.preference_pins;
create policy "pins self-read" on public.preference_pins
  for select using (auth.uid() = author_id);

drop policy if exists "pins self-insert" on public.preference_pins;
create policy "pins self-insert" on public.preference_pins
  for insert with check (auth.uid() = author_id);

drop policy if exists "pins self-update" on public.preference_pins;
create policy "pins self-update" on public.preference_pins
  for update using (auth.uid() = author_id);

drop policy if exists "pins self-delete" on public.preference_pins;
create policy "pins self-delete" on public.preference_pins
  for delete using (auth.uid() = author_id);
