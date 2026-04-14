-- Plan 033 / design doc 006: per-batch and per-session overrides for the
-- emergency ingredient swap flow. A swap mutates the planned batch's
-- contents in place (and, for a breakfast swap, the session's materialized
-- breakfast override) without touching the library recipe.

alter table batches add column name_override text;
alter table batches add column body_override text;
alter table batches add column swap_history jsonb not null default '[]';

-- Plan sessions get a nullable override that is materialized only once the
-- first emergency swap commits against a session's breakfast. Absent means
-- "breakfast matches the library recipe scaled by caloriesPerDay /
-- proteinPerDay"; present means the renderer / shopping-list generator /
-- dispatcher should read the override instead.
alter table plan_sessions add column breakfast_override jsonb;
