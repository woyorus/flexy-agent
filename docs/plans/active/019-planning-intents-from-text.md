# Plan 019: Route free-text intents during planning — swap, start over, remove event

**Status:** Implemented
**Date:** 2026-04-07
**Affects:** `src/telegram/core.ts`, `src/agents/plan-flow.ts`

## Problem

### Free text is dead during most of the plan flow

The plan flow has 10 phases. Only 4 accept free text: `awaiting_events`, `awaiting_recipe_prefs`, `awaiting_swap`, `reviewing_recipe`. The remaining 6 phases — including `proposal` (the plan is on screen) and `recipe_suggestion` (gap-fill prompt) — dump every typed message into a generic fallback:

> "I can help with your plan, recipes, shopping, or measurements. Try: 'change Thursday dinner' or tap a button."

This means: when the user is looking at their plan with `[Looks good] [Swap something]` and types "I don't want to begin my week with a flex meal. Make it on Sunday," the system **ignores it**. The user must tap [Swap something] first, then retype the exact same message.

The fallback path in `core.ts:1380-1447`:
1. Checks if `session.planFlow` exists
2. Checks if `phase` is one of the 4 text-accepting phases
3. If not → `replyFreeTextFallback()` (line 1447)

### Three intents that must work during planning

**1. Swap intent from `proposal` phase**

The user sees the plan and wants to change something. They type it. The system already has a swap classifier (`handleSwapText` at `plan-flow.ts:766`) that understands natural language swap requests via the nano LLM. But it's only reachable after the user taps `[Swap something]` and enters `awaiting_swap`.

**What the user experienced (log line 1153):**
- Phase: `proposal` (plan on screen)
- Input: "I don't want to begin my week with a flex meal. Make it on Sunday"
- Expected: system classifies this as a flex_move and processes it
- Actual: generic fallback, user must tap button and retype

The swap classifier is the right handler for this text. The `proposal` phase should route unrecognized text through the same swap classification path that `awaiting_swap` uses, without requiring the button-tap ceremony.

**2. "Start over" intent**

The user is stuck — the plan is bad, the gap-fill flow is a dead end, they want to throw it out and re-plan from scratch. "Start over" is a natural thing to say. The system doesn't understand it.

**What the user experienced (log line 1231):**
- Phase: `recipe_suggestion` (gap-fill, asking to pick a recipe for Wed dinner)
- Input: "Start over"
- Expected: plan flow resets, user returns to the beginning of Plan Week
- Actual: generic fallback

Today, the only escape is the `/start` command (`core.ts:327`), which resets all flows. No user will discover this naturally. "Start over," "scrap this," "redo," "cancel the plan," "start from scratch" — these all mean the same thing and should work from any plan flow phase.

This doesn't need an LLM. A simple keyword/pattern match against common reset phrases is sufficient and instant.

**3. "Remove event" intent**

The user added an event during the planning flow and now wants to remove it — either because they added it by mistake, or because they're trying to simplify the plan.

**What the user experienced (log line 1237):**
- Phase: none (had fallen out of plan flow after fallback)
- Input: "Remove event on Thursday"
- Expected: the Thursday event is removed from the plan draft
- Actual: generic fallback

This should work during the `proposal` phase (and ideally `awaiting_swap`). It's closely related to the swap flow — the swap classifier could handle a new `event_remove` intent type, or the event text handler could accept removals.

**4. "Cancel" intent — exit the planning flow**

Distinct from "start over." "Start over" means restart planning from scratch. "Cancel" means stop planning entirely — get out of the flow, go back to the main menu. "Nevermind," "forget it," "stop," "I'll do this later," "cancel" — all mean the same thing.

Today, the only exit from an in-progress plan flow is the `/start` command (`core.ts:327`), which no user will discover naturally. Tapping a main menu button like [My Recipes] works as a temporary detour (the plan flow is preserved and [Resume Plan] brings you back), but there's no way to say "I don't want to plan right now, just let me go."

This should work from any plan flow phase. Like "start over," it doesn't need an LLM — simple pattern match. The action is: clear `session.planFlow`, show the main menu with the lifecycle-appropriate keyboard.

### Why this matters

The user used the app for 10 minutes and hit the fallback wall 3 times. Each time, they had a perfectly clear intent that the system ignored. This is the #1 friction pattern identified in `PRODUCT_SENSE.md` — the system makes the user fight it instead of understanding them. The freeform conversation layer (v0.0.5) will eventually solve this broadly, but these four intents are critical now because they come up every single planning session.

### Boundary: what this plan does NOT cover

- The full freeform conversation layer (contextual questions, domain questions, side conversations). That's v0.0.5.
- Free-text routing outside of the plan flow (e.g., from the main menu, from recipe view).
- The "breakfast change" button stub (`plan-flow.ts` — "Breakfast changes are coming soon"). That's a separate feature gap.
