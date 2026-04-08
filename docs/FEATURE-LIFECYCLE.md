# Feature Lifecycle: Idea to Production

> Scope: The process for taking a product change from initial idea to shipped code. This is the workflow that every user-facing change follows. It exists because shipping features without product design produces technically functional but experientially broken results. See also: [DOCS-GUIDE.md](./DOCS-GUIDE.md) for where each artifact lives, [design-docs/proposals/README.md](./design-docs/proposals/README.md) for proposal format.

## Why this process exists

Code is easy to write. Good product experiences are hard to design. When we skip from "problem identified" straight to "implementation plan" → "code," we build features that are structurally correct but miss the point. The shopping list generates, but the user can't reach it. The plan exists, but nobody can see it. The buttons work, but they appear at the wrong time.

**The pattern that produces bad features:**
1. Notice a problem
2. Jump to code-level root cause
3. Write an implementation plan
4. Implement
5. Discover the experience is broken

**The pattern that produces good features:**
1. Notice a problem
2. Describe the experience the user should have
3. Discuss, refine, align on the design
4. Write an implementation plan that serves the design
5. Implement
6. Verify the experience matches the design

The difference is step 2-3. Design before code. Experience before architecture.

---

## Product coherence gate

Every feature must trace back to a real user need and align with the product's identity. Before writing a design proposal, answer two questions:

**1. Which job does this serve?** Reference a specific job in [jtbd.md](./product-specs/jtbd.md) (e.g., A1: Know my next action, A2: Shopping list). If no existing job fits, that's a signal — either define a new JTBD first (with a real user trigger, not an invented one), or reconsider whether the feature belongs in this product at all.

**2. Does it align with PRODUCT_SENSE?** Check the change against the principles in [PRODUCT_SENSE.md](./PRODUCT_SENSE.md). A feature that works but violates a core principle (e.g., adding friction where there should be none, tracking where we said we wouldn't, making the user feel judged) is not a good feature. It's a coherent product, not a bag of features.

These are not paperwork. They're the filter that keeps the product focused. A feature that doesn't serve a job and doesn't align with the product's identity should not exist, no matter how easy it is to build.

---

## The five stages

### Stage 1: Design Proposal

**What:** A product/UX document describing what the user should experience. Screens, messages, buttons, emotional arc, edge cases. Written from the user's perspective, not the code's.

**Where:** `docs/design-docs/proposals/NNN-topic.md`

**Who triggers it:** Anyone noticing a product gap, a broken experience, or a new feature need.

**Done when:** The proposal is written and ready for discussion. Status: `draft`.

**Rules:**
- No file paths, no code references, no implementation details
- Must reference which JTBD the change serves
- Must include example screens with actual message text
- Must describe the emotional arc (what the user feels at each step)

### Stage 2: Design Discussion

**What:** Iterative refinement of the proposal through conversation. Challenge assumptions, explore edge cases, consider alternative approaches.

**Where:** The proposal file gets updated in place. Status changes to `discussing`.

**Done when:** The design is clear, complete, and agreed upon. Status: `approved`.

**Rules:**
- The proposal owner updates the doc after each discussion round
- Open questions get resolved or explicitly deferred to "out of scope"
- The approved design is the source of truth for what to build

### Stage 3: Design Doc

**What:** The approved proposal is promoted to a permanent design doc. This is the record of what we decided and why.

**Where:** `docs/design-docs/NNN-topic.md` (same number, moved from proposals/)

**Done when:** The design doc is in the catalog and the proposal is removed from proposals/.

**Rules:**
- Add to the design-docs catalog in `design-docs/index.md`
- Status: `accepted`
- This is the reference document for the implementation plan

### Stage 4: Implementation Plan

**What:** A code-level plan describing how to build what the design doc specifies. File paths, modules, specific changes, test strategy.

**Where:** `docs/plans/active/NNN-topic.md`

**Done when:** The plan is reviewed and approved.

**Rules:**
- Must reference the design doc it implements
- Must not contradict the design doc's experience decisions
- If implementation reveals a design problem, go back to the design doc — don't silently deviate
- Follow existing plan format in `plans/README.md`

### Stage 5: Implementation

**What:** Code changes that fulfill the implementation plan.

**Done when:** Tests pass, experience matches the design doc, specs are updated.

**Rules:**
- Update product specs to reflect the new behavior (same commit as the code)
- Move the plan to `completed/`
- If the implementation diverges from the design, update the design doc to match reality

---

## When to skip stages

Not every change needs the full pipeline. The trigger is: **does this change what the user sees or experiences?**

| Change type | Start at |
|---|---|
| Bug fix that restores intended behavior | Stage 4 (plan) or direct fix |
| Refactor with no UX change | Stage 4 (plan) or direct fix |
| New user-facing feature | Stage 1 (proposal) |
| Changing existing UX (screens, flows, copy) | Stage 1 (proposal) |
| Adding/changing buttons, navigation, menus | Stage 1 (proposal) |
| Infrastructure that enables a future feature | Stage 4 (plan) |
| Fixing a UX problem discovered in production | Stage 1 (proposal) |

**Rule of thumb:** If you're about to write "the user sees..." in a plan, stop. That sentence belongs in a design proposal, not an implementation plan.

---

## Artifacts summary

| Stage | Artifact | Location | Format |
|---|---|---|---|
| 1-2 | Design Proposal | `design-docs/proposals/NNN-topic.md` | [proposals/README.md](./design-docs/proposals/README.md) |
| 3 | Design Doc | `design-docs/NNN-topic.md` | [design-docs/index.md](./design-docs/index.md) |
| 4 | Implementation Plan | `plans/active/NNN-topic.md` | [plans/README.md](./plans/README.md) |
| 5 | Updated Specs | `product-specs/*.md` | [product-specs/index.md](./product-specs/index.md) |
