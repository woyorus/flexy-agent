# Plans

> Scope: Execution plans for multi-step changes. See also: [DOCS-GUIDE.md](../DOCS-GUIDE.md) for routing rules, [BACKLOG.md](../BACKLOG.md) for feature roadmap.

## Structure

- `active/` — Plans in progress or parked for future work.
- `completed/` — Finished plans, kept as decision history.
- `tech-debt.md` — Running inventory of known debt.

## When to create a plan

- Change spans multiple files/systems and needs coordinated steps.
- Work is complex enough to lose context between sessions.
- You want to align on approach before implementation.

Do not create a plan for single-file fixes or changes completable in one session.

## Naming

Sequential numbering: `NNN-<topic>.md`. Check the highest number across both `active/` and `completed/`.

## Required format

```markdown
# Plan NNN: [Short description]

**Status:** Active | Parked | Phase N of M complete
**Date:** YYYY-MM-DD
**Affects:** [modules/systems touched]

## Problem

What's wrong or missing, and why it matters.

## Plan of work

Sequence of changes — name files and modules.

## Progress

- [x] Completed step
- [ ] Pending step

## Decision log

- Decision: ...
  Rationale: ...
  Date: ...

## Validation

How to verify the change works.
```

For larger plans, also add: **Surprises & discoveries**, **Outcomes & retrospective**.

## Completing a plan

1. Update status to `Completed`.
2. Move from `active/` to `completed/`.
3. Promote lasting decisions into the relevant spec or design doc.

# Feedback

Empty section where I (or another agent) leaves the feedback for you to iterate on.
