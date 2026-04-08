# Telegram UI

> Scope: Telegram interface — keyboards, message formatting, voice input, interaction patterns. See also: [flows.md](./flows.md) for the conversation logic behind these UI elements.

Source: `src/telegram/bot.ts`, `src/telegram/keyboards.ts`, `src/telegram/formatters.ts`

## Main menu (persistent reply keyboard)

Always visible at the bottom of the chat. Each button enters a flow or shows data. The top-left button label changes based on plan lifecycle:

**No plan / expired:**
```
[ Plan Week ]      [ Shopping List ]
[ My Recipes ]     [ Progress ]
```

**Planning in progress:**
```
[ Resume Plan ]    [ Shopping List ]
[ My Recipes ]     [ Progress ]
```

**Active plan:**
```
[ My Plan ]        [ Shopping List ]
[ My Recipes ]     [ Progress ]
```

See [ui-architecture.md](./ui-architecture.md) § Main menu for full lifecycle-aware button behavior and design rationale.

## Interaction patterns

- **Inline keyboards** — Flow-specific choices (approve/swap/generate). Taps bypass the LLM and map directly to flow handler actions.
- **Reply keyboard** — Persistent main navigation.
- **Voice input** — Telegram voice messages transcribed via Whisper, then processed identically to text. Voice is the preferred low-friction input.
- **Free-form text** — For event descriptions, recipe preferences, swap requests. Interpreted by the LLM in the context of the current flow phase.

## Plan week keyboards

| Phase | Keyboard | Buttons |
|---|---|---|
| context | `planBreakfastKeyboard` | Keep it / Change this week |
| context | `planEventsKeyboard` | No meals out / Add meal out |
| awaiting_events | `planMoreEventsKeyboard` | That's all / Add another |
| recipe_suggestion | `planRecipeGapKeyboard(i)` | Generate it / I have an idea / Pick from my recipes |
| reviewing_recipe | `planGapRecipeReviewKeyboard` | Use it / Different one |
| proposal | `planProposalKeyboard` | Looks good! / Swap something |
| confirmed | `planConfirmedKeyboard` | Shopping list / View recipes |

## Recipe flow keyboards

| Phase | Keyboard | Buttons |
|---|---|---|
| choose_meal_type | `mealTypeKeyboard` | Breakfast / Lunch / Dinner |
| reviewing | `recipeReviewKeyboard` | Save / Refine / New recipe / Discard |

## Recipe list (paginated)

`recipeListKeyboard(recipes, page, pageSize)` — Each recipe is a tappable button (callback: `rv_{slug}`). Paginated with prev/next navigation.

Single recipe view: `recipeViewKeyboard(slug)` — Back to recipes / Edit / Delete.

## Callback data and slug truncation

Telegram limits callback data to 64 bytes. Recipe slugs are truncated via `truncateSlug()` (max 61 chars after 3-char prefix). Handlers use `findBySlugPrefix()` as fallback when the truncated slug doesn't match exactly.

Callback prefixes: `rv_` (view recipe), `re_` (edit recipe), `rd_` (delete recipe), `rp_` (page navigation).

## Fun food keyboards (legacy)

`funFoodKeyboard()`, `skipFunFoodKeyboard()`, `funFoodConfirmKeyboard` exist in keyboards.ts but are **not used** in the current plan flow. The fun food step was replaced by automatic flex slot suggestion in the plan-proposer. These keyboards may be removed in a future cleanup.
