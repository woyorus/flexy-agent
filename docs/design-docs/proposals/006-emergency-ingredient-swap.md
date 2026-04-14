# Emergency Ingredient Swap — Batch-level content edits when pantry or store can't match the plan

> Status: draft
> Date: 2026-04-13
> JTBD: C1 "Handle missing ingredients at cook time" (primary). A2 "Build a shopping list" at the in-store variant. Adjacent to A3 "Cook from the plan" — the cook view must reflect what the user will actually cook.
> PRODUCT_SENSE alignment: "The plan is a living document, not a contract." "The system should bend without breaking." "Low friction comes first." "Calorie precision is a fiction; ballpark is the goal." The feature absorbs the moment where pantry or store diverges from the plan — no waste, no drama, no in-head math.

## Problem

Real life diverges from the plan at two moments:

1. **Cook time.** The user is in the kitchen, pan on the stove, about to cook a batch. They read the recipe card and realize the pantry doesn't match: no white wine, no passata, no specific cheese, no parsley. They have beef stock and cherry tomatoes instead. They want the recipe card they cook from to **reflect what they will actually cook** — names, amounts, steps — with macros still landing in the batch's target ballpark.

2. **At the grocery store.** The user is in the aisle with the shopping list pulled into Apple Notes. The fish counter is out of salmon. The herb section has no parsley. They want to tell the bot what they grabbed instead, keep the shopping list useful for the rest of the run, and know the cook-time view will match when they get home.

In both moments, the user's mental state is the same: **fix this one thing, don't derail the plan**. The rest of the ingredients are already bought. The rest of the week is already in motion. The batch's calorie target is the batch's calorie target. They just need one — sometimes two — ingredients swapped, persisted for this batch, with the math already done.

Today, the bot can talk about this problem but not solve it.

## Current experience

From the debug log of 2026-04-13 14:00–14:03, captured verbatim:

**User** (on the Salmon Calamari Pasta cook view): *"Let's edit this recipe. I don't have white wine, and i may not have tomato passata - I'd rather use cherry tomatoes for this."*

**Bot**: *"Yes — for the white wine, a splash of stock or water with a little lemon juice is a good swap. For tomato passata, cherry tomatoes work well: cook them down until they burst and get saucy, or blend them first for a smoother result. If you want, I can also suggest a simple ratio for the swap."*

**User**: *"Edit the recipe itself."*

**Bot**: *"I can suggest swaps for this recipe, but I can't directly edit the recipe card yet. If you want, I can help adapt the ingredients or show the recipe again."*

**User**: *"Help adapt."*

**Bot**: [same generic substitution advice as before, no amounts]

**User**: *"Yes exact amounts. And can I use beef stock?"*

**Bot**: *"Yes — beef stock is fine as a swap for the white wine. I can't see the exact ingredient amounts for this recipe, so I can't give a precise ratio, but a good rule is: use a small splash of stock with a little lemon juice for the wine, and use cherry tomatoes cooked down until saucy in place of passata."*

Four exchanges. Zero updates to the recipe card. The user is now translating "a small splash" onto a screen that still says "60ml dry white wine" and "200g tomato passata," doing the gram math in their head, and cooking against a recipe that literally does not match what's in their pan.

The emotional arc under the hood:

- *"The bot knows this recipe. I just want it to change one ingredient."*
- *"Why is it explaining substitution theory to me? I know what to do — I need it done."*
- *"It literally just said it can't see the ingredient amounts. What is the point of the recipe being here?"*
- *"I'll figure it out myself. And I'll stop asking the bot when this happens."*

This is the exact failure mode `PRODUCT_SENSE.md` names: *"a system that only works at home, in ideal conditions, is not enough."* Real life is not ideal conditions; it's beef stock when the recipe calls for white wine. A product that cannot absorb that gap is not flexible — it is rigid with a friendly tone.

## Proposed experience

### Core behavior

