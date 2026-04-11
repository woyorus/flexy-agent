-- Plan 026: Persist re-proposer mutation history on plan sessions.
-- Enables post-confirmation mutations to respect every prior user-approved
-- change across save-before-destroy writes (see docs/plans/active/026-*.md).
--
-- Shape per row is MutationRecord[] = Array<{ constraint: string; appliedAt: string }>.
-- Default [] so every existing row is non-null and every INSERT without the
-- field gets an empty array.

ALTER TABLE plan_sessions
  ADD COLUMN mutation_history jsonb NOT NULL DEFAULT '[]'::jsonb;
