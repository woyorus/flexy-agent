-- Plan 007 Phase 7b: Drop the legacy weekly_plans table.
-- Run this manually in the Supabase SQL Editor after confirming
-- that plan_sessions + batches tables are live and populated.
-- The weekly_plans table is no longer read or written by any code path.

DROP TABLE IF EXISTS weekly_plans;
