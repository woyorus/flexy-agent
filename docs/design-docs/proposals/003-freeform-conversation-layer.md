# Freeform Conversation Layer

> Status: approved
> Date: 2026-04-10
> JTBD: **C1 (missing ingredients) and C2 (unplanned social meal) are the primary jobs served** — this proposal exists to make those jobs addressable at all by delivering post-confirmation plan mutation. D1 (check budget after deviation) is a secondary read-only path. A1 (next action), A2 (shopping list), A4 (browse week), A5 (flex budget), and D2 (log measurements) get small freeform affordances as a side effect. Note: A6 (treat tracking) and the compound form of C2 (automatic eating-out event with calorie absorption) are committed in the catalog but their handlers are deferred to follow-up plans.
> PRODUCT_SENSE alignment: **Flexibility is required** (principle 4) and **real life is the main environment** (principle 7). A plan that freezes on confirmation fails both principles. This proposal delivers the post-confirmation mutation entry point that makes the plan a living document, and bundles the supporting freeform infrastructure (dispatcher, catalog, state preservation) that makes the capability reachable and safe.

## Problem

**This proposal exists for one primary reason: to make the confirmed plan a living document that adapts to real life.** Everything else in this document is either infrastructure that enables that capability or a convenience that becomes cheap once the infrastructure exists. Read the proposal with that priority in mind.

Flexie is a flexible-diet product. Flexibility is in the name and in the method — PRODUCT_SENSE principle 4 states this directly: "the system should bend without breaking", and principle 7 states that restaurants, cravings, weekends, family meals, takeout, and social plans "are not edge cases — they are the actual operating environment." JTBD C1, C2, and D1 are all about real life diverging from the plan: missing ingredients, unplanned restaurants, deviations that need to be absorbed. Every one of them assumes the plan is not frozen.

**Today the plan IS frozen.** The moment the user taps Confirm, the plan becomes fiction waiting to be falsified by the first real-life deviation. This is the #1 pain this proposal addresses:

- **The confirmed plan has no entry point for adaptation.** The user confirmed a week. On Tuesday they get invited to dinner with friends. Wednesday's planned tagine batch was supposed to cover Tuesday + Wednesday + Thursday. The user opens Telegram to say "I'm eating out Tuesday" — and the product has nowhere to receive that. They can't move the flex to a different day. They can't swap tomorrow's recipe because they're out of one ingredient. They can't report a real meal they already ate. The plan is stuck, reality has moved on, and the product is now a lie the user is pretending to follow. The only recourse is to abandon the plan and start a new planning session — which loses all the food already cooked, all the shopping already done, all the mental state the user has built. **The product shipped to production on 2026-04-08 and the plan didn't survive the first day** (quoting design doc 002): the user planned a week, cooked lunch, went to an unplanned Indian restaurant dinner, and the plan became fiction from that point forward. Every future day was wrong. That scenario is the origin story of this proposal and the motivation for v0.0.5.

This is the pain that matters. If the freeform layer fixes nothing else, it has to fix this. Design doc 002 (plans that survive real life) already established the architecture — the re-proposer is the single facility that keeps the plan alive when anything changes, and it works beautifully during the planning session. What's missing is the **entry point that lets the user reach the re-proposer after they've confirmed**. That's what this proposal builds.

Secondary pains fall out naturally once the freeform dispatcher exists:

- **Side questions during any flow are unreachable.** A user mid-planning wonders "can I freeze the tagine?" or "why so much pasta this week?" They type it. The planning flow either swallows the message or the fallback kicks in. The user learns that typing during planning is risky and starts scrolling in silence. This is a paper cut compared to the living-document pain, but it's real and cheap to fix.
- **General food/nutrition questions get no answer.** The product has a food-aware LLM inside it, but users can't actually talk to it. They tab over to ChatGPT. A small trust loss per occurrence, but frequent.
- **Typing a recipe name outside the plan view's hot buttons produces no result.** The plan view already has quick-access cook buttons, so this is marginal on that surface — but on any other surface, there's no conversational path to viewing a recipe.

These secondary pains aren't why the proposal exists. They're why it's **worth writing once**: the same dispatcher that enables post-confirmation mutation also enables all the small affordances, so we get them for the marginal cost of a catalog entry and a handler.

v0.0.4 validated (Plan 025) that a single reasoning LLM call replacing 800 lines of deterministic mutation handlers can make the product feel more natural while making the code simpler. v0.0.5 has to extend that same pattern **from "the plan gets built" to "the plan stays alive"**. Not more intents. Not a bigger router. The same agentic shape, applied to the moment that matters most: the day the user's real life diverges from their plan.

**This proposal supersedes the "Freeform conversation layer" sketch in `docs/product-specs/ui-architecture.md`.** That spec section currently describes a thin nano LLM intent classifier with a small taxonomy (flow_input / contextual_question / domain_question). This proposal specifies a GPT-5.4-mini high-reasoning single-call action dispatcher with a larger structured catalog. The architectures are different, and **this proposal is the canonical one** once promoted to a design doc. The `ui-architecture.md` spec will be updated as part of the implementation work to match what gets built, in the same commit as the code.

## Current experience

What the user feels today, in order of importance:

**The plan freezes into fiction after confirmation**
User confirmed their week on Sunday. Monday went as planned. Tuesday morning a friend invites them to dinner. They open Telegram to tell Flexie. The plan view shows tonight's planned dinner — tagine, reheat — as if nothing has changed. There's a reply keyboard with [My Plan] [Shopping List] [My Recipes] [Progress]. There's no button called "life happened". There's no text entry prompt. The user tries typing "I'm eating out Tuesday" into the chat — nothing useful happens.

The user's mental model: "I'll just tell Flexie what changed and it'll adjust." The product's behavior: the typed message bounces off the fallback or gets ignored. The user now has three options, all bad:

1. **Follow the plan in fiction.** Pretend tonight's tagine serving happened. Reality: it didn't. Wednesday the user opens the plan, sees "tagine reheat serving 3 of 3" for dinner, but only serving 1 was actually eaten (Monday dinner) — Tuesday was the dinner out. The plan is now a lie. Every day after the deviation is incorrect in some way, and the fridge inventory doesn't match the plan's bookkeeping.
2. **Abandon the plan and start a new planning session.** Loses all progress — the shopping already done for the rest of the week, the food already cooked in the fridge, the mental model the user had built about when they'd cook what. Wasteful and demoralizing.
3. **Stop using the product.** The most likely outcome, because options 1 and 2 both feel worse than nothing. This is the adherence failure mode the whole product exists to prevent.

**This is the origin-story pain.** The product shipped to production on 2026-04-08. The user planned a week, cooked lunch, and then went to an unplanned Indian restaurant for dinner with friends. From that moment the plan was fiction. Design doc 002 identified this and established the re-proposer as the architecture. What's still missing is the entry point — the way the user actually reaches the re-proposer after confirming. That's the gap this proposal closes.

**Typing mid-planning** (secondary pain)
User is reviewing a proposed plan during their Sunday session. They wonder "why is there so much pasta this week?" They type it. The planning flow swallows the message as an attempted mutation or the fallback kicks in. They learn that typing during planning is risky. Paper cut.

**Asking a food question** (secondary pain)
User is on a recipe view. They wonder "what's a good substitute for tahini?" The product doesn't answer — it has no concept of domain questions. They tab to ChatGPT. Small trust loss per occurrence.

**Typing a recipe name outside the plan view's hot buttons** (secondary pain)
User on the shopping surface types "calamari pasta" expecting to jump to the recipe. Nothing happens. The plan view has quick-access buttons for imminent recipes, but other surfaces don't. Minor affordance gap.

Flow-expecting phases (awaiting_events, awaiting_preferences, proposal-with-mutation, reviewing-recipe) and the numeric progress parser work correctly. Everything else is silent, wrong, or a generic fallback.

## Proposed experience

A single architectural change with broad user-visible consequences: every inbound text/voice message is routed through a reasoning LLM dispatcher that understands what the user wants and routes it to the right capability. No new modal screens. No "entering conversation mode" ceremony. The user types, the product responds. From any surface, during any flow.

**The north star of this experience is one property above all others: the plan keeps adapting to the user's real life after it's confirmed.** That's Flow 1 below — the living-document case. Every other flow in this section illustrates a secondary property (state preservation, Q&A, navigation, graceful decline) that the same architecture delivers for free.

The user's mental model becomes: **"Whatever reality does to my week, I can tell Flexie and it adjusts."** That includes plan changes, side questions, navigation, and domain questions — all without leaving the chat and without losing in-progress work.

Five concrete flows illustrate the target experience, ordered by importance.

### Flow 1 — Post-confirmation plan mutation (THE core use case)

**This is the single most important flow in the proposal.** It is the reason the freeform layer exists. Every other flow is a secondary benefit.

Setup: User confirmed their week on Sunday. The plan has a Moroccan Beef Tagine batch (3 servings, cooked Monday) scheduled for **Mon–Wed dinners**. Lunches are covered by a separate light batch (grain bowls) running Mon–Fri. Flex is Saturday dinner. Greek Lemon Chicken is the next dinner batch, starting Thursday. It's Tuesday morning, Monday's tagine serving is already eaten, and a friend just invited the user to dinner tonight. They open Telegram and type what happened.

```
User: I'm eating out tonight, friend invited me

Bot:  [dispatcher routes to mutate_plan → re-proposer runs with
       the active plan, the new context, and near-future safety
       rules in effect → validator → diff]

      Got it. Tonight → eat out.

      Tagine shifts forward one day in the dinner lane:
        Wed dinner: Tagine (was Tue)
        Thu dinner: Tagine (was Wed)
      Downstream dinner batches cascade one day each to absorb
      the shift — Greek Lemon Chicken now starts Friday, Flex moves
      accordingly, all staying in the dinner lane.

      Lunches are unaffected — your grain bowls stay Mon–Fri
      as planned.

      Weekly target still on track ✓

      [Confirm]  [Not quite — adjust]
```

The plan has absorbed the deviation. The food already cooked is still accounted for — the remaining tagine servings are still eaten, just one day later each. Shopping already done is unaffected. The mental model the user built ("tagine for dinner this week, grain bowls for lunch") still works. Reality diverged, the plan adapted, nothing was lost.

**Notice what the re-proposer did NOT do:** it did not move a tagine serving into a lunch slot. Lunch and dinner are distinct meal types in the plan, and dinner batches shift only into other dinner slots. This is not a cosmetic distinction — lunches and dinners have different physical properties. Lunch is usually portable, no-reheat, and light (you eat it out of a container mid-day without blunting your afternoon energy). Dinner can be heavy, sauce-heavy, and cooked-to-reheat. A beef tagine with couscous and heavy sauce is not a lunch. The meal-type lanes are load-bearing, and the re-proposer respects them.

**The meal-type lane rule (non-negotiable for the re-proposer):** When a batch needs to shift to absorb a deviation, it stays within the same meal type. A dinner batch moves into other dinner slots. A lunch batch moves into other lunch slots. Breakfast is fixed and not touched by mutations. Future versions of Flexie may push this further — lunches getting explicitly lighter and dinners heavier — so the lanes become more rigid over time, not less.

**This rule is NEW work, not an existing guarantee.** The data model constrains each batch to a single `mealType` (`lunch | dinner`), so a batch of type `dinner` structurally only occupies dinner slots. What the data model does NOT prevent is the re-proposer choosing to create a new lunch batch with a recipe whose intended meal type is dinner (nothing stops it from putting a tagine recipe into a lunch batch structure). Today's re-proposer prompt does not mention meal-type lanes at all — it just happens not to cross them because there's no incentive. Under post-confirmation mutation that incentive might appear (the re-proposer might try to rearrange aggressively to absorb a deviation). The implementation plan must add the rule to the re-proposer's prompt, and the proposal validator must add an invariant checking that each batch's recipe's intended mealType matches the batch's mealType. Both are small additions, but they are additions.

This is what "flexibility is in the name" means in practice. The re-proposer — the same one that handles planning-session mutations — runs on the active plan's visible state, shifts what needs to shift, respects what must stay put, and presents the result for confirmation. The user's only interaction is one message and one tap. Not a form. Not a new planning session. Not a screen full of buttons. **A sentence and a tap.**

**Why this is THE core flow, not one of many:**

- **It's the living-document capability.** PRODUCT_SENSE principle 4 ("bend without breaking") and principle 7 ("real life is the main environment") both depend on this flow working. Without it, the product is a rigid meal-plan app with chat skin — exactly what this project is built in opposition to.
- **It's the origin story.** Design doc 002 was written because this exact scenario broke the product on the first production day. The re-proposer was built to handle it. The only thing missing is the entry point — which this proposal delivers.
- **It's the foundation for every future adaptation feature.** "I went to a restaurant", "I had a snack" (possibly a photo), "I'm out of salmon", "I already ate the thing I was going to eat tomorrow", "my partner ate half the batch" — all of these are variations of the same pattern: **the user tells Flexie what happened, the re-proposer absorbs it, the plan keeps working.** Every future variation becomes an action in the catalog or a capability of the re-proposer. The dispatcher is the universal entry point.
- **It proves adherence-first is real.** PRODUCT_SENSE states adherence is the main variable. A plan that freezes on contact with reality doesn't optimize for adherence — it optimizes for adherence under ideal conditions, which is the same failure mode as restrictive diets. Post-confirmation mutation is the feature that converts "ideal-conditions adherence" into "real-life adherence".

