/**
 * Navigation state — the precise "what the user is looking at" model.
 *
 * Part of Plan 027 (Navigation state model, Plan B from proposal
 * `003-freeform-conversation-layer.md`). The goal of this module is to
 * capture, with discriminated-union precision, every render target the bot
 * produces so later plans (the dispatcher in Plan C, the back-button
 * computation in Plan D) can read session state and reconstruct the last
 * view exactly — including parameters (day, batchId, slug, scope, etc.) —
 * without having to re-derive them from loose fields.
 *
 * ## Design choices
 *
 *   - **Discriminated union, not an open string.** A typed union catches
 *     typos at compile time and lets TypeScript narrow on the `surface`
 *     discriminant inside handler code. The price is that every new render
 *     target must be added here first, which is exactly the bookkeeping we
 *     want.
 *
 *   - **Surface discriminant matches `BotCoreSession.surfaceContext`.** The
 *     `surface` field of every variant is one of the existing five values
 *     (`'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress'`). The
 *     null case is represented by `session.lastRenderedView` being
 *     `undefined`, not by a null variant. The invariant `setLastRenderedView`
 *     enforces is: after calling it, `session.surfaceContext` equals
 *     `view.surface`.
 *
 *   - **Cook view's surface is `'cooking'`, not `'plan'`.** This matches
 *     today's `surfaceContext` convention where `cv_*` sets
 *     `surfaceContext = 'cooking'` (`src/telegram/core.ts:730`). Proposal
 *     003's "Navigation state model" description groups cook view under
 *     "plan subview" conceptually, but the live code uses `'cooking'` as
 *     the surface value; we match the live code to avoid churning existing
 *     behavior. A future plan may unify these.
 *
 *   - **Shopping scope is minimal in v0.0.5: `next_cook` and `day`.** The
 *     proposal lists `full_week` and `recipe` scopes as well, but those
 *     require extending the shopping generator and are explicitly out of
 *     Plan B's scope (Plan E implements them). The union intentionally
 *     omits them; adding them later is a non-breaking extension.
 *
 *   - **Recipe library view does not carry `page`.** The current session
 *     already tracks `recipeListPage` as a top-level field, and the
 *     library renderer reads it. Duplicating it into `LastRenderedView`
 *     would create two sources of truth. The re-render helper (Plan C)
 *     will read `recipeListPage` separately when rehydrating the library
 *     view.
 *
 *   - **`setLastRenderedView` mutates in place and does NOT clear
 *     `lastRecipeSlug`.** The existing handlers that care about
 *     `lastRecipeSlug` (free-text fallback in `src/telegram/core.ts:260`)
 *     read it independently. Centralizing `lastRecipeSlug` management here
 *     would change the existing free-text fallback behavior, which is
 *     explicitly out of Plan B's scope. Callers that need to clear it
 *     continue to do so explicitly where they do today.
 */

/**
 * The discriminated union of every navigation render the bot produces.
 *
 * Every variant must be reachable from exactly one handler call site in
 * `src/telegram/core.ts`. Adding a new render target = adding a variant
 * here AND adding a `setLastRenderedView` call at the new handler.
 *
 * The shape follows two discriminants:
 *   - `surface`: one of the five surface-context values
 *   - a secondary discriminant (`view` for most surfaces, inlined into the
 *     variant) that identifies the specific subview
 *
 * Parameters carried by each variant are the minimum needed to rerender
 * the view later. Anything already stored elsewhere on `BotCoreSession`
 * (e.g., `recipeListPage`) is not duplicated.
 */
export type LastRenderedView =
  | { surface: 'plan'; view: 'next_action' }
  | { surface: 'plan'; view: 'week_overview' }
  | { surface: 'plan'; view: 'day_detail'; day: string }
  | { surface: 'cooking'; view: 'cook_view'; batchId: string; recipeSlug: string }
  | { surface: 'shopping'; view: 'next_cook' }
  | { surface: 'shopping'; view: 'day'; day: string }
  | { surface: 'recipes'; view: 'library' }
  | { surface: 'recipes'; view: 'recipe_detail'; slug: string }
  | { surface: 'progress'; view: 'log_prompt' }
  | { surface: 'progress'; view: 'weekly_report' };

/**
 * The subset of `BotCoreSession` fields that `setLastRenderedView` touches.
 * Declared structurally so the helper can be unit-tested against plain
 * objects and doesn't have to import `BotCoreSession` (which would create
 * a circular dependency with `core.ts`).
 */
export interface NavigationSessionSlice {
  surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  lastRenderedView?: LastRenderedView;
}

/**
 * Record that a navigation view was just rendered.
 *
 * Mutates the session in place:
 *   - `session.lastRenderedView = view`
 *   - `session.surfaceContext = view.surface`
 *
 * Does NOT touch:
 *   - `session.lastRecipeSlug` — legacy field managed by specific handlers;
 *     see the module doc-comment for why it stays independent.
 *   - any flow state (`planFlow`, `recipeFlow`, `progressFlow`) — navigation
 *     state is orthogonal to flow state and must never mutate flows.
 *
 * Call this **immediately before** `sink.reply(...)` at every render site.
 * Placing it right before the reply minimizes the window in which the
 * session is inconsistent with what the user will see.
 *
 * @param session - A session object conforming to `NavigationSessionSlice`.
 *                  The real caller is `BotCoreSession` from `core.ts`, but
 *                  unit tests pass plain objects.
 * @param view - The discriminated-union descriptor of the view just rendered.
 */
export function setLastRenderedView(
  session: NavigationSessionSlice,
  view: LastRenderedView,
): void {
  session.lastRenderedView = view;
  session.surfaceContext = view.surface;
}
