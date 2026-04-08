# Design Proposals

> Scope: Working drafts for product/UX changes. A proposal describes the experience the user should have — screens, flows, copy, emotional arc — before any code is written. See also: [../index.md](../index.md) for accepted design docs, [../../FEATURE-LIFECYCLE.md](../../FEATURE-LIFECYCLE.md) for the full idea-to-production process.

## When to create a proposal

Before any change that affects what the user sees or experiences. If the change touches:
- A screen, message, or button the user interacts with
- The flow or sequence of a user-facing conversation
- The information or tone of what the product communicates
- Navigation, state transitions, or what's visible when

Then it starts as a design proposal. Not a plan. Not code.

Implementation plans and code come AFTER the proposal is discussed, refined, and promoted to a design doc. See [FEATURE-LIFECYCLE.md](../../FEATURE-LIFECYCLE.md).

## What a proposal is NOT

- Not an implementation plan (no file paths, no code changes, no module names)
- Not a design doc (those are finalized decisions — proposals are working drafts)
- Not a spec update (specs describe what IS, proposals describe what SHOULD BE)

## Format

```markdown
# [Feature/Change Title]

> Status: draft | discussing | approved | rejected
> Date: YYYY-MM-DD
> JTBD: [which jobs this serves — reference jtbd.md]
> PRODUCT_SENSE alignment: [one line confirming this fits the product's identity]

## Problem

What's broken or missing, from the USER's perspective. Describe the experience,
not the code. What does the user see? What do they feel? What can't they do?

## Current experience

What happens today. Include example messages, button layouts, and the emotional
arc. Make the pain concrete.

## Proposed experience

Screen-by-screen walkthrough of what should happen. For each screen:
- Example message text (use the actual format — markdown, buttons, etc.)
- What buttons/navigation are available
- What the user is thinking/feeling at this moment
- How this connects to the next screen

## Design decisions

Key choices made in the proposal and why. Reference JTBD and PRODUCT_SENSE
where relevant. Call out what you considered and rejected.

## Edge cases

Scenarios that don't fit the happy path. How does the design handle them?

## Out of scope

What this proposal intentionally doesn't address. Prevents scope creep during
discussion.
```

## Lifecycle

1. **Draft** — Initial write-up. May have open questions.
2. **Discussing** — Under active review. Being refined through conversation.
3. **Approved** — Design is agreed upon. Promote to `design-docs/` as an accepted design doc, then create an implementation plan.
4. **Rejected** — Design was not viable. Keep the file (decisions NOT to do something are worth recording). Add a note explaining why.

## Naming

`NNN-short-description.md` — sequential numbering shared with `design-docs/`. Check the highest number across both `proposals/` and the parent `design-docs/` directory before creating a new one.

## Current proposals

(none yet)