**Near-future safety (critical):** When `mutate_plan` runs post-confirmation, the re-proposer treats the next ~2 days as **soft-locked**. It will not silently rearrange meals the user may have already shopped for, portioned, or prepared. It CAN change them — because the user is explicitly overriding their own preparation when they tell the product something changed — but only when the request's intent clearly targets the near-future day (e.g., "I'm eating out tonight" above, or "swap tomorrow's lunch for fish"). Days further out can be rearranged freely within the re-proposer's existing rules (fridge-life, pre-committed slots). This rule is load-bearing for "plans that survive real life": the user's real-world preparation must be respected unless explicitly overridden.

This rule is a requirement on the re-proposer's prompt/behavior in the post-confirmation context, not a dispatcher concern. The implementation plan will specify whether it's enforced via prompt instructions, a validator rule, or both.

### Flow 2 — Side question during planning (state-preservation illustration)

This flow isn't a core pain — it's a cheap secondary benefit that illustrates one of the layer's important properties: side conversations don't destroy in-progress work. The property matters because Flow 1 also depends on it (mid-planning mutations route to the active session's re-proposer, not a new one).

User is mid-planning, reviewing a proposed plan. Something catches their eye.

```
User: why is there so much pasta this week?

Bot:  Two pasta recipes this week — penne with salmon (Mon–Wed)
      and spaghetti bolognese (Fri–Sat). Both hit your ~800 cal/meal
      target cleanly and have high protein (~45g). Pasta is on your
      preferred carbs. Want to swap one?

      [← Back to planning]
```

The planning flow state is unchanged — same proposal, same phase, same mutation history. The response is a read-only explanation. If the user now types `"yes, swap the bolognese for lamb"`, the dispatcher picks `mutate_plan` and the re-proposer runs against **the existing proposal in the current planning session** — it does NOT start a new session, and it does NOT lose the mutation history. If instead the user types `"ok back to the plan"`, they see the original proposal again.

The state-preservation property on display here — a side conversation is a branch on top of the active flow, not a replacement — is the SAME property that makes Flow 1 safe. It has to hold everywhere the dispatcher runs.

### Flow 3 — Domain question from a recipe view

User is looking at a recipe and wonders about an ingredient.

```
User: what's a good substitute for tahini?

Bot:  Cashew butter or sunflower seed butter work well — similar
      nutty flavor and texture. Greek yogurt is a thinner option if
      you want a looser sauce.

      [← Back to recipe]
```

Read-only. No recipe is modified, no plan is touched. If the user now says `"actually swap that recipe for something without tahini"`, the dispatcher picks `mutate_plan` — and because there's no active planning flow in this scenario, the mutation runs against the active plan's visible state (post-confirmation mutate_plan). The re-proposer picks a different recipe from the library that fits the batch's slot and presents the diff for confirmation. If the side question had happened during planning instead, the mutation would route to the current planning session's re-proposer. In both cases, **the mutation lands where it belongs; the side conversation never strands the user in a parallel session.**

Note: ingredient-level edits within a plan recipe ("use 30g olive oil instead of 15g on Thursday's pasta") are out of scope for v0.0.5 — see Out of scope. Recipe **swaps** (picking a different recipe from the library for a batch) are in scope via the existing re-proposer. The Flow 3 follow-up above is a swap, not an ingredient edit.

### Flow 4 — Recipe nav by name

User is on a surface without direct access to a recipe's button (browsing their recipe library, on the shopping surface, in the middle of planning).

```
User: show me the calamari pasta

Bot:  [renders cook-view for Calamari Pasta, with scaled batch
       amounts because it's in the active plan]

      [← Back to plan]  [Edit this recipe]
```

If the recipe is part of the active plan, the handler renders the **scaled cook view** (batch amounts, cook-day context). If it's library-only, the handler renders the **library view** (per-serving amounts). The handler decides based on whether the slug appears in the active plan's batches.

This flow is a convenience — the plan view already has quick-access buttons for recipes about to be cooked, so typing is not faster than tapping in that specific context. The freeform affordance exists because the user shouldn't have to remember which surface has which button: if they want a recipe, they ask for it, and the product shows it. On surfaces without an existing hot button, this is a real unlock; on the plan view, it's an additive affordance that makes the chat feel consistent.

### Flow 5 — Out of scope

User types something unrelated to food, the plan, or nutrition.

```
User: what's the weather today?

Bot:  I help with meal planning, recipes, and nutrition — not
      weather. Try: "change Thursday dinner".

      [← Back to plan]
```

Polite, specific, lifecycle-aware. No attempt to be clever. The product is honest about what it does and doesn't do. The user can try again with a valid request or go back.

## Architecture (concept level)

**The architecture serves one primary purpose: making `mutate_plan` reachable from any surface at any time so the plan can adapt to real life after confirmation.** The dispatcher is the mechanism that gets the user's natural-language message to the re-proposer without requiring a new planning session. Every other action in the catalog is a benefit that becomes cheap once this mechanism exists — but none of them is why the mechanism exists.

Every inbound text and voice message is handed to a single LLM-driven component: the **dispatcher**. The dispatcher runs on a reasoning model and makes one call per inbound message. (Tentative implementation direction: the same tier as the re-proposer — mini model with high reasoning — to match the quality bar. The specific tier is a tuning decision for the implementation plan; the design commitment is "reasoning model, one structured call per message".)

Its job is to look at the user's message in full context and pick exactly one **action** from a small, enumerable **action catalog**. Its structured output includes the chosen action, its parameters, and optionally a user-visible response (for inline-answer actions where the dispatcher writes the reply itself).

The dispatch code then executes the chosen action by invoking its handler. Handlers are pure deterministic code, or they delegate to existing specialized agents (re-proposer, calorie estimator, measurement parser). The dispatcher itself never writes state, never does math, and never runs in a loop. Each message is one dispatcher call + one handler execution.

### Why one structured LLM call, not a tool-calling loop

At Flexie's current scale, every piece of context the dispatcher could need — library index (~50 recipes as one line each), current plan summary, recent conversation turns, action catalog with descriptions — fits comfortably in a single prompt. Tool-calling loops are the right shape when the agent genuinely can't see what it needs and has to fetch it across hops. Flexie can hand the agent everything relevant on every call for free. A single structured call is simpler, more predictable, more testable, and easier to reason about than a loop.

This is the same pattern Plan 025 validated for plan mutations: one structured LLM call, deterministic validation downstream, delegated execution. The re-proposer replaced ~800 lines of deterministic mutation handlers with a single call and made the product feel more natural at the same time. The dispatcher applies that pattern one level above, across the entire inbound message surface.

If the recipe library ever grows past what fits in the prompt (hundreds or thousands of recipes), a `search_library(query)` action can be added to the catalog — the dispatcher then runs twice in that single case, like a tool loop for one action. Everything built now stays unchanged.

### Where the dispatcher sits in the message flow

The dispatcher is the **front door** for inbound text and voice. Every text message passes through it before any flow-specific handling. This matters because the user can legitimately freeform in any phase — asking a question during event collection, requesting a recipe view during proposal review, wanting to move their flex during cook view. Making the dispatcher the front door guarantees the bot never ignores or misroutes a valid message.

Button taps (inline keyboard callbacks and reply-keyboard main menu taps) bypass the dispatcher entirely. They map directly to their existing flow actions as they do today. Only freeform text/voice touches the dispatcher.

One narrow exception: when the progress flow is explicitly asking for a numeric measurement (phase `awaiting_measurement`), a deterministic pre-filter catches well-formed numeric input ("82.3", "82.3 / 91") and routes it straight to the existing numeric parser. This saves a dispatcher call for a structurally unambiguous case. Any text during that phase that doesn't match the numeric shape goes through the dispatcher normally.

**Voice messages are already handled.** The grammY adapter transcribes voice messages with Whisper before dispatch and delivers them to `BotCore` as text-equivalent updates. From the dispatcher's perspective, text and voice are identical — there is no separate voice code path. No changes are needed to the voice pipeline for this feature.

### Dispatcher output contract

On every inbound text message, the dispatcher is called with a context bundle (see next section) and the user's message. It returns a structured decision:

- **action** — exactly one entry from the catalog
- **params** — action-specific parameters extracted from the message
- **response** — optional user-visible text (populated only for inline-answer actions)
- **reasoning** — free-text LLM reasoning, logged for debugging, never shown to the user

The dispatcher does NOT decide back-button targets or any other UI chrome. Back buttons are computed by the action's handler — deterministic code that reads the current session state (which flow is active, which surface the user was on, whether there's a pending clarification from a sub-agent) and attaches the appropriate `[← Back to X]` button. The LLM has no input into this. Keeping back-button computation inside the handler layer mirrors today's pattern (`keyboards.ts` builds back buttons from flow state) and removes one avenue for the LLM to be wrong about UI.

The dispatch logic then:

1. Looks up the chosen action's handler.
2. Runs the handler with the provided params and the current session state.
3. The handler either returns the dispatcher's pre-written response (inline answer), renders a view (navigate), delegates to a specialized agent (state change), or sends a clarification. In all cases, the handler attaches the appropriate back button based on active flow/surface state and replies through the existing output sink.
4. Flow and surface-context state are preserved unless the specific action is designed to modify them (e.g., confirmed plan mutation clears mutation history).

### Handlers

Each action has exactly one handler. Handlers are grouped by behavior:

