-- Plan 007: Rolling 7-day horizon + first-class batches
-- Run this manually in the Supabase SQL Editor before Phase 2 code lands.
-- Does NOT drop weekly_plans — that happens in migration 002 (Phase 7b).

-- Plan sessions: lightweight markers for confirmed 7-day horizons.
-- Drafts are in-memory only (D33) — every row here has confirmed_at NOT NULL.
-- The superseded flag is a tombstone for D27's replace-future-only flow.
create table plan_sessions (
  id                uuid primary key,
  user_id           text not null,
  horizon_start     date not null,
  horizon_end       date not null,
  breakfast         jsonb not null,
  treat_budget_calories int not null,
  flex_slots        jsonb not null default '[]',
  events            jsonb not null default '[]',
  confirmed_at      timestamptz not null default now(),
  superseded        boolean not null default false,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Partial index: common-path queries filter NOT superseded. Superseded rows
-- are audit history that normal code paths never scan.
create index plan_sessions_user_horizon on plan_sessions (user_id, horizon_start desc)
  where not superseded;

-- First-class batches. FK to plan_sessions with ON DELETE RESTRICT —
-- sessions with live batches cannot be physically deleted. D27's replace flow
-- marks the session superseded and cancels its batches rather than deleting rows.
create table batches (
  id                         uuid primary key,
  user_id                    text not null,
  recipe_slug                text not null,
  meal_type                  text not null check (meal_type in ('lunch', 'dinner')),
  eating_days                date[] not null,
  servings                   int not null check (servings between 2 and 3),
  target_per_serving         jsonb not null,
  actual_per_serving         jsonb not null,
  scaled_ingredients         jsonb not null,
  status                     text not null check (status in ('planned', 'cancelled')),
  created_in_plan_session_id uuid not null references plan_sessions(id) on delete restrict,
  created_at                 timestamptz default now(),
  updated_at                 timestamptz default now()
);

-- GIN index on eating_days for overlap queries: eating_days && ARRAY[...]::date[]
create index batches_eating_days_gin on batches using gin (eating_days);

-- Supporting indexes for common query patterns
create index batches_user_status on batches (user_id, status);
create index batches_session_id on batches (created_in_plan_session_id);

-- RLS: same permissive policy as existing tables (single-user, server-side only)
alter table plan_sessions enable row level security;
alter table batches enable row level security;

create policy "Allow all for anon" on plan_sessions
  for all using (true) with check (true);

create policy "Allow all for anon" on batches
  for all using (true) with check (true);
