import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '017-free-text-fallback',
  description: 'Free-text fallback: lifecycle-aware responses for no-plan, shopping-with-no-plan, and recipe-context states',
  clock: '2026-04-06T10:00:00Z',   // Monday — start of a fresh week
  recipeSet: 'six-balanced',
  initialState: {},                 // fresh user — no plan
  events: [
    command('start'),

    // Branch 1: no plan — should get "I can help you plan your week..." copy
    text('hello there'),

    // Branch 2: tap Shopping List with no plan — jargon-free message
    text('🛒 Shopping List'),

    // Branch 3: view a recipe, then type random text — recipe-context fallback
    text('📖 My Recipes'),           // opens recipe list
    click('rv_chicken-black-bean-avocado-rice-bowl'),  // view a recipe → sets surfaceContext='recipes' + lastRecipeSlug
    text('xyz random text 123'),      // free text while viewing recipe → recipe-context branch
  ],
});