The user says — in any message, typed or voice, from any surface — what changed about their ingredients. When the change is unambiguous and non-structural, the bot rewrites the batch in place, rerenders the cook card with updated ingredient list and step text, and closes with a clear delta line at the bottom. When the change is ambiguous (multiple batches could be the target), hedged ("I may not have it"), or structural (main protein, recipe-identity ingredient), the bot previews first and waits for a spoken confirmation — still no buttons, just a word back. Either way, the next message can refine further ("no lemon, just stock") or undo ("actually I found the wine, swap back") through the same path. Explicit apply/ask criteria are listed under Design Decisions.

### Screen 1 — Simple swap, small macro drift (noise)

**Context:** User is on the Salmon Calamari Pasta cook view. Types or speaks:

*"no white wine, use beef stock instead"*

**Bot reply:**

> **Salmon and Calamari Linguine in Tomato-Cream Sauce**
> *2 servings · 890 kcal · 54g protein / serving*
>
> **Ingredients (batch total)**
> - Raw salmon fillet — 280g
> - Cleaned raw calamari rings — 220g
> - Dry linguine — 120g
> - Tomato passata — 200g
> - Cooking cream 18% — 40g
> - Yellow onion — 1 whole
> - Garlic cloves — 2
> - Olive oil — 15g
> - Beef stock — 60ml *(was: dry white wine)*
> - Lemon juice — 1/2 tsp
> - Chili flakes, parsley, salt, pepper — to taste
>
> **Steps**
> 1. Dice the yellow onion and mince the garlic cloves.
> 2. Bring a large pot of salted water to a boil for the 120g dry linguine.
> 3. Heat 15g olive oil in a wide pan over medium-high, sear the 280g salmon skin-side down, 3 min.
> 4. Add the 220g calamari rings, cook 1 min, then push everything to the side.
> 5. Sauté the onion and garlic in the pan drippings, 2 min.
> 6. Pour in **60ml beef stock and 1/2 tsp lemon juice**, simmer until reduced by about half, ~2 min.
> 7. Stir in 200g tomato passata and 40g cooking cream, simmer 4 min.
> 8. Cook and drain the linguine, toss everything together, season.
> 9. Divide evenly into 2 portions.
>
> ———
> **Swapped:** dry white wine (60ml) → beef stock (60ml) + lemon juice (1/2 tsp)
> **Macros:** −12 cal/serving — within noise, week still on pace.

**What the user feels:** The recipe they'll actually cook is right here. Telegram auto-scrolled to the last line, so the first thing they see is the one-line delta confirming what just happened — including the small helper (lemon juice) the bot added to approximate wine's acidity, named openly rather than slipped in. The recipe is above if they want to read it through. Nothing more to do.

*Why auto-apply is safe here:* the target batch is unambiguous (the user is on that exact cook view), the substitute is a common named ingredient, and the change is a non-structural ingredient swap. All three auto-apply conditions hold.

**Keyboard:** Standard main menu (Plan / Shopping List / My Recipes / Progress). No special "confirm" or "undo" button — the plan is already updated.

### Screen 2 — Compound swap, meaningful macro drift (open rebalance)

**Context:** Same cook view. User types, both swaps in one breath:

*"no white wine and no passata — use beef stock and cherry tomatoes"*

**Bot reply:**

