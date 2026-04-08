# Docs Management Guide

> Scope: When and where to create new docs. Each folder has its own format guidance — see links at the bottom.

## Routing

| What you have | Where it goes |
|---|---|
| Product/UX change idea | `design-docs/proposals/NNN-<topic>.md` — start here for anything that changes the user experience. See [FEATURE-LIFECYCLE.md](./FEATURE-LIFECYCLE.md). |
| Approved product/UX design | `design-docs/<topic>.md` — promoted from proposals/ after discussion. |
| Significant technical decision or tradeoff | `design-docs/<topic>.md` — directly, no proposal needed for non-UX changes. |
| Current system behavior | `product-specs/<domain>.md` |
| Multi-step change needing coordination | `plans/active/NNN-<topic>.md` |
| Deferred cleanup or workaround | `plans/tech-debt.md` |
| Future features or scope boundaries | `BACKLOG.md` |
| Product philosophy or principles | `PRODUCT_SENSE.md` |
| Codebase structure or module map | `ARCHITECTURE.md` |

## Creation rules

- Every new doc starts with a scope line: `> Scope: [what]. See also: [related].`
- Every new doc gets added to its folder's index AND to the docs index in CLAUDE.md — same commit.
- Deleting or moving a doc — update both indexes in the same commit.

## Lifecycle

- **Design proposals** start in `design-docs/proposals/`. Lifecycle: draft → discussing → approved (promote to design doc) or rejected (keep file with rationale). See [FEATURE-LIFECYCLE.md](./FEATURE-LIFECYCLE.md).
- **Design docs** are never deleted. Lifecycle: accepted → superseded.
- **Product specs** reflect actual code. Update when code changes — same commit.
- **Plans** start in `plans/active/`. Move to `plans/completed/` when done. Promote lasting decisions into specs or design docs.
- **Tech debt** items that grow into multi-step work graduate into a plan.

## Size limits

- Product specs: split at ~300 lines.
- PRODUCT_SENSE.md: split at ~400 lines.
- Plans: one plan per coordinated change.

## Format and templates

Each folder has its own:
- [product-specs/index.md](./product-specs/index.md)
- [design-docs/index.md](./design-docs/index.md)
- [plans/README.md](./plans/README.md)
