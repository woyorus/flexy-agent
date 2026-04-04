# Backlog

> Scope: What the current version delivers, what's out of scope, and the versioned feature roadmap. See also: [product-specs/](./product-specs/) for what IS built, [PRODUCT_SENSE.md](./PRODUCT_SENSE.md) for the vision.

## Current version: v0.0.3

### What v0.0.3 delivers

- Guided weekly planning session via Telegram (suggestive-first — system proposes, user approves)
- Budget solver using real per-serving recipe macros (not uniform distribution)
- Flex budget system (flex slots + treat budget, replacing individual fun food items)
- Plan-proposer sub-agent with variety engine and flex slot suggestions
- Inline recipe gap resolution during planning (generate recipes for variety gaps mid-session)
- Recipe database (markdown files) with CRUD via Telegram
- Paginated recipe list UI with view/edit/delete
- Recipe generation with multi-turn refinement and QA correction loop
- Recipe scaling to hit solver targets
- Restaurant meal estimation
- Shopping list aggregated from weekly plan
- Budget view (read-only)
- Voice input via Whisper for all free-form inputs
- Structured recipe components (breakfast + lunch/dinner)
- Debug logging system (full AI call traces, flow state transitions)

### Explicitly out of scope (v0.0.3)

| Feature | Reason | Planned for |
|---|---|---|
| Photo tracking | Needs vision model integration | v0.0.4 |
| Voice/text tracking | Needs running budget state | v0.0.4 |
| Mid-week adjustment | Needs tracking first | v0.0.4 |
| Three-tier notifications | Needs tracking + adjustment | v0.0.4 |
| Proactive nudges | Needs scheduled messages | v0.0.5 |
| Breakfast variety | Nice-to-have, not core | v0.0.5 |
| Ingredient-aware suggestions | Needs ingredient inventory | v0.0.6 |
| Recipe import from URL/photo | Nice-to-have | v0.0.6 |
| User onboarding (macro calc) | Needed for multi-user | v0.1.0 |
| Multi-user support | Not needed for prototype | v0.1.0 |
| Alternative UI (web/app) | Telegram is sufficient for now | v0.1.0+ |

## Roadmap

### v0.0.4 — Tracking and adjustment

The system becomes dynamic. User reports what happened, agent rebalances.

- **Photo tracking**: Snap a meal photo, vision model estimates calories. Two taps.
- **Voice/text tracking**: "Had carbonara at that Italian place." Agent extracts estimate.
- **Running budget**: Planned vs. actual, updated as tracking comes in.
- **Three-tier adjustment system**:
  - Silent (< 300 cal): Budget updates, no notification
  - Informational (300-800 cal): Gentle FYI with optional lever
  - Replan offer (800+ cal or budget-threatening drift): Explicit rebalance offer
- **Mid-week replanning**: When deviation is large, agent proposes minimal adjustments to remaining days.

### v0.0.5 — Polish and proactivity

- **Planning nudge**: Agent sends one message when it's time to plan next week.
- **Breakfast variety**: Agent suggests different breakfasts based on recent history.
- **Recipe rotation**: Track when recipes were last used, avoid repeating too soon.
- **Week-end review**: Brief, non-judgmental summary of the week.

### v0.0.6 — Intelligence

- **Ingredient-aware suggestions**: "I have zucchini and peppers to use up."
- **Recipe import**: Send a URL, photo, or text of a recipe. Agent parses and structures it.
- **Pattern learning**: Agent notices trends and adjusts planning defaults.
- **Carry-over logic**: Smart surplus/deficit handling between weeks.

### v0.1.0 — Multi-user readiness

- **Onboarding flow**: Calculate personalized targets from user data.
- **User preferences**: Stored dietary/cuisine/ingredient preferences.
- **Multi-user state**: Supabase schema supports multiple users.
- **Alternative UI**: Web UI or app if needed.
