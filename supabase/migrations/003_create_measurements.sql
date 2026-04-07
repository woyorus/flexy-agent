-- Plan 013: measurements table for progress tracking.
create table measurements (
  id         uuid primary key,
  user_id    text not null,
  date       date not null,
  weight_kg  numeric(5,2) not null,
  waist_cm   numeric(5,2),
  created_at timestamptz default now()
);
create unique index measurements_user_date on measurements (user_id, date);

alter table measurements enable row level security;
create policy "Allow all for anon" on measurements
  for all using (true) with check (true);
