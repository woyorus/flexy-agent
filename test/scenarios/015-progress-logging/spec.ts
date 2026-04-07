import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '015-progress-logging',
  description: 'Progress: first log with disambiguation, first-measurement hint, already-logged same day, defensive pg_last_report with no completed week',
  clock: '2026-04-09T10:00:00Z',   // Wednesday — clearly mid-week, no completed prior week
  recipeSet: 'minimal',             // generate.ts throws on empty; progress is recipe-independent
  initialState: {},                 // fresh user — no measurements, no plan
  events: [
    command('start'),
    text('📊 Progress'),            // reply keyboard button → text(), NOT click()
    text('82.3 / 91'),              // measurement input — first ever, triggers disambiguation
    click('pg_disambig_yes'),       // confirm weight=82.3, waist=91
    text('📊 Progress'),            // same day — already logged
    click('pg_last_report'),        // defensive: no completed week → "not enough data"
  ],
});
