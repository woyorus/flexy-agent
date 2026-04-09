-- Plan 024: Flexible batch model — allow 1-serving batches.
-- Widen servings constraint from (2,3) to (1,3).
-- No constraint on eating_days contiguity exists in DB — only in code.

ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_servings_check;
ALTER TABLE batches ADD CONSTRAINT batches_servings_check CHECK (servings BETWEEN 1 AND 3);
