-- Flexie v0.0.1 — Supabase schema
-- Run this in the Supabase SQL Editor to create the required tables.

-- Weekly plans: stores the full WeeklyPlan object as JSONB.
-- Queried by user_id + status + week_start.
create table weekly_plans (
  id         text primary key,
  user_id    text not null default 'default',
  week_start date not null,
  status     text not null check (status in ('planning', 'active', 'completed')),
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_weekly_plans_user_status on weekly_plans (user_id, status, week_start desc);

-- Session state: one row per user, stores the current SessionState as JSONB.
-- v0.0.1 is single-user — there will be exactly one row with user_id = 'default'.
create table session_state (
  user_id    text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row-level security: disabled for v0.0.1 (single-user, server-side only).
-- Enable and add policies when multi-user support lands in v0.1.0.
alter table weekly_plans enable row level security;
alter table session_state enable row level security;

-- Allow the anon key full access (single-user, no public exposure).
create policy "Allow all for anon" on weekly_plans
  for all using (true) with check (true);

create policy "Allow all for anon" on session_state
  for all using (true) with check (true);