> **Salmon and Calamari Linguine in Cherry-Tomato Cream Sauce**
> *2 servings · 888 kcal · 54g protein / serving*
>
> **Ingredients (batch total)**
> - Raw salmon fillet — 280g
> - Cleaned raw calamari rings — 220g
> - Dry linguine — 120g
> - Cherry tomatoes — 200g *(was: tomato passata)*
> - Cooking cream 18% — 40g
> - Yellow onion — 1 whole
> - Garlic cloves — 2
> - Olive oil — **18g** *(was: 15g)*
> - Beef stock — 60ml *(was: dry white wine)*
> - Lemon juice — 1/2 tsp
> - Chili flakes, parsley, salt, pepper — to taste
>
> **Steps**
> 1. Dice the yellow onion and mince the garlic cloves. Halve the 200g cherry tomatoes.
> 2. Bring a large pot of salted water to a boil for the 120g dry linguine.
> 3. Heat 18g olive oil in a wide pan over medium-high, sear the 280g salmon skin-side down, 3 min.
> 4. Add the 220g calamari rings, cook 1 min, then push everything to the side.
> 5. Sauté the onion and garlic in the pan drippings, 2 min.
> 6. Pour in 60ml beef stock and 1/2 tsp lemon juice, simmer until reduced by half, ~2 min.
> 7. **Add the halved cherry tomatoes, cook 4–5 min, pressing them with a spoon as they release juice and collapse into a saucy base.**
> 8. Stir in 40g cooking cream, simmer 2 min.
> 9. Cook and drain the linguine, toss everything together, season.
> 10. Divide evenly into 2 portions.
>
> ———
> **Swapped:** dry white wine (60ml) → beef stock (60ml) + lemon juice (1/2 tsp)
> **Swapped:** tomato passata (200g) → cherry tomatoes (200g, halved)
> **Rebalanced:** olive oil 15g → 18g, to hold the calorie target after the wine's calories dropped out.
> **Macros:** 888 kcal / 54g protein per serving — on target.

**What the user feels:** Both swaps done in one go. The step about "reducing wine until the alcohol cooks off" is gone — step 6 now reads correctly for stock. Step 7 knows cherry tomatoes need crushing. The olive oil bump is called out openly so there's no surprise when they reach for the bottle. Telegram shows the delta block at the bottom first; if something is wrong, the user can say so in the next message.

### Screen 3 — Removal (no replacement)

**Context:** Cook view of Beef Tagine. User types:

*"skip the raisins, I ran out — also no parsley"*

**Bot reply:**

> **Moroccan Beef Tagine-Style Skillet with Lemon Couscous**
> *2 servings · 804 kcal · 52g protein / serving*
>
> [recipe body with raisins and parsley removed from the ingredient list; steps 4 and 7 rewritten to remove references]
>
> ———
> **Removed:** raisins (30g)
> **Removed:** parsley (5g garnish)
> **Rebalanced:** olive oil 12g → 14g, to cover the raisins' calories.
> **Macros:** 804 kcal / 52g protein per serving — on target.

The delta line phrases removal as "Removed X," not "Swapped X → nothing." **The delta block always lists every change the user asked for** — both the raisins and the parsley — because that confirms the bot heard them. Only the raisins triggered an open rebalance in this example; the parsley is listed for acknowledgment but does not earn an olive-oil bump because its calorie weight sits inside the noise floor. The rule: **confirm every user-named change in the delta; only call out rebalance action when macros cross the noise floor.**

### Screen 4 — Help-me-pick mode (user uncertain)

**Context:** User is at the supermarket. Last-rendered view: shopping list. They voice-note:

*"they don't have salmon, what should I get?"*

**Bot reply:**

> For the Salmon Calamari Pasta batch, any of these work — pick what's on the counter:
>
> - **Trout fillet (280g)** — closest swap. Same prep, ~same macros (+25 cal/serving, protein holds at ~52g).
> - **Sea bass fillet (280g)** — leaner, ~40 fewer cal/serving, protein holds.
> - **Cod loin (320g)** — more neutral flavor, needs a slightly larger portion to match protein (320g vs 280g).
>
> Tell me which one and I'll update the recipe.

The user grabs cod, voice-notes *"got the cod, 320g,"* and the bot applies that swap (Screen 5 below). The "help me pick" flow is the same dispatcher action as a directed swap — the bot's reply shape is just a suggestion list when the user's message is help-seeking rather than directing.

### Screen 5 — In-aisle applied swap (grocery-store moment)