- **Inline-answer handlers** (`answer_plan_question`, `answer_recipe_question`, `answer_domain_question`, `out_of_scope`) — the dispatcher already wrote the response; the handler sends it with the appropriate back button. Read-only by construction.
- **Navigate handlers** (`show_recipe`, `show_plan`, `show_shopping_list`, `show_progress`, `return_to_flow`) — pure deterministic code. Call the existing renderer with the params the dispatcher extracted. No new rendering code; existing views reused. **(End-state shape. Plan C (028) ships `return_to_flow` Tier 1 by delegating to the extracted `getPlanFlowResumeView` / `getRecipeFlowResumeView` leaf helpers, which is existing plan-flow resume code lifted into a shared module — zero new rendering code for the `proposal` / `reviewing` cases. For Tier 3 — the no-flow branch — Plan C ships a `rerenderLastView` helper with a small set of hand-written placeholder strings rather than calling the existing view renderers, because those renderers live inside `core.ts`'s callback handlers and are not importable from `dispatcher-runner.ts` without a circular dependency. Plan E (030) Task 5 extracts them into a `src/telegram/view-renderers.ts` module and Plan E Task 19 rewires `rerenderLastView` to dispatch through the extracted renderers, retiring the placeholder and restoring the "no new rendering code" shape end-to-end. The `show_recipe` / `show_plan` / `show_shopping_list` / `show_progress` navigate handlers all ship in Plan E alongside the view-renderers module, so the "call existing renderers with extracted params" shape is true for them from landing time.)**
- **Delegation handlers** (`mutate_plan`, `log_measurement`) — wrap an existing specialized agent or parser. Pass extracted params, receive a validated result, reply. Each delegation goes through its own existing validator chain. (Deferred: `log_treat` and `log_eating_out` would also be delegation handlers when their downstream capabilities exist.)
- **Flow passthrough handler** (`flow_input`) — forwards the user's text to the active flow's expected text handler as it exists today. For example, during planning event collection, `flow_input` calls the existing event text handler; during planning proposal review, it calls the existing re-proposer path. The implementation is a router from action to the pre-existing flow handler, not new flow logic.
- **Meta handlers** (`clarify`) — send the dispatcher's clarification question as the bot's reply and leave all session state unchanged.

This is the **extensibility seam** of the design. Adding a new capability means adding a new catalog entry, adding its handler, and updating the dispatcher's prompt to describe the new action. Nothing else changes — not the request/response contract, not the state preservation invariants, not the confirmation model, not other handlers.

## Context hydration

The dispatcher's decision quality depends on what it can see on every call. The context bundle is compact but complete:

| Field | Purpose | Size |
|---|---|---|
| User's message (text, post-Whisper) | What the user said | variable |
| Current surface context | Which screen the user is on: plan / cooking / shopping / recipes / progress / none | one line |
| Active flow state summary | Which flow is active (planFlow / recipeFlow / none), current phase, and any pending clarification from a sub-agent (re-proposer clarification question) | ~10 lines |
| Recent conversation turns | Last 3–5 user/bot exchanges. Lets the dispatcher follow referential threads ("that recipe", "what about the lamb?") | ~15 lines |
| Plan lifecycle state | no_plan / planning / upcoming / active_early / active_mid / active_ending | one line |
| Current plan summary | The visible plan's batches (recipe, servings, eating days), flex slots, events, remaining days, weekly calorie target, running treat budget if available | ~30 lines |
| Recipe library index | One line per recipe: slug, short name, cuisine tag, `fridgeDays`, `freezable`, short `reheat` note, authored `mealTypes` array, per-serving macros | ~50 lines at current scale |
| Action catalog | Action names, descriptions, parameter schemas, usage hints, examples of canonical phrasings | ~50 lines |
| Allowed actions in current state | Some actions are gated. E.g., `mutate_plan` requires an active plan; `show_recipe` requires at least one recipe to exist; most actions are available in any state. | one line |

Total: comfortably under a few thousand tokens at Flexie's current scale. Well within cost and latency budgets for a reasoning model at mini tier. Cost optimization (smaller tiers, smaller context) is a later concern; correctness and coverage first.

## Action catalog (v0.0.5)

The full catalog. Each action has a stable name, human-readable description, parameter schema, and handler notes.

### Flow passthrough

**flow_input** — The user's text is input for the active flow phase. Dispatcher selects this when the text is clearly an answer/input that the current flow expects: event text during `awaiting_events`, preference description during `awaiting_preferences`, mutation request during `proposal`, recipe review question/refinement during `reviewing`. Handler forwards the text to the active flow's existing text handler unchanged. This preserves the existing flow contract for in-flow text and keeps all existing behavior intact.

### Read-only answers (dispatcher writes the response inline)

**answer_plan_question({ question })** — Questions about the current plan whose answer is derivable from the plan-summary context injected into the dispatcher. Canonical examples the v0.0.5 context bundle can support:
- **"When's my next cook day?"** — derivable from batches (`eatingDays[0]` gives the cook day; pick the soonest that's in the future).
- **"What's cooking tomorrow?"** — derivable from batches + events (which batch's `eatingDays[0]` equals tomorrow's ISO date, or which events fall on tomorrow).
- **"What's planned for Thursday dinner?"** — derivable from batches + events + flex slots for a specific (day, mealType).
- **"What's my weekly calorie target?"** — derivable from the plan summary (`weeklyTargets.calories`).
- **"Which days am I cooking this week?"** — derivable by enumerating the distinct cook days across all active batches.

Handler sends the dispatcher's response. Read-only by construction — prompt forbids mutating plan state or fabricating numbers not already in the injected context.

**What the v0.0.5 context bundle does NOT support for this action, by design**: questions that depend on reasoning history (e.g., "Why did you put pasta twice?", "Why is this week different from last?"). The persisted mutation history shape is `{ constraint, appliedAt }` — it does NOT carry the re-proposer's natural-language reasoning. The re-proposer's `reasoning` field in its output is logged for debugging but never persisted onto the plan session. Answering "why" questions about plan composition would require either (a) persisting proposer reasoning alongside each mutation, or (b) giving the answer handler enough plan context to re-derive the reasoning from scratch at answer time. Both are follow-up work; v0.0.5 dispatches such questions via `clarify` ("I can tell you what's in your plan but not why — want me to show you the week overview?") or through the shape-specific `answer_plan_question` path if the answer is mechanical rather than reasoning-based.

**Questions the v0.0.5 context bundle CANNOT support** and their handling:
- **"What ingredients do I still need?"** requires a projected shopping list across remaining cook days. The dispatcher's context bundle does not carry the projected shopping list. For v0.0.5, the dispatcher picks `show_shopping_list({ scope: 'next_cook' })` instead — the user gets the actual list rendered rather than a synthesized answer. If the user's intent was clearly conversational rather than navigational, the handler can append "want the full list?" to its response.
- **"What's a flex meal?"** and similar product-meta questions route to a future `answer_product_question` action with a small opinionated knowledge base. That action is explicitly NOT in v0.0.5 (see Out of scope). During v0.0.5, product-meta questions fall through to `out_of_scope` with an honest response.

**answer_recipe_question({ question, recipe_slug? })** — Questions about a specific recipe or recipes in general. Storage (fridge days, whether it's freezable), reheating instructions, technique, substitutions, safety. `recipe_slug` is set when the question clearly references a specific recipe (either the one on screen or one mentioned by name). Handler sends the response.

**The context bundle's recipe index must include enough recipe data to answer these questions.** The fields required are: slug, short name, cuisine, `fridgeDays`, `freezable` (boolean), `reheat` (short instruction), and per-serving macros. The earlier draft of the context bundle only listed "fridge days"; the implementation plan must add `freezable` and `reheat` so answers like "can I freeze the tagine?" and "how do I reheat the salmon pasta?" can be answered directly from the injected context. All of this information already lives in the recipe's YAML frontmatter today (`RecipeStorage` = `{ fridgeDays, freezable, reheat }`); extending the context bundle is a read-and-include change, not new persistence work. Questions that go beyond the injected data (ingredient substitution suggestions, free-form cooking Q&A) may need the recipe body text in context; for v0.0.5 the implementation plan decides whether to include the full body for the specific recipe the question references, or keep the body out and let the reasoning model answer generically from its own knowledge.

**answer_domain_question({ question })** — In-domain food/nutrition questions that aren't specifically about the user's plan or library recipes. "Protein in 100g chicken?", "What's a good substitute for tahini?", "Why does high-protein make me full?". Brief, non-judgmental, non-lecturing tone per PRODUCT_SENSE. Handler sends the response.

**Future addition (not v0.0.5):** Flexie is an opinionated product with its own methodology — it does not demonize foods, does not treat rice and pasta as better or worse than each other for weight loss (ultra-processed and hyper-palatable foods are the only ones it's skeptical of). Generic LLM answers will not match this voice. A later version will add a **small opinionated food/methodology knowledge base** (a few thousand tokens, loaded into the dispatcher's context for domain questions) so answers stay aligned with PRODUCT_SENSE. The knowledge base is a simple static document, not a RAG system — the reasoning model with the document in context is sufficient. For v0.0.5, `answer_domain_question` uses only the model's general knowledge with prompt guidance.

All three answer actions are **read-only by construction**. They never mutate plan state, recipes, or budgets. The dispatcher's prompt explicitly forbids fabricating numbers that aren't in the context bundle (plan totals, recipe macros, budget values). Bad outputs produce wrong words, not corrupted state — and the user can immediately re-ask.

### Navigation (LLM picks params, existing renderer runs)

**show_recipe({ recipe_slug })** — Renders a recipe view. The dispatcher fuzzy-matches the user's reference ("calamari pasta", "the lemon chicken one") against the library index in its context. Handler logic:

1. Look for batches in the active plan whose `recipeSlug` matches. If none, render the **library view** (per-serving amounts) with a back button pointing at the previous surface.
2. If exactly one match, render the **scaled cook view** for that batch (batch amounts, cook-day context, servings, storage) with the back button pointing at the plan.
3. **If multiple matches (the same recipe appears in two different active batches — uncommon but possible)**, the handler must disambiguate. v0.0.5 picks the batch with the soonest cook day; the implementation plan may replace this with a clarify round-trip if users find it confusing.

The cook view today is anchored on a `batchId`, not a slug — because the scaled ingredients and serving count belong to a specific batch. The dispatcher does not need to know about batch IDs; it picks the slug from fuzzy matching and the handler resolves the slug to the right batch(es) using the active plan. **This resolution is new code** — today, cook view is only entered via a direct `cv_{batchId}` callback from a button. The implementation plan must add slug-to-batch resolution with a documented rule for the multi-match case.

**show_plan({ screen, day? })** — `screen` ∈ {`next_action`, `week_overview`, `day_detail`}. With `day_detail`, the `day` parameter is the ISO date (or a resolved day-name reference like "Thursday" → next Thursday's ISO date). The dispatcher resolves day names using the current plan's horizon; ambiguous references produce a `clarify` instead.

**show_shopping_list({ scope, recipe_slug?, day? })** — `scope` ∈ {`next_cook`, `full_week`, `recipe`, `day`}. `recipe_slug` is required when `scope='recipe'`; `day` is required when `scope='day'`.

**The existing shopping list generator does NOT support these scopes today.** Today the generator only produces a single-cook-day list (filtered by `eatingDays[0] === targetDate`) with prorated remaining-days breakfast. To implement this action, the generator must be extended with multi-scope support:

- `next_cook` → today's behavior (filter by next cook-day's `eatingDays[0]`).
- `full_week` → aggregate across all batches in the active plan's horizon; breakfast prorated to the full horizon.
- `recipe` → filter batches by `recipeSlug`, aggregate ingredients across all matching batches (usually one, sometimes more); no breakfast.
- `day` → batches whose eating days include the target day (not just cook day), or batches cooked on that day — the implementation plan picks one based on user expectations and documents it.

This is a **generator change**, not a dispatcher change. Earlier drafts staged the scope matrix so only `next_cook` shipped immediately and the remaining scopes returned a graceful "not yet supported" message pending incremental fill-in. In practice Plan E (030) delivers all four scopes in a single commit chain (Task 2 extends `src/shopping/generator.ts`; Task 5's `renderShoppingListForScope` dispatches between them; Task 15's `handleShowShoppingListAction` wires it into the dispatcher). The action appears in the catalog from day one and all four scopes are live at the end of v0.0.5.

This is the concrete answer to parameterized navigation: the catalog lists ONE action per render target, and parameters handle the scope/filter variations. New scope dimensions (e.g., exclude items the user has) become new enum values, not new actions.

**show_progress({ view })** — `view` ∈ {`log_prompt`, `weekly_report`}. Opens the progress screen in the appropriate state.

**return_to_flow** — Natural-language back button. The user types "ok back to the plan", "keep going with the plan", "resume planning", "back to my recipes", "let's continue", etc. Dispatcher picks this. Handler checks the active flow and re-renders its last view (the proposal review with its current state, the recipe under review, etc.). If no flow is active, returns the user to the main view for their current surface context. Equivalent in effect to tapping the `[← Back to X]` inline button but reachable through chat. **(End-state shape. The "re-renders its last view" and "returns to main view for current surface" clauses are staged in Plan C / Plan E — Plan C ships byte-identical restore for `proposal` / `reviewing` (Tier 1), a phase-canonical prompt for other active-flow phases (Tier 2), and a placeholder escape hatch for the no-flow case (Tier 3). Tiers 2 and 3 are promoted to byte-identical by Plan E Task 19. See the "Staged implementation" paragraph below and the Plan 028 decision log for the full contract.)**

**Staged implementation:** the full contract above is the **end state** — delivered across Plan C (028) and Plan E (030). Plan C ships a three-tier fidelity model toward this section's "re-renders its last view" requirement:
- **Tier 1 (byte-identical):** `planFlow.phase === 'proposal'` and `recipeFlow.phase === 'reviewing'` — `rerenderPlanFlow` / `rerenderRecipeFlow` read stored `proposalText` / `currentRecipe` and emit exactly what the user last saw. Scenario 039 is the regression lock.
- **Tier 2 (phase-canonical prompt):** every other active-flow phase — `rerenderPlanFlow` / `rerenderRecipeFlow` delegate to `getPlanFlowResumeView` / `getRecipeFlowResumeView` in the shared `flow-resume-views.ts` leaf module (Plan 028 Task 8b), which emits a short phase-appropriate re-entry prompt keyed on structural flow state. The prompt is semantically correct — correct phase, correct keyboard — but it is NOT guaranteed to be byte-for-byte identical to the user's actual last message. This is the **existing legacy behavior** of `getPlanFlowResumeView` inside `core.ts` that Plan C extracts unchanged so the existing `plan_week` menu action, the new `plan_resume` / `recipe_resume` inline callbacks, and the dispatcher `return_to_flow` handler all share one source of truth.
- **Tier 3 (placeholder):** no active flow — `rerenderLastView` emits a minimal "Back to X. Tap 📋 My Plan / 🛒 Shopping List / 📖 My Recipes / 📊 Progress for the current view." reply plus the main menu reply keyboard.

Plan E promotes tiers 2 and 3 to byte-identical: Task 5 extracts a view-renderers module, and Task 19 adds `lastRenderedText` / `lastRenderedKeyboard` persistence to flow state (captured via a sink wrapper at every flow render site) AND rewires `rerenderLastView` to dispatch through the view-renderers module using `LastRenderedView` parameters. At the end of Plan E every tier is byte-identical and this section's contract is satisfied end-to-end. The Plan 028 decision log "staged invariants" entry documents the bounded deviation, lists concrete drift examples for Plan E to retire, and references the Plan E tasks.

**Precedence with existing cancel semantics.** Today's planning flow has a meta-intent matcher for phrases like "never mind", "forget it", "not now", "i'll do this later", "stop", "cancel" — these currently trigger a full cancel of the planning flow. The `return_to_flow` phrase set must NOT overlap with this cancel set. When there's any doubt, cancel wins — because destructive actions are safer to trigger than navigational ones (a cancel the user didn't want is annoying; a return-to-flow that should have been cancel is wrong in a different way). The implementation plan must audit both phrase sets for overlap and adjust one or both lists.

### State-changing (delegated to specialized handlers)

**mutate_plan({ request }) — THE CORE ACTION of this proposal.** Every other action in the catalog either supports this one (by keeping its flow state safe, by providing read-only Q&A next to it, by delivering navigation around it) or becomes cheap once the dispatcher exists to deliver this one. This is the feature that turns the confirmed plan into a living document. The rest of the catalog matters because it makes the surrounding chat experience coherent — but `mutate_plan` is why this proposal exists at all.

The `request` field is the user's raw natural-language mutation. Handler delegates to the re-proposer (Plan 025), which already handles validation, clarification, diff generation, and presentation. Behavior depends on whether there's an active planning session:

- **During an active planning session** (current behavior): dispatched when `planFlow` is active in a phase that accepts mutations (today: `proposal` phase). The re-proposer runs on the current planning session's in-memory proposal, preserving the session's mutation history. **This is critical: a `mutate_plan` that comes from a side conversation during planning (e.g., the user asked a question, then asked for a change) MUST route to the active session's re-proposer, not start a new session.** Dropping the planning session would lose every prior mutation the user has already approved.
- **Post-confirmation** (new capability in v0.0.5): dispatched when there's no active planning session but there is an active confirmed plan. The re-proposer cannot today receive a confirmed plan directly — its input type is the in-memory `PlanProposal` shape, and confirmed plans live as a persisted `PlanSession` + separate `Batch[]` rows with no "revise in place" store API. See **"Data model for post-confirmation mutation"** below for how this gap is closed.

Both entry points always present the resulting proposal for explicit user confirmation — never auto-applied. Confirmation friction is cheap; a bad auto-apply is expensive. Auto-confirm for small changes is a future direction once the re-proposer has proven reliable in production use.

**Data model for post-confirmation mutation (new work, not existing behavior).** The current store supports only two plan-mutation operations: `confirmPlanSession` (create a new session from a draft) and `confirmPlanSessionReplacing` (D27's save-before-destroy: write a new session and new batches, then tombstone the old session and cancel its batches). There is no revise-in-place API and no revision chain. To enable post-confirmation mutation, v0.0.5 will introduce:

1. **A split-aware persisted-to-proposal adapter.** A pure function that loads the active `PlanSession` + its `Batch[]` and splits them into two groups at the (date, mealType) level — not just at the date level. The split is necessary because a Tuesday-evening mutation should not allow the re-proposer to rearrange Tuesday's lunch (already eaten at noon) even though Tuesday dinner (tonight's invite) is being absorbed.
    - **Past slots** — individual (date, mealType) pairs that are strictly in the past at the moment of dispatch. A past slot is either (a) a date before today, for any meal type, or (b) today's lunch after the server-local "lunch-done" cutoff (default: 3pm local), or (c) today's dinner after the server-local "dinner-done" cutoff (default: 9pm local). The cutoffs are v0.0.5 pragmatic defaults consistent with the server-local simplification in the time-semantics section; they can be overridden if the user explicitly targets a past slot ("actually, fix yesterday's lunch" — dispatcher treats as an intentional retroactive request and the re-proposer still cannot represent it, but the dispatcher won't route it to mutate_plan silently).
    - **Past-slot batches** — batches whose eating days contain ONLY past slots. Preserved verbatim into the new session's write payload so that `formatWeekOverview` and `formatNextAction` can render the full session horizon after the write.
    - **Active slots** — all remaining (date, mealType) pairs in the session horizon.
    - **Active batches** — batches that contain at least one active slot. Converted into a `PlanProposal`-shaped view (batches with their eating days filtered to active slots only, flex slots on active days, events on active days, horizon days from the first active day to session end, pre-committed slots). This is the input the re-proposer already understands.
    - **Spanning batches** (a batch with both past and active slots — e.g., a dinner batch whose eatingDays are [Mon, Tue, Wed] at Tuesday 7pm where Mon dinner is already eaten) are **split by the adapter**: the past-slot portion becomes a past-only batch written to the new session unchanged; the active-slot portion is passed to the re-proposer as a shortened batch with fewer servings. The re-proposer may keep the shortened batch as-is, extend it into other active slots, or swap its recipe — same rules as any active batch. After the re-proposer runs, the adapter concatenates preserved past-slot batches (including split halves) with the re-proposer's output to reconstruct the full `Batch[]` for the write payload.
   
   **The (date, mealType) split rule is the v0.0.5 version.** Its limitation is that it depends on server-local wall clock and a fixed cutoff heuristic. A user who ate lunch late (at 4pm, after the cutoff) would have that slot marked past even though they were about to request a mutation to it. The user's recourse is to target the slot explicitly, but the re-proposer still won't be able to move it. Full actual-vs-planned state (which slots have actually been consumed) is a deviation-accounting concern and is explicitly out of scope for v0.0.5 — it's the next version's upgrade path for this rule.

2. **Reuse of `confirmPlanSessionReplacing` for the write path.** When the user confirms the re-proposer's output, the system calls the existing save-before-destroy operation with the new draft (containing preserved past batches + new future batches) and the current session's ID. The new `PlanSession` row is created with the **same `horizonStart` and `horizonEnd` as the old one** — not a forward shift — so the visible week continues to render the same date range. The new session's batches include both the preserved past-day batches and the re-proposer's new future-day batches, so `formatWeekOverview` and `formatNextAction` render the full horizon correctly after the write. The previous session is marked `superseded`, and its batches are marked `cancelled`.

3. **Mutation history carry-over requires a schema change.** Today `mutationHistory` is stored on the in-memory planFlow state and cleared at plan confirmation. For post-confirmation mutations, history must be persisted alongside the plan session. The only available mechanism is a new `mutation_history` column (JSON) on `plan_sessions` — there is no lineage/predecessor pointer today, so the history cannot be derived from the session chain. The implementation plan must add this column and ensure the adapter copies the old session's history into the new session before appending the new mutation.

**The "past is frozen" guarantee.** Past-slot batches (and the past-slot portions of spanning batches) are passed through the adapter unchanged; the re-proposer never sees them and cannot mutate them. The (date, mealType) split granularity — not just a day-level cutoff — is what lets a Tuesday-evening mutation respect the fact that Tuesday lunch already happened while Tuesday dinner is still in play. This is a simple, testable definition that avoids needing any "actual vs. planned" state tracking for v0.0.5 (see Out of scope).

**Known consequences of using `confirmPlanSessionReplacing` for every mutation:** every approved mid-week mutation creates a new `plan_sessions` row, writes past + future batches, tombstones the prior session and cancels its batches. A user who makes many mid-week changes will produce many superseded session rows, with identical past-day batch content repeated on each one. For a single-user product this is fine; for multi-user scale, we'd likely want to revisit the revision model (revise-in-place, or a lineage chain with delta batches instead of full batch copies). Flagged for the implementation plan and for future scaling work.

**What v0.0.5 does NOT track (by design).** The current data model has only `Batch.status: 'planned' | 'cancelled'`. There is no notion of "consumed", "skipped", "deviated", or any other actual-vs-planned state. v0.0.5 does not add one. This has concrete implications for `mutate_plan`:

- **Non-retroactive mutations** ("I want to move Friday's dinner to Saturday") are the happy path. The re-proposer rearranges the affected batches in the active-slot view (see the split-aware adapter section) and the user confirms. No actual-state concerns.
- **Near-retroactive mutations** ("I'm eating out tonight" dispatched at 7pm for tonight's dinner) are handled by dropping the tonight-dinner slot from the affected batch and adding an `eat_out`-style event. Tonight's dinner slot is still an active slot under the (date, mealType) split rule (dinner hasn't passed its cutoff yet), so this is structurally a normal mutation — the re-proposer sees the event in the new proposal and shifts batches accordingly.
- **Retroactive mutations** ("last night I went to an Indian restaurant") are the hard case. v0.0.5 handles them partially: the re-proposer can accept a request that references yesterday's dinner slot and shift batches forward from today onward — but the yesterday slot itself cannot be re-recorded as an event because past slots are frozen in the split-aware adapter and the data model has no place to store "yesterday's planned slot was actually eat-out". In practice this means retroactive eating-out in v0.0.5 is a forward-only shift; the "what actually happened yesterday" side is not captured anywhere. This is acceptable for v0.0.5 because calorie tracking is also deferred, so there's no downstream consumer for the historical record. Full retroactive support arrives with deviation accounting (see Out of scope).

**Two rules on the re-proposer's behavior are load-bearing for `mutate_plan` and must be explicit requirements for the implementation plan:**

**Rule 1 — Near-future safety for post-confirmation mutations.** When `mutate_plan` runs post-confirmation, the re-proposer must treat the next ~2 days as **soft-locked**. It will not silently rearrange meals the user may have already shopped for, portioned, or cooked. It CAN change them, but only when the user's request explicitly targets them ("move today's dinner to tomorrow", "swap tomorrow's lunch for fish", "skip Monday's lunch I'm eating out"). Days further out in the horizon can be rearranged freely within the re-proposer's existing rules (fridge-life, pre-committed slots, etc.). This protects the user's real-world preparation from being silently invalidated.

**Rule 2 — Meal-type lanes are never crossed.** Batches stay within their meal type. A dinner batch only shifts into other dinner slots. A lunch batch only shifts into other lunch slots. Breakfast is fixed and not touched by mutations. This is not cosmetic — lunches and dinners are physically different meals: lunch is portable, no-reheat, light (midday energy matters); dinner can be heavy, sauce-heavy, and cooked-to-reheat. A tagine with couscous and heavy sauce is not a lunch. Future versions of Flexie may push meal-type distinctions further (lunches explicitly lighter, dinners explicitly heavier), so this rule should become more rigid over time, not less.

The data model today already tracks meal types per slot and per batch, and recipes carry a `mealTypes` array listing which meal contexts they were authored for. What the data model does NOT currently enforce is "a batch's meal type must be one of its recipe's allowed meal types" — a re-proposer could today put a dinner-only recipe into a lunch batch and nothing would reject it. The rule must be added to the re-proposer's prompt (explicitly forbidding the cross-lane combination) AND to the proposal validator as a new invariant: `batch.mealType ∈ recipe.mealTypes`.

Both rules are re-proposer behavior, not dispatcher concerns. They're called out here because they're load-bearing for the "plans that survive real life" promise, and because the implementation plan will need to specify how each is enforced (prompt instructions, validator rules, or both).

**log_measurement({ weight?, waist? })** — Freeform weight/waist logging from any screen. Handles phrasings like "I'm 82.3 today", "weight 82.3 waist 91", "log 82.3 / 91", "waist 89 this morning". Handler reuses the existing numeric parser and disambiguation flow for ambiguous two-number inputs. If unambiguous, auto-applies and shows the confirmation with a first-time hint when appropriate; if ambiguous, routes into the existing disambiguation UI. Day is always today (server-local).

This action is a thin wrapper over the existing measurement code path; no new math or validation logic is introduced. It exists in the catalog so the user can log a measurement from any surface without navigating to the progress screen first.

**No [Undo] button for measurements.** The measurement store is upsert-keyed by date, and there is no delete or revert API — so "undo" has no backing implementation that doesn't require new persistence work. Since re-logging automatically overwrites the day's measurement, the user's recovery path for a mistyped weight is simply "send the correct numbers again". The confirmation message for `log_measurement` says so: "Logged: 82.3 / 91. If that's wrong, send the correct numbers." Explicit delete support is out of scope for v0.0.5.

### Meta

**clarify({ question })** — The dispatcher can't confidently pick an action or parameter values, so it asks the user a clarifying question. The handler sends the question as the bot's reply, leaving all session state unchanged. The user's next message is dispatched again with the clarification answer in the recent-turns context. Safety valve, not the norm — most messages are unambiguous and the dispatcher commits to an action directly.

Canonical clarify cases:
- Meal time is ambiguous ("I went to Indian restaurant" → "Which meal — lunch or dinner?")
- Day is ambiguous ("last night" → "Which day — yesterday or earlier?")
- Recipe reference matches multiple library slugs ("the chicken one" → "Lemon Chicken or Chicken Pepperonata?")
- The user's request is genuinely unclear ("I want something different" → "Different recipe, different day, or different kind of meal?")

**out_of_scope({ category? })** — The user's message is clearly outside the product's domain (weather, stock prices, general chat, requests for live data the product doesn't have). Handler replies with a short, specific, lifecycle-aware decline: "I help with meal planning, recipes, and nutrition — not {category}. Try: `change Thursday dinner` or tap a button." Always includes a back button pointing at the previous surface. Never attempts to be clever or pretend to have capabilities the product lacks.

### Architecturally committed but deferred

Both actions below are listed in the catalog so the dispatcher knows they exist as a category and so the architecture proves it extends cleanly to the **full living-document vision**. They are the next major extensions of `mutate_plan`'s reach — adding new INPUT modalities (descriptions of restaurant meals, descriptions of treats, eventually photos) that all feed the same underlying capability: the plan keeps adapting as real life happens.

**Neither is implemented in v0.0.5.** If the user invokes either during v0.0.5, the dispatcher picks `clarify` or `out_of_scope` with a short honest explanation.

**log_eating_out({ description, meal_time, day }) — the next major extension of the living-document capability.** Eating out IS meal-replacing (the opposite of a treat). The user ate somewhere instead of their planned meal prep. This is the explicit form of the exact scenario that motivated design doc 002 and this proposal. Flow 1 above shows the user typing "I'm eating out tonight"; `log_eating_out` is the name for the specific compound action behind it when the full handler exists.

When implemented, the handler would:

- Estimate calories (if the user didn't provide them, via one-round clarification — "rough estimate? a voice note works").
- Create an `eat_out` event at the target day + meal slot.
- Delegate to the re-proposer to (1) shift the affected planned batch forward to the next available day, (2) absorb the calorie impact via the flex → treats → accept hierarchy from design doc 002, (3) present the compound confirmation: logged meal + plan diff + calorie absorption summary.
- **Retroactive support is required** — "last night I went to an Indian restaurant" has to work. The re-proposer must be able to insert an event on a past day and shift yesterday's batch forward to today (or tomorrow if today has a conflict).
- **Fridge life is a hard wall.** If shifting a batch forward would exceed its `fridgeDays`, the handler returns a graceful failure: "Your tagine would be past its fridge life if I shift it further. Want to move one serving forward or discard it?" Freezing logic is backlogged for a much later version.
- **Always confirm** — compound change, shifts the plan AND logs calories.

Why deferred from v0.0.5: the compound flow (retroactive events, fridge-life handling, absorption hierarchy, compound confirmation UI) deserves its own design pass and implementation plan. It also depends on running-budget tracking, which doesn't exist yet. Deferring keeps the freeform layer's first release focused on the dispatcher + the core plan-mutation capability. In v0.0.5, Flow 1's "I'm eating out tonight" case is handled by the generic `mutate_plan` path — the user describes what happened, the re-proposer adjusts the plan, calorie absorption is left for the future compound handler. It's a partial fix that delivers 80% of the value with 20% of the work.

**log_treat({ description }) — the treat-only variant of the same pattern.** Treats are additive calories that do NOT replace a meal prep. Examples: "Snickers", "pastry", "coffee and a cookie". When implemented, the handler would call a calorie estimator, record against a running treat budget, and reply with the remaining budget — auto-applied with an `[Undo]` button per JTBD A6 (one-message-in-one-message-out). Treats have no day parameter: they consume the current week's treat budget regardless of when they happened.

Why deferred: treat tracking is not yet a feature of the product at all — no running treat budget state, no calorie estimator wired for this path, no UI for the budget remainder. Building treat tracking is its own plan-sized piece of work and doesn't belong bundled into the freeform layer proposal.

**Future multimodal extensions (flagged, not designed here).** Beyond text-described deviations, the same living-document capability naturally extends to other input modalities:

- **Photo-reported snack:** user sends a photo of something they just ate with no text. Vision model classifies it as a snack or meal-replacement, estimates calories, routes to the appropriate handler (`log_treat` or `log_eating_out`), and the plan absorbs it. Same compound result as the text versions, different input surface.
- **Voice-described restaurant meal:** user leaves a voice note "I just had a big Italian lunch, chicken parmesan with pasta." Already supported in principle — Whisper transcribes it, the dispatcher receives text, the existing compound handler runs. No new surface needed.
- **Menu-scanned restaurant prep:** user photographs a menu before ordering, asks "what fits my budget?" — a separate read-only flow that doesn't mutate the plan but feeds into the user's decision, which might then become a `log_eating_out` call.

None of these are implemented in v0.0.5. They're flagged because they're the natural evolution of the same architecture: **the dispatcher sits at the top, classifies the input regardless of modality, and routes to the appropriate handler. The living-document capability grows along the INPUT axis (what can report a deviation?) without changing the architecture.** Every future modality is a dispatcher extension + a handler, not a rewrite.

**v0.0.5 behavior when either deferred action is invoked:**

- If the user describes eating out ("I went to an Indian restaurant", "I'm eating out tonight"), the dispatcher picks `mutate_plan` and the re-proposer adjusts the plan (shifts affected dinner batches forward in the dinner lane, respects near-future safety). Calories are not tracked. The confirmation message is explicit: "I adjusted the plan. I don't track meal-out calories yet — that comes with deviation accounting later."
- If the user describes a treat ("had a Snickers"), the dispatcher picks `clarify` with an honest deferral: "Treat tracking isn't available yet — I can't record it and it doesn't affect your plan since it's a snack, not a meal. That's coming later." No silent drop, no fake confirmation.
- If the user describes something ambiguous that could be either (some snacks border on meal replacements), the dispatcher picks `clarify` to disambiguate first, then routes as above.

This split delivers the plan-adaptation value (mutate_plan works for eat-out cases) without pretending to track calories. When deviation accounting lands, both paths get richer.

---

**Count: 13 active actions + 2 deferred architectural commitments.** The catalog is complete for v0.0.5's scope.

Breakdown: 1 flow passthrough + 3 read-only answers + 5 navigation + 2 state-changing (`mutate_plan`, `log_measurement`) + 2 meta = 13 active. `log_treat` and `log_eating_out` are committed in the catalog but not implemented.

**Honest-accounting note.** `show_shopping_list` is counted as active because the dispatcher can pick it and the handler responds. An earlier draft of this proposal staged the scope matrix so only `next_cook` shipped end-to-end at the end of v0.0.5 and `full_week` / `recipe` / `day` returned "not yet supported." Plan E (030) delivers the full matrix in one pass instead: Task 2 extends `src/shopping/generator.ts` with `generateShoppingListForWeek`, `generateShoppingListForRecipe`, and `generateShoppingListForDay` alongside the existing `generateShoppingList`, and the `handleShowShoppingListAction` handler dispatches between scopes via a tagged `ShoppingScope` union. Plan 027 (B) ships `LastRenderedView` variants for `next_cook` and `day`; Plan 030 (E) extends the union with `full_week` and `recipe` as a non-breaking addition in the same commit chain. At the end of v0.0.5 all four scopes are live — the "staged" language in earlier drafts is superseded by the Plan E appendix below and Plan 030 in practice.

## State preservation invariants

The #1 safety rule: **the user's in-progress work is never lost by a freeform detour.** The following invariants MUST hold and MUST be enforced by scenario tests in the harness:

1. **The dispatcher never clears `planFlow` or `recipeFlow` session state.** Only explicit flow completions (user confirms a plan), explicit cancellations (user types "cancel" or "start over", or taps a cancel button), or successful natural completions can clear flow state. A freeform detour — no matter how long or how far from the flow's topic — leaves flow state untouched. Specifically, a `mutate_plan` action dispatched during an active planning session **routes back into that session's re-proposer** (preserving mutation history, proposal state, and any pending clarification). It does NOT start a new planning session or a post-confirmation mutation. The dispatcher checks "is planFlow active in a mutation-accepting phase?" and routes accordingly.

2. **Surface context is a separate axis from flow state, and the surface model needs to be extended.** A user can be in an active `planFlow.phase === 'proposal'` AND looking at a recipe view simultaneously (because they branched mid-review to check a recipe). Both must be independently tracked. Today's surface state is coarse — a single 5-value enum plus the slug of the last recipe viewed — and is insufficient for precise back navigation. See "Navigation state model (new work)" below for the required extensions. Simultaneously, the implementation plan must audit every place that today destructively clears flow state on menu interactions (there are several, including the shopping-list menu action that explicitly clears the planning flow) and decide which of those behaviors need to change under the freeform model.

3. **Every side-conversation response includes a `[← Back to X]` inline button** when a flow is active, pointing back to the flow's last rendered view. When no flow is active, the back button points at the main view for the current surface context (plan / recipes / shopping / progress). The target is computed from active flow state, not from the previous surface alone.

4. **Side conversations are multi-turn and re-enter the dispatcher on every turn.** The user can ask follow-ups ("what about the lamb?" after "can I freeze the tagine?"), ask different questions, or eventually return to flow input — all without losing flow state. There is no separate "side conversation" state to manage. Each turn is a fresh dispatch with the recent turns in context.

5. **Pending clarifications from sub-agents are carried in flow state and visible to the dispatcher.** If the re-proposer asked "did you mean lunch or dinner?" and the user types a side question instead of answering, the clarification is preserved in `planFlow` state. The dispatcher sees it in its context bundle and knows there's an outstanding question. After the side conversation ends and the user provides the clarification answer, the dispatcher picks `flow_input` and the planning flow consumes it.

6. **`return_to_flow` restores the exact view, not a fresh render.** If the user was reviewing a mutated proposal with mutation history X, the back action re-renders that exact proposal — not a newly generated one, not the original baseline. Flow state is the source of truth. **(End-state invariant. Plan C (028) ships this at Tier 1 fidelity for `planFlow.phase === 'proposal'` and `recipeFlow.phase === 'reviewing'` only; other active-flow phases resume with a phase-canonical prompt (Tier 2) and the no-flow case uses a placeholder (Tier 3), both promoted to byte-identical in Plan E (030) Task 19. See "Staged implementation of invariants #3, #6, and #7 across three tiers" below.)**

7. **Natural-language back commands are equivalent to back-button taps.** The dispatcher recognizes phrasings like "back to planning", "ok back to the plan", "keep going with the plan", "resume planning", "let's continue" and picks `return_to_flow`. Users can always escape a side conversation through chat, without tapping a button. The phrase set for `return_to_flow` must not overlap with the existing cancel phrase set ("never mind", "forget it", "not now", etc.) — cancel wins on any ambiguity because destructive actions are safer to trigger than navigational ones.

These invariants are testable through the scenario harness. Two paired scenarios are needed to cover invariant #7 ("natural-language back commands are equivalent to back-button taps") — one per entry point, both asserting the same bot output and equivalent `recentTurns` content going into the next dispatcher turn:

- **Natural-language path** — start planning → get into proposal review → branch to a side question → follow-up → typed "ok back to the plan" → planning proposal is still exactly as it was → confirm plan → success. (Plan 028 scenario 039.)
- **Button-tap path** — identical sequence except step 6 clicks the inline `← Back to planning` button (the `plan_resume` callback data that `buildSideConversationKeyboard` attaches to side-conversation replies) instead of typing. Asserts that step 6's bot output is byte-for-byte identical to the natural-language scenario's step 6, AND that `session.recentTurns` going into the next dispatcher turn contains the re-rendered proposal body as a bot turn so referential follow-ups resolve the same way regardless of entry point. (Plan 028 scenario 043.)

Equivalence at the output level is necessary but not sufficient — the two paths must also leave equivalent conversational state so the NEXT turn's dispatcher call sees the same referential content (per "Context hydration" § line 257 and "Side conversation lifecycle" § line 460). Both scenarios are required; either one alone leaves a gap.

**Staged implementation of invariants #3, #6, and #7 across three tiers.** Invariants #3 (back button points at main view for current surface when no flow is active), #6 (`return_to_flow` restores the exact view, not a fresh render), and #7 (natural-language back commands equivalent to back-button taps) apply across **three fidelity tiers** in Plan C (028), promoted uniformly to byte-identical in Plan E (030). The three tiers are:

- **Tier 1 (byte-identical active flow).** `planFlow.phase === 'proposal'` and `recipeFlow.phase === 'reviewing'`. `rerenderPlanFlow` / `rerenderRecipeFlow` delegate to the shared `getPlanFlowResumeView` / `getRecipeFlowResumeView` leaf module (Plan 028 Task 8b), which emits the stored `proposalText` / `renderRecipe(currentRecipe)` — byte-for-byte identical to whatever the in-flow render path produced. Scenario 039 is the regression lock. Invariant #6's "flow state is the source of truth" clause holds for these phases from day one.

- **Tier 2 (phase-canonical active flow).** Every other active-flow phase (`context`, `awaiting_events`, `generating_proposal`, `confirmed`, `choose_meal_type`, `awaiting_preferences`, `awaiting_refinement`). The helpers emit a short phase-appropriate re-entry prompt keyed on structural flow state (weekStart, breakfast, events count, mealType). The prompt is semantically correct — the user lands on the right phase with the right keyboard — but it is NOT guaranteed to be byte-for-byte identical to the message the user actually last saw. This is the **existing legacy behavior** of `getPlanFlowResumeView` inside `core.ts` today (already used by the `plan_week` menu action at `lifecycle === 'planning'`); Plan C extracts the helper unchanged into `flow-resume-views.ts` so the dispatcher path, the `plan_resume` / `recipe_resume` inline callbacks, and the existing `plan_week` menu action all share one source of truth. Plan C does NOT attempt to upgrade Tier 2 to Tier 1 — that is Plan E Task 19's job, via `lastRenderedText` persistence on flow state and a sink-wrapper capture at every flow render site.

- **Tier 3 (no-flow placeholder).** User browsed plan → week_overview → day_detail → typed "back to my plan"; or browsed shopping → typed "back to the shopping list". `rerenderLastView` emits a minimal "Back to X. Tap <button> for the current view." reply plus the main menu reply keyboard — a navigation escape hatch rather than a surface-scoped back target. Plan E Task 19 promotes this to byte-identical re-render once the view-renderers module (Plan E Task 5) exists.

Plan E's Task 19 lifts Tiers 2 and 3 uniformly to Tier 1 by (a) extending `PlanFlowState` / `RecipeFlowState` with `lastRenderedText?: string` + `lastRenderedKeyboard?` + `lastRenderedParseMode?` fields, (b) adding a sink wrapper that captures each `sink.reply(text, opts)` onto the active flow's state during flow-scoped callbacks and text turns, and (c) flipping the resume helpers to prefer the stored fields over the phase-canonical synthesis when present. Plan E also adds scenario coverage for the no-flow case alongside its `show_*` actions. All three tiers satisfy the full "restores the exact view" contract at the end of Plan E. The Plan 028 decision log explicitly flags the Tier-2 and Tier-3 deviations, enumerates concrete drift examples, and references the Plan E tasks — so no reviewer needs to treat Plan C's approximation as a permanent compromise.

## Navigation state model (new work)

Today's session state tracks surface at a coarse level: a five-value enum (`plan | cooking | shopping | recipes | progress | null`) plus the slug of the last viewed recipe. That is **not enough** for the freeform layer's state preservation guarantees. A user looking at "Thursday day detail" from the week overview should return there — not to the next-action view. A user who generated a shopping list for a specific recipe should return to that scoped list, not the default. A user who branched from a recipe cook view mid-planning should return to that cook view with the exact same batch context.

The implementation plan must extend session state with enough information to reconstruct the last rendered view precisely. A first-cut design (to be refined):

- **Plan subview**: which plan screen was last rendered (`next_action | week_overview | day_detail | cook_view`) plus any context (the day for day_detail, the batch ID for cook_view).
- **Shopping scope**: the last shopping list scope parameters (`next_cook | full_week | recipe | day` + optional recipe slug or date) so a back navigation shows the same list.
- **Recipe context**: the last recipe view, distinguishing library vs. cook view, and for cook view the batch ID (not just the slug — see Finding 6 / the `show_recipe` action notes).
- **Progress subview**: logging prompt vs. weekly report.

The simplest model is a small discriminated-union `LastRenderedView` stored alongside the existing surface enum. Handlers update it whenever they render a screen. `return_to_flow` reads it and re-renders.

**Existing "clears planFlow" behaviors must be audited.** Several menu-handler paths in the current orchestrator explicitly clear the in-progress planning flow when the user taps a reply-keyboard button (shopping list, start, cancel, plan_cancel, and several post-confirmation actions). Each of these is a deliberate choice today — for example, the shopping-list menu handler clears `planFlow` because it assumed the user was abandoning a future-week draft to look at the current plan. Under the freeform model this is wrong in some cases and right in others. The implementation plan must list every site, decide whether to preserve or clear, and add scenario tests for each path. No code in this proposal — the audit is the design commitment.

**Back-button targets are computed, not routed.** As specified earlier, back buttons are attached by handlers based on session state. The new navigation state extends what handlers can see, so they can produce the correct back target without needing the dispatcher to tell them.

## Confirmation model by action class

Different action classes have different confirmation requirements. The rule is: **match the stakes.**

| Action | Confirmation | Rationale |
|---|---|---|
| `flow_input` | Delegated to active flow | Flow handlers own their confirmation semantics (re-proposer confirms mutations today). No change. |
| `answer_plan_question` | No | Read-only text. Nothing to confirm. |
| `answer_recipe_question` | No | Read-only text. |
| `answer_domain_question` | No | Read-only text. |
| `show_recipe` | No | Rendering a view is inherently review-before-action. |
| `show_plan` | No | Rendering. |
| `show_shopping_list` | No | Rendering. |
| `show_progress` | No | Rendering. |
| `return_to_flow` | No | Navigation. |
| **`mutate_plan`** | **Always confirm** | Plan mutations are high-stakes — shopping may already be done, food may already be cooked. Confirm friction is cheap (one tap or one word); a bad auto-apply that breaks the week is expensive. Same pattern as today's re-proposer in the planning phase. Additional rule for post-confirmation: near-future days (next ~2 days) are soft-locked and only changed when the user explicitly asks. |
| `log_measurement` | Auto-apply unless ambiguous; no [Undo] | JTBD D2 requires under 5 seconds. Existing disambiguation UI handles the two-number edge case. First-measurement hint shows once. Re-logging overwrites (upsert-by-date); no delete API exists and none is added in v0.0.5. |
| `clarify` | No | Clarify is a question, not a commitment. |
| `out_of_scope` | No | Just a decline. |
| `log_treat` (deferred) | — | Not implemented in v0.0.5. When implemented: auto-apply + `[Undo]`. |
| `log_eating_out` (deferred) | — | Not implemented in v0.0.5. When implemented: always confirm (compound change). |

**Undo is not universal.** The deferred `log_treat` action (when it ships) will include an `[Undo]` button because treat logs can be deleted cleanly from the running treat budget. The v0.0.5 `log_measurement` action does NOT offer Undo because the measurement store lacks a delete API and re-logging is the correct recovery path (upsert-by-date). The implementation plan may add measurement delete support later if user feedback justifies it; until then, `log_measurement`'s confirmation message tells the user to re-send corrected numbers directly.

Auto-confirm for small plan changes (e.g., single-slot flex moves when the rearrangement is trivially safe) is explicitly **out of scope** for this proposal. The earning-trust model from design doc 002 stands: confirm everything until the re-proposer has proven reliable in production. v0.0.5 is still early.

## Side conversation lifecycle

A "side conversation" is any sequence of turns that doesn't consume the active flow's expected input. Its shape:

1. **Entry** — user types something mid-flow. Dispatcher picks a non-`flow_input` action. A response is rendered with a `[← Back to X]` button (if a flow is active).
2. **Multi-turn continuation** — user asks follow-ups. Each turn re-enters the dispatcher with the updated recent-turns context. The dispatcher can follow referential threads ("what about the lamb?" after "can I freeze the tagine?").
3. **Implicit return via flow input** — user types something that the dispatcher picks as `flow_input` or `mutate_plan`. The active flow resumes naturally, no explicit "exit side conversation" step needed.
4. **Explicit return via button or natural language** — user taps `[← Back to X]` OR types "ok back to the plan" / "let's continue planning". Dispatcher picks `return_to_flow`. Handler re-renders the active flow's last view exactly as it was. (End-state behavior. See invariant #6 and the "Staged implementation of invariants #3, #6, and #7 across three tiers" section for the per-phase fidelity contract Plan C ships toward this end state — Tier 1 is byte-identical for `proposal` / `reviewing`, Tier 2 is a phase-canonical prompt for other active-flow phases, and Plan E Task 19 promotes the remaining tiers to byte-identical.) The `return_to_flow` phrase set must not overlap the existing cancel phrase set ("never mind", "forget it", "not now", "stop") — cancel wins on overlap because destructive actions are safer to trigger than navigational ones.
5. **Terminal conditions** — user confirms the flow (plan confirm), user cancels the flow, user starts a new flow. The flow ends; any side-conversation history naturally rolls off with the flow state.

There is no cap on side-conversation turns. There is no timeout. The state simply persists until the user does something that closes it. If the user walks away for an hour and comes back, the flow is still there; the plan view still shows what it was showing. Telegram sessions are the natural persistence layer.

## Design decisions

### Why post-confirmation `mutate_plan` is the single reason this proposal exists

Every design decision below is downstream of this one. If a design decision served any goal except "make post-confirmation plan mutation work reliably and feel natural", it was probably wrong.

Flexie is a flexible-diet product. "Flexible" is not a marketing adjective — it's the method. PRODUCT_SENSE principle 4 states that flexibility is "part of the method," not a bonus feature, and specifically lists eating out, restaurant meals, family meals, and unplanned events as things the system must accommodate. Principle 7 says real life "is the actual operating environment," not an edge case. JTBD C2 says outright: "Emotionally important — this is the moment the product either proves its 'flexibility' promise or feels like a rigid diet app." The whole product philosophy collapses into this: **when reality diverges from the plan, the product must absorb the divergence without drama.**

Today the product cannot absorb a divergence at all, because the re-proposer has no post-confirmation entry point. The user has no way to say "this happened" and no way to reach the re-proposer's agentic judgment. The plan sits frozen and the user's options are all bad (follow in fiction, abandon and restart, stop using the product).

This proposal exists to close that gap. The dispatcher is the entry-point mechanism. The action catalog is the extensibility vehicle. Every other action (navigation, Q&A, domain questions, state preservation for side conversations) is a secondary benefit that becomes cheap once the dispatcher exists — but none of them is why the dispatcher is being built.

Concretely: the four load-bearing catalog entries for the living-document promise are `flow_input` (so existing flows still work), `mutate_plan` (the feature itself), `clarify` (the safety valve when intent is unclear), and `out_of_scope` (the honest decline). Every other action is here because adding it is basically free and the user experience is better with them. This priority order drives **implementation attention** — `mutate_plan` first and best, other actions fleshed out once the core path is proven — but does not by itself drive release staging, which is a separate planning-phase decision.

This framing also determines what the implementation plan should obsess over. Testing should prioritize:
1. The post-confirmation `mutate_plan` path works for the motivating real-life scenarios (dinner out, canceled cooking, missing ingredient, flex move).
2. The meal-type lane rule holds — a dinner batch never shifts into a lunch slot, a lunch batch never shifts into a dinner slot, breakfast is untouched.
3. The near-future safety rule holds — the next ~2 days don't get silently rearranged.
4. State preservation during mid-planning side conversations (the same mechanism the living document relies on).
5. Everything else.

The rest of this section lists the secondary design decisions that shape HOW the architecture does this.

### Why one LLM call per message, not a tool-calling loop

At Flexie's current scale, the entire context the dispatcher could need fits in a single prompt for cheap (a few thousand tokens total). Tool-calling loops are the right answer when the agent can't see what it needs. Flexie can show the agent everything relevant on every call. One structured call is simpler, faster, more predictable, more testable, and easier to reason about. If the recipe library grows past the prompt budget in a future version, a `search_library` action gets added to the catalog and the dispatcher calls it preparatorily for that one case — nothing built now is wasted.

This is the same architectural pattern the re-proposer uses (Plan 025), and the re-proposer is the canonical proof that this pattern delivers both simpler code and better UX at the same time.

### Why the dispatcher is the front door, not a fallback

A fallback-only dispatcher means the active flow's text handlers decide first, and the dispatcher only runs if they decline. This sounds safer but creates exactly the problem this proposal is trying to fix: users can't freeform during a phase that's hungry for text, because the flow eats it first. With the dispatcher as the front door, any message — even during `awaiting_events` — gets routed correctly, because `flow_input` is just another action the dispatcher can pick. If the text is legitimately flow input, the dispatcher picks `flow_input` and the existing flow handler runs unchanged.

The small pre-filter for numeric measurement input is the only exception, and only because the numeric parser is structurally unambiguous. "82.3 / 91" has only one correct interpretation during the measurement-awaiting phase.

### Why `log_treat` and `log_eating_out` are separate actions

The semantic distinction is simple and useful:

- **Eating out is meal-replacing.** The user ate something else instead of their planned meal prep. The plan needs to shift; the calorie impact needs to absorb across flex → treats → accept.
- **A treat is additive.** The user still ate their meal prep; they also had something extra. The calorie impact only touches the treat budget.

Collapsing them into one action would force the handler to decide which, which is exactly the kind of ambiguity the dispatcher is good at resolving upstream. Making them separate actions makes the decision explicit and the code paths clean. The dispatcher can tell the difference from the user's message in nearly all cases ("I went out for dinner" vs. "I had a Snickers"); when it can't, it clarifies.

### Why `log_eating_out` is in the catalog but not in the v0.0.5 implementation

This is the worked example that proves the architecture extends cleanly. Listing the action in the catalog captures design intent and compound shape without requiring us to build the handler now. The dispatcher's prompt includes it; the catalog doc lists it; the handler is the only missing piece. When a future version implements it, the change is localized: add the handler, wire it in, update the dispatcher's prompt slightly, add scenarios. No dispatcher architecture changes.

Deferring the handler is also safer operationally: the first release of the dispatcher has fewer moving parts, fewer new code paths, and a smaller testing surface. The full eating-out flow (retroactive events, fridge-life handling, compound confirmation UI) deserves its own design pass and its own implementation plan.

### Time-bound parameters and the v0.0.5 "local = server" simplification

Flexie is a Telegram bot. It does not receive the user's timezone from Telegram updates, and it does not yet ask the user to declare one. Strictly speaking, any interpretation of "tonight", "tomorrow", "yesterday", or "right now" depends on knowing which day today is for the user — and in a multi-user product that requires per-user timezone state. The previous draft of this section said "never infer time-bound parameters from a presumed clock", but that rule was inconsistent with treating "for dinner tonight" as a usable explicit signal — "tonight" IS relative to "today", and "today" depends on a clock.

**v0.0.5 resolves the inconsistency with an explicit single-user simplification: server-local date is user-local date.** Flexie is deployed as a single-user product for a user in southern Spain (v0.0.1-through-v0.0.5 single-user assumption per the backlog). The bot's server runs in a known timezone, and that timezone is the user's timezone by declaration. "Today" is the server's local ISO date. "Tonight" resolves to today's dinner slot in server-local time. "Tomorrow" is today+1. "Yesterday" is today-1. This is the same assumption the existing measurement logging and planning flows already make — the freeform layer just inherits it.

The rule for v0.0.5, stated precisely:
- **Relative terms anchored to today** ("tonight", "today", "this morning", "right now") resolve to server-local today's relevant slot. No clarification needed.
- **Relative terms anchored to a named day** ("Thursday dinner", "Friday lunch") resolve by mapping the day name to the nearest upcoming or containing date within the plan horizon.
- **Relative terms anchored to adjacent days** ("tomorrow", "yesterday", "last night", "tomorrow night") resolve as today±1 in server-local time. No clarification needed for v0.0.5.
- **Genuinely ambiguous** ("a while ago", "earlier", "the other day") → `clarify`.
- **Ambiguous meal time** ("I went to Indian" without mentioning lunch or dinner) → `clarify`.

**Multi-user timezone awareness is v0.1.0 work.** When the product supports multiple users across timezones, the rule will tighten: relative terms either require a declared per-user timezone or trigger clarification. v0.0.5 does not pretend otherwise, but it also doesn't force unnecessary clarification for the single user who happens to live where the server runs.

The deferred `log_treat` action sidesteps this entirely even in multi-user: treats consume the current week's treat budget regardless of when they happened, so there's no time-bound parameter and nothing to get wrong. The deferred `log_eating_out` action DOES need a meal-time and day, and will obey whichever rule (v0.0.5 server-local or v0.1.0 multi-user) applies when the handler ships.

### Why state-changing actions always go through their existing validators

The dispatcher never writes state directly. Plan mutations go through the re-proposer → proposal validator → solver. Treat logs go through the calorie estimator with sanity bounds + the running budget update. Measurement logs go through the existing numeric parser + disambiguation + the measurement store. The LLM can pick the wrong action (failure mode: confuses the user, they re-ask) but cannot pick an action that bypasses validation (failure mode: corrupts state). This is non-negotiable and follows the "LLM judgment + deterministic sidecar" pattern from design doc 002 and PRODUCT_SENSE.

### Why the catalog is small (13 + 2)

Intent classifiers and feature lists grow linearly with perceived user need and become unmanageable. The catalog is small on purpose: each entry corresponds to a coherent product capability, not a user phrasing. Variations in how users ask are handled by the dispatcher's understanding; variations in what they ask for within a capability are handled by parameters. New actions are added only when a genuinely new capability emerges (new kind of state change, new kind of render target). **Growth is by params first, actions second.**

The catalog is also small enough that the entire list can be included in every dispatcher prompt without crowding context. Growing it to 30 or 50 entries would start to harm dispatch quality.

### Why meal-type lanes are never crossed by the re-proposer

Lunch and dinner are physically different meals, not just different times. Lunch is usually portable, no-reheat, and light — you eat it out of a container mid-day and don't want a heavy meal blunting your afternoon energy. Dinner can be heavy, cooked-to-reheat, and sauce-heavy — a tagine with couscous, a pasta with cream, a stew with rice. A beef tagine is a fine dinner and a terrible lunch.

The plan's meal slots already encode meal types — lunch and dinner are distinct slot types, and each batch has an explicit `mealType` field. Recipes carry a `mealTypes` array (a recipe may be authored as suitable for one or more of breakfast/lunch/dinner — the field is plural). What the data model does NOT enforce is "a batch's meal type is one of its recipe's allowed meal types": a re-proposer is free to put any recipe into any meal-type batch. Today the re-proposer doesn't do that because there's no incentive, but post-confirmation mutation may create one (the agent might rearrange aggressively to absorb a deviation and cross lanes in the process).

The rule must be added to the re-proposer's prompt and enforced by the proposal validator. The re-proposer prompt must state: "A batch's meal type must be one of the recipe's authored meal types. A recipe authored only for dinner must not be placed in a lunch batch. If the user asks for a swap that would violate this, pick a different recipe or surface a clarification." The validator must check, for each batch: `batch.mealType ∈ recipe.mealTypes` — i.e., the batch's meal type is a member of the recipe's allowed meal types. Recipes that are authored for both lunch and dinner remain flexible; recipes authored for only one meal type are locked to that lane.

**This rule is load-bearing for the living-document promise.** The user's physical reality — I can reheat a dinner but I can't reheat a portable lunch, I don't want heavy sauce at my desk — is not something the plan can violate without becoming nonsensical. A re-proposer that silently moved a tagine serving into a Friday lunch slot would produce a technically valid (according to today's validator) arrangement that the user cannot actually execute. The plan would stop matching reality in a different way than the one this proposal is trying to fix.

Future versions of Flexie may push the distinction further — making lunches explicitly lighter and dinners explicitly heavier, maybe even distinguishing more meal types. Whatever happens, the direction is "more lane separation, not less".

### Why post-confirmation `mutate_plan` is conservative about near-future days

When the user has already confirmed a plan and started living it, the next ~2 days are load-bearing in the real world: they may have already shopped for Monday's cook session, they may have already portioned out Tuesday's lunch, they may be planning around specific food that's in their fridge. A re-proposer that silently rearranges the next 2 days — even for a technically correct reason ("I found a better rearrangement") — breaks the user's real-world preparation.

The rule: post-confirmation, the re-proposer treats the next ~2 days as soft-locked. It will not silently move meals in that window. It WILL change them if the user's request explicitly targets them ("move today's dinner to tomorrow", "swap the lunch I'm about to make for something else") — because the user is explicitly overriding their own preparation. Days further out can be rearranged freely within the re-proposer's existing rules.

This is a requirement on the re-proposer's prompt/behavior in the post-confirmation context. It is NOT a dispatcher concern. The dispatcher just picks `mutate_plan`; the re-proposer knows whether it's running in the planning-session context or the post-confirmation context and applies the near-future safety rule accordingly. The implementation plan will specify how this rule is enforced (prompt guidance, validator, or both).

### Why back-button targets are the orchestrator's responsibility, not the dispatcher's

An earlier draft of this proposal had a `back_button_target` field in the dispatcher's output contract. That was wrong. Back buttons today are built in deterministic keyboard-building code and attached by handlers based on the current session state (which flow is active, which surface the user was on). The LLM has no input into them.

Keeping this unchanged has three benefits: (1) one fewer avenue for the LLM to be wrong about UI, (2) consistency with today's pattern, (3) back-button correctness becomes a pure function of session state and is trivially testable. The dispatcher outputs a decision about *what to do*; the orchestrator decides *how to render* the decision including all UI chrome.

Inline-answer handlers receive the dispatcher's response text + the current session state and attach the appropriate back button themselves. Navigate handlers do the same. The only signal the dispatcher provides that affects back-button logic is the action type, which the handler branches on — and even that is a natural division of responsibility.

### Why natural-language back (`return_to_flow`) is its own action

"Back to planning" is not flow input — it doesn't advance the flow's state machine — and it isn't a regular navigate action because it restores in-progress flow state, not a fresh render. Making it its own action keeps the dispatcher's decision clean and makes "exit the side conversation" an explicit, testable state transition. It's also the natural companion to the visible back button: same semantics, two affordances (tap or type).

### Why scenario tests are the verification path

The scenario harness is Flexie's primary feedback loop (per CLAUDE.md and plan 006). The freeform layer adds multi-turn side conversations, a new LLM call per message, and the state preservation invariants above. All of these are naturally testable as scenarios: author a `spec.ts` with inbound text, generate once against the real LLM to capture fixtures, commit `recorded.json` as the behavioral lock, re-run on every `npm test`. Regression tests for the state preservation invariants become concrete scenarios exercising "enter flow → branch → return → confirm flow → check state store".

## Edge cases

### The user types during `awaiting_events` and the message IS an event

Dispatcher picks `flow_input`. Handler forwards to the existing `awaiting_events` text handler. Same result as today. No regression.

### The user types during `awaiting_events` and the message is a side question

Dispatcher picks `answer_plan_question` (or similar). Responds inline with a `[← Back to planning]` button. `planFlow.phase` is unchanged, `planFlow.events` is unchanged. The next message is dispatched again with the updated recent turns. If it's an event, the flow consumes it.

### The user types something ambiguous — could be an event or a side question

Dispatcher picks `clarify({ question: "Is that an event you want to add to the plan, or a question about something else?" })`. User's next message is dispatched with the clarification context in history; the dispatcher commits to an action based on the answer.

### The re-proposer has a pending clarification, and the user types a side question

The pending clarification is stored on `planFlow` state. The dispatcher sees it in the active flow summary. It picks `answer_plan_question` (or whatever the side message warrants), preserves the clarification, and responds inline. After the side conversation ends and the user types the clarification answer, the dispatcher picks `flow_input` and the planning flow consumes it as the re-proposer's clarification answer.

### The user asks to show a recipe that exists only in the library, not in the active plan

Dispatcher picks `show_recipe({ recipe_slug })`. Handler checks the active plan → not found → renders the library view with `[← Back to X]` pointing at the previous surface context. Library view shows per-serving amounts, not batch amounts.

### The user asks to show a recipe that matches multiple library slugs

Dispatcher picks `clarify({ question: "Did you mean Lemon Chicken or Chicken Pepperonata?" })` with the candidate names. User picks one, dispatcher re-runs with the disambiguation.

### The user's message is a recipe query that needs more context than the library index provides

At Flexie's current scale (~tens of recipes), the library index fits in the prompt and the dispatcher can match against full names and cuisines. If the library ever grows past the prompt budget, a `search_library(query)` action becomes necessary — out of scope for v0.0.5.

### The user tries to log a treat (deferred)

Treat tracking is not implemented in v0.0.5. Dispatcher picks `clarify` or `out_of_scope` with an honest "coming soon" message: "I can't record treats yet — that's a future feature. If you want to talk about your plan or recipes, I can help with that." No fake confirmation, no silent drop.

### The user asks a domain question that's actually a plan change in disguise

"What's a good substitute for tahini?" is `answer_domain_question`. "Swap the tahini in my sauce for something else" is `mutate_plan`. The dispatcher distinguishes by phrasing — informational vs. imperative. If genuinely ambiguous, it picks `clarify`.

### The user types during planning and their message is gibberish / typos / empty

Dispatcher picks `clarify` or `out_of_scope` based on what it can parse. No action is taken. `planFlow` state is unchanged.

### The user types "back" or "cancel" or "start over" with no flow active

"Back" → dispatcher picks `show_plan` or equivalent (refresh the current surface; no-op for the user). "Cancel" → the existing cancel command runs before the dispatcher (registered commands are handled upstream). "Start over" during planning → the existing planning meta-intent matcher catches it before the dispatcher, preserving today's behavior.

### The user's request is retroactive ("last night I went to Indian")

This is an eating-out case with a twist: the reported event is in a past slot that sits outside the active-slot portion of the adapter view. v0.0.5 handles it **partially and honestly**. The dispatcher routes the message to `mutate_plan`. The re-proposer sees only the active slots (today forward, with today split by the meal-type cutoff rule) and can shift batches forward in the dinner lane to absorb the fact that last night's planned dinner didn't happen — but it cannot re-record the past-slot itself, because past slots are frozen in the adapter and the data model has no place to store "yesterday's planned slot was actually eat-out". The user sees: "I shifted your dinner batches forward one day to account for that. I don't track meal-out calories yet — that arrives with deviation accounting."

No `log_treat` fallback is offered because treat tracking is also deferred in v0.0.5. The honest v0.0.5 story is: "plan adjusted, calories not tracked."

When full `log_eating_out` is implemented in a later version, the handler will:
1. Resolve meal time and day according to whichever time-semantics rule applies at that version (v0.0.5 server-local simplification, or a multi-user timezone-aware rule when multi-user ships). Clarify if the user's message is genuinely ambiguous (no meal time, no anchor day).
2. Estimate calories (clarify if the description is too vague for a confident estimate).
3. Create a retroactive `eat_out` event (requires schema work: past-day events must be representable in the new deviation-accounting state).
4. Call the re-proposer with the event added, which shifts batches forward in-lane (see Rule 2) and respects near-future safety (see Rule 1).
5. Absorb calories via flex → treats → accept (requires running budget state).
6. Present a compound confirmation for user approval.
7. If fridge life would be exceeded, return a graceful failure: "Your tagine would be past its fridge life if I shift it further. Want to move one serving forward today and discard the rest?"

### The dispatcher itself fails (LLM error, timeout, malformed output)

Retry once with a fresh call. If retry fails, fall through to a generic message: "Something went wrong. Please try again or tap a button." The active flow state is unchanged — the user can retry the message, type something else, or use button navigation.

### The user types a very long message containing multiple intents

"I want to move the flex to Sunday, swap the tagine for fish, and also tell me how long the bolognese keeps." The dispatcher picks the most important actionable item (`mutate_plan` with both changes as a single request to the re-proposer; the re-proposer can handle multiple changes in one turn). The secondary question gets dropped — if the user cares, they'll ask again after the mutation. Alternatively, the dispatcher could pick `clarify` and ask the user to separate the requests. The first approach is more natural; the second is safer. The dispatcher's prompt should lean toward "handle the biggest actionable thing, then the user can follow up."

### The user wants to interact with a recipe NOT in the library AND not in the plan

Example: "Can you show me how to make lasagna?" There's no lasagna recipe. The dispatcher picks `clarify({ question: "Lasagna isn't in your library yet. Want me to generate a recipe for it?" })` — and if the user says yes, the dispatcher picks `flow_input` on the next turn to route to the existing recipe generator flow. The recipe generator is an existing flow; the dispatcher just routes the user into it.

## Out of scope

- **`log_treat` handler implementation.** Listed in the catalog as a deferred architectural commitment; not built. Treat tracking is its own feature and doesn't exist in the product yet — there's no running treat budget state, no calorie-estimator wiring, no budget-remainder UI. Scoped to its own proposal/plan.
- **`log_eating_out` handler implementation.** Listed in the catalog as a deferred architectural commitment; not built. Compound flow (retroactive events, fridge-life handling, absorption hierarchy, compound confirmation UI) deserves its own design pass. Depends on running-budget tracking and (eventually) treat tracking.
- **`answer_product_question` action.** Questions about the product's concepts and methodology ("what's a flex meal?", "how does the treat budget work?", "what's the difference between planning and mutation?") fit a separate action that consults a small static knowledge base about Flexie's concepts. Not in v0.0.5. **For v0.0.5, such questions route through `out_of_scope`** with an honest short decline ("I don't explain product concepts yet — that's coming later. For now I can help with your plan, recipes, or measurements."). This is the canonical v0.0.5 behavior; the `answer_plan_question` action is strictly for questions about the current plan's structure and does not take on product-meta content as a secondary job.
- **Opinionated food/methodology knowledge base for domain answers.** A small static document (a few thousand tokens) that encodes Flexie's view of food — no food demonization, rice and pasta treated equivalently for weight loss, hyper-palatable/ultra-processed foods are the skepticism target — loaded into the dispatcher's context whenever a domain question is asked. Keeps `answer_domain_question` aligned with PRODUCT_SENSE. For v0.0.5, domain answers use the reasoning model's general knowledge with prompt guidance only.
- **Ingredient-level plan recipe updates.** The re-proposer today handles recipe swaps (picking a different recipe from the library). Updating ingredients within a plan recipe ("use 30g olive oil instead of 15g on Thursday's pasta") is a capability extension of the re-proposer and scoped separately.
- **Meal photo calorie estimation (multimodal).** Scheduled for v0.0.7 per backlog. Would become a new action (`log_photo_meal` or similar) when implemented.
- **Restaurant menu scanning.** Scheduled for v0.0.6 per backlog. Would become a new action when implemented. The dispatcher architecture supports it by design.
- **Session state persistence across bot restarts.** Flow state lives in-memory today; a bot restart drops in-progress conversations. The freeform layer doesn't change that. Scoped to v0.1.0 multi-user readiness.
- **Proactive messages / nudges.** The dispatcher is inbound-only. Outbound nudges are v0.0.6.
- **General chat / small talk.** Out-of-scope by product design. Dispatcher declines politely via `out_of_scope`.
- **Freezing / storage plans.** Backlogged. Affects the deferred `log_eating_out` case where a batch shift exceeds fridge life.
- **Auto-confirm for small plan changes.** Stays "confirm everything" until the re-proposer proves reliable in production. v0.0.5 is still early.
- **Cost and latency optimization of the dispatcher model tier.** Tentative direction is the same tier the re-proposer uses (mini with high reasoning). Optimization (smaller tiers, smaller context, nano for pure classification) is a later concern once quality is proven. The architecture treats the model tier as a single configurable; the specific choice is an implementation-plan decision.

---

## Appendix: Implementation-planning guidance (not part of the design proposal body)

This appendix sits outside the design proposal proper — per the `proposals/README.md` template, proposals should describe experience and design, not decomposition into plans. It's included here because the proposal is large enough that it cannot be implemented as a single plan, and capturing the recommended decomposition while the design context is fresh is more useful than deferring it entirely. **When this proposal is promoted to a design doc, move this appendix into the first implementation plan's "plan of work" section, or delete it.**

### Recommended plan decomposition

This proposal is large enough that implementing it as a single plan would overload the coding agent's context and make intermediate verification impossible. It is likely to be decomposed into several sequential implementation plans.

**The driver for this split is NOT user value delivery speed.** The split exists for two reasons that apply during implementation, not during release staging:

1. **Context clarity for the implementing agent.** Each plan touches one coherent subsystem that can be held in working memory end-to-end — data model, session state, dispatcher routing, action wiring, or action extensions. Mixing subsystems in a single plan forces context switches mid-implementation and produces thinner work everywhere.
2. **Isolated testability at each stage.** After each plan lands, the scenario harness should grow with new tests that prove THAT subsystem works, and `npm test` should stay fully green. If a later plan breaks an earlier one, the regression lands in a test that was written when the earlier plan was fresh in context — not discovered months later.

Each plan in the split below is authored to be independently verifiable. Plans A and B have no user-facing surface and exist entirely to prepare the backend. Plan C lights up read-only dispatcher interactions. Plan D delivers the core living-document feature. Plan E delivers the secondary catalog. **Release staging — whether all plans ship together, in sequence, or behind a feature flag — is a separate decision taken at implementation-planning time and is out of scope for this proposal.**

### Plan A — Re-proposer enablement for post-confirmation

*Scope.* Data model adapter that converts a persisted `PlanSession` + its `Batch[]` into the in-memory `PlanProposal` shape the re-proposer already accepts, splitting past vs. active slots at the (date, mealType) level with server-local wall-clock cutoffs. Round-trip back to `confirmPlanSessionReplacing` with preserved past-slot batches. Mutation history persistence across plan sessions (new `mutation_history` column on `plan_sessions`). Two new rules added to the re-proposer's prompt: the meal-type lane rule (a batch's meal type must be in the recipe's `mealTypes` array) and the near-future safety rule (next ~2 days are soft-locked under post-confirmation context). A new invariant added to the proposal validator checking `batch.mealType ∈ recipe.mealTypes` per batch.

*Verification.* Unit tests for adapter round-trip (load → convert → re-proposer → convert back → confirmPlanSessionReplacing produces the expected final state). Scenarios that call the re-proposer directly with post-confirmation inputs and assert the rules hold — meal-type lanes, near-future safety, valid arrangements.

*Nothing user-facing.* All verification is via direct function calls and unit-scoped scenarios. No dispatcher, no new entry points, no Telegram UI.

*Dependencies.* None.

### Plan B — Navigation state model

*Scope.* Extend session state with a `LastRenderedView` field that precisely captures what the user was looking at: plan subview (next_action / week_overview / day_detail+day), shopping scope (Plan B ships `next_cook` and `day`; Plan E extends the union with `full_week` and `recipe+slug` as a non-breaking addition alongside the shopping-generator scope work), recipe view (cook_view+batchId or library or recipe_detail+slug), progress view. Audit every current session-state-clearing site (several menu handlers destructively clear the planning flow today) and decide which should be preserved, which should be changed, which should be left alone. Update existing handlers that render views to also update the new state.

*Verification.* Unit tests for session-state updates. Scenarios that drive the user through existing flows and verify the new state is tracked correctly. Scenarios covering each audit outcome: "user taps shopping list mid-planning — does planFlow persist or not?" (design decision documented), "user drills into day detail then back — returns to day detail or to week overview?" (design decision documented).

*Nothing user-facing.* Back buttons already exist; this plan just makes them more precise when they eventually get exercised through the dispatcher.

*Dependencies.* None.

### Plan C — Dispatcher infrastructure + minimal actions

*Scope.* The dispatcher itself: single reasoning LLM call, structured output, context bundle builder (see Context hydration section), action catalog as prompt input, routing table from action to handler. The minimal action set that makes the dispatcher exercisable: `flow_input` (passthrough to the active flow's existing text handler), `clarify` (ask a question, no state change), `out_of_scope` (honest decline), `return_to_flow` (re-render the active flow's last view using Plan B's session state). Front-door wiring so text/voice messages hit the dispatcher before flow-specific handling. Numeric measurement pre-filter.

*Verification.* Scenarios covering: in-flow text is routed via `flow_input` and the existing flow consumes it unchanged (regression test for all existing flow-input behavior); a side question during planning routes to `out_of_scope` or a future answer action; typed "ok back to the plan" routes to `return_to_flow` and restores the previous view; **tapping the inline `← Back to planning` button routes through the `plan_resume` / `recipe_resume` callback to the same `handleReturnToFlowAction` code, producing byte-identical bot output AND equivalent `recentTurns` content so the next dispatcher turn resolves referential follow-ups the same way as the typed path** (invariant #7 regression lock); ambiguous input triggers `clarify` and the user's follow-up is dispatched with the clarification in context; the precedence rule between `return_to_flow` phrases and existing cancel patterns is correct.

*Implementation milestone.* The dispatcher is live end-to-end for a minimal action set: typed `"back to planning"` routes through `return_to_flow`, off-topic messages route through `out_of_scope`, ambiguous requests hit `clarify`, and in-flow text still reaches the active flow via `flow_input`. No plan mutations yet, no Q&A, no navigation by name. Whether this slice ships behind a flag or waits for later plans is a separate release-staging decision.

*Dependencies.* Plan B (dispatcher handlers read the extended session state to attach correct back buttons).

### Plan D — `mutate_plan` action (the core living-document feature)

*Scope.* The `mutate_plan` action handler, which wires together everything below it. Dispatcher routes a `mutate_plan` action to this handler. The handler checks whether there's an active planning session: if yes, it calls the re-proposer on the in-memory proposal (existing behavior, now reachable via the dispatcher); if no, it loads the active plan via Plan A's adapter and calls the re-proposer in post-confirmation mode. Re-proposer output is validated (including the new invariants from Plan A), diffed, and presented for user confirmation. On confirm, post-confirmation mutations are persisted via `confirmPlanSessionReplacing`. The confirm UX for both contexts.

*Verification.* Scenarios for the motivating real-life cases: "I'm eating out tonight" from the plan view (post-confirm mutation shifts dinner batches forward in-lane), "move flex to Sunday" mid-planning (active-session mutation preserves mutation history), "swap tagine for fish" post-confirmation (recipe swap at the batch level), retroactive "last night I went to Indian" (forward-shift-only behavior, honest messaging about calorie tracking being deferred), state preservation during a mid-planning mutation that came through a side conversation (plan session is preserved; mutation history is preserved). Each scenario verifies meal-type lanes and near-future safety as applicable.

*Implementation milestone.* This plan's scenarios prove the living-document feature works end-to-end: dispatcher → adapter → re-proposer → validator → confirm, for both in-session and post-confirmation mutations. It's the plan where the north-star capability described in the proposal is technically deliverable. Release staging (does this slice ship immediately, wait for Plan E, go behind a flag, etc.) is a separate decision.

*Dependencies.* Plan A (adapter + prompt rules) and Plan C (dispatcher). Does NOT depend on Plan E (secondary actions).

### Plan E — Secondary actions (answers, navigation, log_measurement)

*Scope.* All remaining catalog entries. Answer actions: `answer_plan_question`, `answer_recipe_question`, `answer_domain_question` — each with prompt design, context injection, no-fabrication rules. Navigation actions: `show_recipe` (including multi-batch disambiguation rule), `show_plan` (with subview routing), `show_shopping_list` (requires extending the shopping generator with `full_week / recipe / day` scope support), `show_progress`. Small delegating action: `log_measurement` (thin wrapper over the existing numeric parser reachable from any surface). Each action is an independent unit of work within this plan; they can be implemented and merged in any order.

*Verification.* Scenarios per action. Generator unit tests for the new scopes. Fuzzy slug-matching scenarios for `show_recipe`. Cross-action scenarios validating state preservation: asking a plan question during planning, then requesting a mutation, routes to the active session's re-proposer (regression test for invariant 1 from the state preservation section, now exercised through the answer→mutation path).

*Implementation milestone.* After Plan E lands, the full catalog of 13 active actions is technically implemented and the proposal's scope is complete. Release staging remains a planning-phase decision.

*Dependencies.* Plan C is the core structural dependency — Plan E's answer and navigation action handlers plug into the dispatcher runner Plan C builds. The **core capabilities** of Plan E (answer_plan_question, answer_recipe_question, answer_domain_question, show_recipe, show_plan, show_shopping_list, show_progress, log_measurement) do NOT logically depend on Plan D's `mutate_plan` — they could theoretically ship without it. However, Plan E's cross-action state preservation scenario (the "answer question during planning, then request a mutation, then confirm" regression lock for invariant #1) requires the `mutate_plan` action to exist end-to-end, which is Plan D's deliverable. Since the strictly-sequential implementation order (A → B → C → D → E) guarantees Plan D ships before Plan E, the concrete execution plan for Plan E declares D a hard prerequisite and exercises the full D+E integration in its load-bearing regression scenario. The dependency graph below reflects the core-capability view; the execution plan reflects the scenario-coverage view.

### Dependency graph

```
A (re-proposer enablement) ─┐
                             ├──► D (mutate_plan action)
B (navigation state) ──► C ──┤
  (dispatcher + minimum)     └──► E (secondary actions)
```

### Suggested implementation order

A → B → C → D → E. This is strictly sequential for context narrowing, even though some plans could theoretically be parallelized. Strictly sequential keeps the agent's attention on one subsystem at a time and means each plan's tests are written while that subsystem is fresh in context.

After each plan:
- All existing tests still green (`npm test`).
- New scenarios covering THAT plan's surface are added and green.
- The product specs relevant to that plan's subsystem are updated in the same commit as the code (per `CLAUDE.md`'s docs-maintenance rules).
- The plan file moves from `active/` to `completed/`.

### Plans NOT in this decomposition (explicitly deferred)

- **Deviation accounting** (running budget state, `log_treat` handler, `log_eating_out` handler, three-tier deviation response, absorption hierarchy, retroactive state tracking). Its own proposal and plan after v0.0.5's freeform layer is stable in production.
- **`answer_product_question` action** and its opinionated food/methodology knowledge base. Its own future plan.
- **Ingredient-level plan recipe updates**. Its own future plan — requires a capability extension in the re-proposer and a new validator rule.
- **Meal photo calorie estimation** (v0.0.7 per backlog). Would become a new action with a new handler; the dispatcher architecture supports it by design.
- **Restaurant menu scanning** (v0.0.6 per backlog). Same shape.
