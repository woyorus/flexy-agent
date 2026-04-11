-- Flexie — Supabase schema (Plan 007: rolling horizons + first-class batches)
-- This is the canonical post-migration snapshot. For migration history, see supabase/migrations/.

-- Plan sessions: confirmed 7-day horizons. Drafts are in-memory only (D33).
create table plan_sessions (
  id                uuid primary key,
  user_id           text not null,
  horizon_start     date not null,
  horizon_end       date not null,
  breakfast         jsonb not null,
  treat_budget_calories int not null,
  flex_slots        jsonb not null default '[]',
  events            jsonb not null default '[]',
  mutation_history  jsonb not null default '[]',
  confirmed_at      timestamptz not null default now(),
  superseded        boolean not null default false,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index plan_sessions_user_horizon on plan_sessions (user_id, horizon_start desc)
  where not superseded;

-- First-class batches. FK to plan_sessions with ON DELETE RESTRICT.
create table batches (
  id                         uuid primary key,
  user_id                    text not null,
  recipe_slug                text not null,
  meal_type                  text not null check (meal_type in ('lunch', 'dinner')),
  eating_days                date[] not null,
  servings                   int not null check (servings between 1 and 3),
  target_per_serving         jsonb not null,
  actual_per_serving         jsonb not null,
  scaled_ingredients         jsonb not null,
  status                     text not null check (status in ('planned', 'cancelled')),
  created_in_plan_session_id uuid not null references plan_sessions(id) on delete restrict,
  created_at                 timestamptz default now(),
  updated_at                 timestamptz default now()
);

create index batches_eating_days_gin on batches using gin (eating_days);
create index batches_user_status on batches (user_id, status);
create index batches_session_id on batches (created_in_plan_session_id);

-- Measurements: daily weight and optional waist tracking.
create table measurements (
  id         uuid primary key,
  user_id    text not null,
  date       date not null,
  weight_kg  numeric(5,2) not null,
  waist_cm   numeric(5,2),
  created_at timestamptz default now()
);
create unique index measurements_user_date on measurements (user_id, date);

-- Session state: one row per user, stores the current SessionState as JSONB.
create table session_state (
  user_id    text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row-level security: disabled for v0.0.4 (single-user, server-side only).
alter table plan_sessions enable row level security;
alter table batches enable row level security;
alter table session_state enable row level security;

create policy "Allow all for anon" on plan_sessions
  for all using (true) with check (true);

create policy "Allow all for anon" on batches
  for all using (true) with check (true);

create policy "Allow all for anon" on session_state
  for all using (true) with check (true);

alter table measurements enable row level security;
create policy "Allow all for anon" on measurements
  for all using (true) with check (true);