**Context:** Same session as Screen 4. User voice-notes:

*"got the cod, 320g"*

**Bot reply:**

> **Salmon and Calamari Linguine** *(renamed: Cod and Calamari Linguine in Tomato-Cream Sauce)*
> *2 servings · 885 kcal · 54g protein / serving*
>
> [full updated recipe card with 320g cod replacing 280g salmon, step 3 rewritten — "pan-sear the 320g cod fillet skin-side down, 4 min, it firms up faster than salmon"]
>
> ———
> **Swapped:** salmon fillet (280g) → cod loin (320g) — bumped the portion by 40g to keep the protein target.
> **Macros:** −5 cal/serving, 54g protein — on target.
> **Shopping list updated:** salmon removed, cod added. Rest of your list is unchanged.

The full card is rendered even though the user is in the aisle. The delta at the bottom answers the in-store question ("yes, cod 320g, list is updated, carry on"). The card is there for cook night, and the user can ignore it for now — Telegram's auto-scroll puts the delta in view first, the recipe above is noise they'll read later.

### Screen 6 — Ambiguity plus a structural swap: two asks folded into one

**Context:** It's a week where chicken breast appears in two batches. User types:

*"out of chicken, what about tofu"*

**Bot reply (preview only — no persistence yet):**

> Chicken breast is in two batches this week:
> - **Chicken Black Bean Bowl** (lunch, Sun–Tue)
> - **Chicken Pepperonata** (dinner, Fri–Sat)
>
> Swapping to firm tofu would bump the portion ~30% (200g chicken → 260g tofu) and land protein at ~44g/serving per batch (down from 56g). The calorie side stays on target in both.
>
> Apply to one, both, or neither?

The bot combines the two must-ask cases — ambiguous target AND structural main-protein swap — into a single preview. The user picks with one reply ("both" / "just the lunch one" / "neither, let me think") and the swap commits on that confirmation. No buttons.

### Screen 7 — Structural swap, ask-first, then apply

**Context:** User is on the Chicken Black Bean Bowl cook view. Types:

*"use tofu instead of chicken breast"*

**Bot reply (preview only — no persistence yet):**

> Swap chicken breast (200g) → firm tofu (260g)?
>
> I'd bump the portion ~30% to close most of the protein gap, but not further — more tofu would make the bowl feel off. Protein would land at ~44g/serving (down from 56g). Calorie side stays on target.
>
> OK to apply, or want a different protein?

**User replies:** *"go ahead"*

**Bot reply:**

> **Chicken Black Bean Bowl** → **Tofu Black Bean Bowl**
>
> [full updated card with firm tofu replacing chicken breast, portion bumped from 200g chicken → 260g firm tofu]
>
> ———
> **Swapped:** chicken breast (200g) → firm tofu (260g)
> **Macros:** 880 kcal / 44g protein per serving — protein below your per-serving norm, but the week's total is still in the ballpark.

The bot asked first because the swap is structural (main protein, big protein gap). After the user's one-word confirm, it commits. It does not propose a protein shake; it does not push the user to change a different meal. Future versions may offer a shake suggestion, but for this proposal, transparent honesty is the end state. The user absorbs the information or keeps going — both are fine.

## Design decisions

### The bot has no location — but it reads the user's

Any swap intent works from any message, typed or voice, regardless of what the bot last rendered. The bot uses the view it most recently showed, the user's active batches, and the message itself to resolve which batch is the target. If the user is on a cook card and says "swap the oil," the cook card is the target. If they're on the shopping list, the ingredient resolves via active batches. If they're at the main menu, it still works — the bot identifies the affected batch(es) and asks only if truly ambiguous (Screen 6).

This principle is broader than this feature — Telegram is a conversation, not a navigation tree, and every actionable intent should obey this rule. It is worth promoting to `PRODUCT_SENSE.md` or `ARCHITECTURE.md` as a standing rule, as a follow-up to this proposal.

