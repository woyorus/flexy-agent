# Scenario Migration Tech Debt

Bugs and oddities discovered during Plan 032's audit cycle one that do not
block certification of the specific scenario in which they were found.
Load-bearing bugs (ones that DO block certification) are fixed inline
during the audit and do not appear here.

This file is a running inventory. Entries are opened during the audit and
closed as follow-up work lands. The file is NOT part of a plan lifecycle
and does not move between `active/` and `completed/`; it lives at
`docs/plans/scenario-migration-tech-debt.md` as long as any entry is open.

See Plan 032 § "When migration surfaces a bug" for the triage rules that
route bugs into this file vs. `docs/plans/tech-debt.md` vs. an inline fix.

## Entry format

Each entry uses this template:

```
### <short-slug>

- **Discovered in:** scenario NNN-name (Wave X)
- **Classification:** adjacent | cross-scenario
- **Severity:** cosmetic | functional | unclear-intent
- **Symptom:** What the recording shows vs. what it should show. Name
  specific output indices, session fields, or store entries where
  relevant.
- **Scope:** Which scenarios are affected. "Only this scenario" or a
  listed set, or "unknown — sweep needed".
- **Fix direction:** Short hint where to look. If no hypothesis,
  "needs investigation".
- **Blocked certification?** No (scenario certified around this) | Yes
  (scenario NNN remains uncertified; listed here so Phase J can
  reconcile).
```

## Open

(No entries yet.)

## Closed

(No entries yet.)