### Auto-apply when the conditions are met; otherwise ask

The default is to apply the swap immediately — no `[Apply] [Cancel]` buttons, no "are you sure?" — because confirming the obvious is friction in moments (grocery aisle, cooking in progress) where friction is the enemy. But auto-apply is conditional on the batch target being unambiguous, the substitute being named and common enough for a confident macro estimate, and the change being non-structural. When all three hold, the bot commits; otherwise it shows a compact preview and waits for a natural-language confirm. The detailed criteria live in the next section.

In both paths, reversal is always just another message — "actually I found the wine, swap back" — consistent with the conversational-not-forms posture.

### When the bot asks first

The ask path is the safety valve on auto-apply. The bot previews a swap and waits for a natural-language confirm ("go ahead" / "do it" / "no, use cod instead") — no buttons — in any of these cases:

- **Target batch is ambiguous.** The ingredient appears in more than one active batch and the surface does not disambiguate (the user is on the main menu, the shopping list, or a non-specific view). Screen 6 shows this.
- **The user's own message is hedged.** "I *may* not have passata" / "I *think* we're out of cheese." The hedge is a signal the user isn't certain; the bot must check before persisting, not roll the dice on a guess.
- **The substitute is unknown, vague, or imprecise.** "Some of grandma's pickled garlic" / "whatever fish they had" / "a little something acidic." The bot confirms its interpretation (macro assumption + ingredient identity) before committing.
- **The change is structural.** Removing or replacing the main protein, the only carb source, or an ingredient the recipe identity hangs on (salmon in the salmon-calamari pasta). These are near the boundary where ingredient-swap tips into recipe-swap; a preview keeps the user in control of that boundary.
- **The last-rendered view is stale.** The user was on a cook view earlier but has moved on since. Context hygiene: when the attachment is weak, the bot confirms.

The preview is a compact one-liner: what the bot would do, what that does to the macros, and a question. Example: *"Swap chicken breast (200g) → firm tofu (260g) on the Black Bean Bowl batch? Protein would land at ~44g/serving (down from 56g). OK to apply?"* The user either confirms in words, redirects ("actually use chickpeas"), or cancels ("nevermind, I'll wait"). No state is persisted until the user says go.

The user's trust in this feature depends on the bot not silently editing the wrong plan. Asking is cheap; wrong persistent mutations are expensive.

### Full updated card above, delta line at the bottom

Telegram auto-scrolls to the newest message, and the bottom of that message is what the user sees first. The delta at the bottom answers the immediate question ("what just changed?"); the full updated recipe card sits above for when the user is cooking. Same format at cook time and in the grocery aisle — no context-sensitive trimming, because predictable formatting is more valuable than saving a few scroll-lines.

### Untouched stays untouched — with bounded exceptions for pantry staples

The swap only moves what the user called out. **Precisely-bought items** — weighed proteins, pasta by weight, packaged portions, produce with specific gram targets — keep the exact same name and the exact same amount. No silent additions, no silent subtractions, no silent resizing. The user has already bought these, and the batch's job is to match their kitchen reality. This is a hard invariant.

Two bounded exceptions are allowed, both restricted to **pantry staples** (fats, salt, stocks, vinegars, acids, herbs, spices, sugar — items the user has in the kitchen in abundance, where a 10g nudge doesn't require a second grocery trip):

1. **The substitute's own amount is flexible.** By definition, the user just told us they have it; the bot can scale it within the reasonable-recipe bounds described elsewhere (protein scaling limit, calorie landing).
2. **A pantry-staple helper may be introduced when it's standard culinary wisdom to do so, and pantry-staple amounts may flex for rebalance.** Wine → stock + a touch of acid. Cream → milk + butter. Buttermilk → milk + vinegar. Olive oil can nudge 15g → 18g to hold the calorie target. When the bot introduces a new helper ingredient or changes a pantry-staple amount, the change is **always named openly in the delta** — no silent additions.

Anything else — introducing a new precisely-bought ingredient, or changing the amount of one already committed to the shopping list — is a hard no. The ingredient's role on the recipe is what classifies it as pantry-staple or precisely-bought.

### Calorie precision is a fiction; ballpark is the goal (noise rule)

Per the PRODUCT_SENSE principle now captured explicitly: within ~±10% of the target, drifts are absorbed **without drama**. The bot may still print a brief one-line acknowledgment ("on pace", "on target", "within noise") — that is reassurance that nothing broke, not narration of a problem. What the bot does not do inside the noise floor is frame the drift as a concern, compute corrective actions, or ask the user about it.

Beyond ~±10%, drifts become planning events. The bot states them openly and either rebalances (Screen 2's olive oil bump) or names the gap honestly when rebalance can't close it (Screen 7's tofu-protein shortfall). Large silent drifts — persisted mutations whose macro impact the user never hears about — are never acceptable.

### Protein: modestly scale the substitute, never force a match

For big protein gaps (tofu instead of chicken, chickpeas instead of beef), the bot scales the substitute up by roughly 20–30% when that's sensible — enough to close much of the gap without making the recipe weird (260g tofu on a bowl is fine; 400g tofu is a tofu mountain). Beyond that natural limit, the bot states the protein landing honestly and does not try to fix it. A future escape hatch — "I could suggest a 30g whey scoop on the side to close the last 12g" — is explicitly out of scope for this proposal.

### LLM rewrites any step mentioning a swapped ingredient

Steps that reference the swapped ingredient by name ("Reduce the white wine until the alcohol cooks off") are regenerated by the same LLM call that computes the swap. This matches the quality of the existing recipe-edit refinement flow and ensures cook-time instructions match cook-time ingredients. The cost (a few seconds, a fraction of a cent) is negligible against the cost of a mis-cooked meal.

### Compound swaps in one message

Multiple swaps and removals in one user message are handled in a single reply with one delta block listing each change. The user's own phrasing in the debug log ("no white wine and I may not have tomato passata") is compound — asking them to serialize it into two messages is friction for no gain.

### Directed and help-me-pick via the same action

Directed swap ("use beef stock") is resolved immediately. Help-me-pick ("I'm out of wine, what can I use?") returns 2–3 options tuned to the recipe and the user's food profile. These are the same dispatcher action; the LLM decides from the message shape which response mode to use. The user can move from help-me-pick to directed in one follow-up ("go with the stock").

### Reversibility via conversation

"Actually I found the wine, swap back" is just another swap. There is no `[Undo]` button. The batch is stateful; each swap is a mutation on the current state; reversals are new messages through the same dispatcher. The resolution rules for what "back," "undo," and specific reversal references mean are defined explicitly in the "Swap, then another swap, then undo" edge case — so "back" never means something arbitrary to the user. The ask-first criteria apply: if a reversal is structural or ambiguous, the bot confirms before persisting.

### Library recipes are never touched

This feature only mutates **this batch** — its ingredient list, its per-serving macros, and the step text the user sees on the cook card for this batch. The library recipe stays canonical and untouched. A user who wants a swap to be permanent across future weeks uses the existing recipe-edit flow against the library recipe itself, which is a different intent reached through a different conversation.

### Swaps persist the moment they're committed

The swap is written to the batch the instant the bot commits — whether that commit happened immediately under the auto-apply rules, or after the user's natural-language "go ahead" under the ask-first rules. There is no "draft" state after the commit, no second confirm-to-save step, no view-layer overlay that evaporates on reload. If the user closes Telegram and reopens the cook view two hours later, they see the swapped ingredient list, the rewritten steps, and the updated macros. If they pull up the shopping list, it reflects the swap. If they walk away mid-cook and come back tomorrow, the batch is still the swapped version.

Batch mutations do not survive the week boundary: when a new plan is confirmed, the next week's batches are generated from the library recipes afresh. A swap the user wants to keep across weeks is a library-edit, which is a different conversation.

When the conditions for auto-apply hold, the user's single message ("no white wine, use beef stock") is both the intent and the commit. When they don't, the bot asks first and the user's confirmation is the commit. Undo is always another message.

### The shopping list is a live projection, not a past-purchase record

The shopping list is generated from batches on demand. It is the product's current best answer to *"what does this week's plan need?"* — not a historical record of what the user bought on their last trip. That answer changes when the plan changes, including when a swap mutates a batch at cook time, hours after the grocery trip is done.

Two phases, one meaning:

- **Before the grocery trip**, the list is the procurement artifact the user copies into Apple Notes. In-aisle swaps update it in real time so the rest of the run stays useful.
- **After the grocery trip**, the list is still a valid reference for *"what this week's plan currently needs."* It is not a record of what the user bought. The user's kitchen is the truth about what was bought, and the product does not try to maintain a parallel purchase log — that would be a tracking feature, and the product is planning-first.

Consequence: if the user swaps salmon → cod at cook time after having bought salmon, the shopping list reflects cod from that moment forward, because that is what the plan now calls for. The salmon-in-fridge is kitchen reality, not a list concern. This is consistent and simple; the alternative (freezing the list at shop time) would require a tracking layer the product deliberately does not have.

### Emotional arc

The emotional arc at both cook time and grocery time is: *friction → resolution*. The user reports what they have; the bot absorbs the change; the plan moves on. No guilt, no "well, ideally you would have…," no math homework. The bot's tone is practical — "swapped X → Y, macros on pace" — not performative.

## Edge cases

### Unknown substitute (no macro knowledge)

User says *"use my grandma's pickled wild garlic."* The LLM has no macros for that exact item — this hits the must-ask criterion for unknown or imprecise substitutes. The bot previews with an explicit assumption and waits for confirmation: *"I don't know your grandma's pickling exactly — I'd read this as roughly pickled garlic / wild garlic, ~12 cal/tbsp. Swap in 2 tbsp for the recipe's parsley on that estimate? Tell me if the calorie guess is off or you meant something different."* The user confirms, corrects the estimate, or renames the intent. Only then is the swap persisted. This is preferable to refusing (useless) and to silently persisting a guess (dishonest), and is consistent with the ask-first rule for unknown substitutes.

### Mid-cook swap

User is already cooking — has already sauteed the onion and added the chicken. They realize the passata is out. The bot does not know this (no tracking), but the swap still works: the recipe card updates, the remaining steps reflect the swap, the user continues from where they are. Steps before the swap point may now be slightly inconsistent on re-read, which is fine — the user is in the kitchen, not reading for reference.

### User uses different units than the recipe

User says *"they had salmon in 10 oz fillets, I grabbed two."* The bot converts (10 oz ≈ 283g, two fillets ≈ 566g) and recognizes this is roughly double the recipe's 280g — a scale shift rather than a same-amount swap. Because the change is structural (it doubles the batch's protein and reshapes serving size), the bot previews rather than applies: *"Two 10 oz fillets is ~566g salmon — roughly double the recipe's 280g. I can (a) scale the batch to 4 servings so the portion size stays the same, or (b) keep 2 servings with a much larger salmon share each. Which do you want?"* Nothing is persisted until the user picks. A plain unit conversion within the same target amount ("they had it in ounces, I grabbed 10 oz" when the recipe called for 280g ≈ 10 oz) is handled silently — that's not a scale shift, just a unit difference.

### Ingredient appears in multiple batches

The bot names each affected batch and asks once: "*chicken is in two batches this week — Black Bean Bowl (Sun–Tue) or Pepperonata (Fri–Sat)? Or both.*" Default is to apply to the nearest cook day if the user's message strongly implies "right now" (e.g., user is on a cook view or says "tonight's recipe"). This keeps the ambiguity prompt rare rather than routine.

### Swap that catastrophically breaks the recipe identity

User says *"skip the salmon AND the calamari"* on the salmon-calamari pasta. There is no protein left. The bot does not silently cobble something together; it says: *"Without salmon and calamari, there's no protein anchor left. I can: (a) swap in another fish or chicken, or (b) swap this batch for a different recipe from your library. Which?"* Option (b) routes to the existing plan-mutation path — the same one the user already uses for "swap tomorrow's dinner for something else." This feature stays scoped to ingredient-level edits and defers recipe-level swaps to the flow built for them.

### Swap, then another swap, then undo

The batch's current state is always the result of the library recipe plus applied swaps. Each new message operates on the current state. The user does not see a swap history UI; they express intent in natural language. The bot's resolution rules for reversal words are fixed:

- **"swap back" / "undo" / "revert" (unqualified)** → undo the **most recent** swap on this batch.
- **Named reference** ("the wine is back" / "put the passata back" / "use salmon again") → undo that specific swap, regardless of whether it was the most recent.
- **"reset to original" / "back to the library recipe" / "undo all my swaps"** → restore the batch to the library-derived version (every swap on this batch reversed).
- **Ambiguous "undo" after multiple swaps with no named reference** → the bot asks: *"which one — the wine swap or the passata swap?"*

The user is never left to guess what "back" means. The rules are explicit, the named-reference path is first-class, and full reset is its own affordance. Auto-apply and ask-first rules from the "When the bot asks first" design decision apply to reversals exactly as they apply to forward swaps.

### Breakfast recipes

Breakfast is weekly-locked and meal-prepped (eggs/bread/yogurt etc. are on the shopping list). Swaps work identically: *"no yogurt, use cottage cheese instead"* updates the breakfast recipe scaling for the rest of the week. Same dispatcher, same mechanics. No special breakfast surface.

### Voice input

Identical to text. Whisper transcription runs first (already in the freeform conversation path), the transcript feeds the same dispatcher, the same swap action applies.

### Batch already consumed / cook day in the past

If the user swaps on a batch whose eating days have already passed (all servings eaten), there is nothing left to cook on this batch. The bot replies: *"That batch is already done — nothing left to cook. If the same ingredient is in an upcoming batch and you want to swap it there, tell me which one. Or if you want this swap baked into the recipe across future weeks, edit the library recipe itself — that's a separate conversation."* The emergency-swap feature never modifies library recipes on its own and never silently carries a swap forward into batches the user didn't name. The two concrete paths — apply to a specific upcoming batch, or open the library-edit flow — are the user's to pick.

## Out of scope

- **Protein shake / supplement suggestions** when rebalance cannot close a protein gap. The bot states the gap honestly; suggesting a shake is a future feature.
- **Promoting frequent swaps to library preferences.** If the user skips parsley three weeks running, a future version may offer to drop it from the library recipe. Not in this feature.
- **Recipe-level swap (swap the whole batch for a different recipe).** Already handled by the existing plan-mutation path in the freeform conversation layer; this feature stays at the ingredient level and defers to that path when substitution fails.
- **Making the swap permanent on the library recipe.** The existing recipe-edit flow exists for this; the user reaches it through a different intent.
- **Shopping-list-only "tick off an item" mechanics.** Swaps at the grocery store update the list semantically (salmon → cod), but the list is still read-only in terms of check-off state. That is a separate shopping-list feature.
- **A terse aisle-only response mode.** We committed to one response shape (full card above, delta at bottom) in both contexts. A future optimization could conditionally trim the card in clear grocery-moment contexts; not this proposal.
- **Promoting the "bot has no location" principle to `PRODUCT_SENSE.md` or `ARCHITECTURE.md`.** Worth doing as a follow-up doc edit — the principle is cross-cutting and this feature is its first full citation. Not part of this feature's implementation.
