/**
 * Unit tests for the Telegram MarkdownV2 escape utility.
 *
 * Verifies that all reserved characters are properly escaped for safe
 * interpolation into MarkdownV2 messages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeMarkdownV2, escapeRecipeBody } from '../../src/utils/telegram-markdown.js';

test('escapeMarkdownV2: backslash is escaped first', () => {
  assert.equal(escapeMarkdownV2('\\'), '\\\\');
});

test('escapeMarkdownV2: pipe', () => {
  assert.equal(escapeMarkdownV2('|'), '\\|');
});

test('escapeMarkdownV2: period', () => {
  assert.equal(escapeMarkdownV2('.'), '\\.');
});

test('escapeMarkdownV2: exclamation', () => {
  assert.equal(escapeMarkdownV2('!'), '\\!');
});

test('escapeMarkdownV2: parentheses', () => {
  assert.equal(escapeMarkdownV2('(foo)'), '\\(foo\\)');
});

test('escapeMarkdownV2: clean string passes through unchanged', () => {
  assert.equal(escapeMarkdownV2('Hello world'), 'Hello world');
});

test('escapeMarkdownV2: mixed dynamic content — recipe name', () => {
  assert.equal(
    escapeMarkdownV2('Thai Basil (Quick)'),
    'Thai Basil \\(Quick\\)',
  );
});

test('escapeMarkdownV2: backslash before other chars avoids double-escaping', () => {
  // A string with both \ and . — \ must be escaped first to \\, then . to \.
  // If order were wrong, the \. would become \\\. (double-escaped).
  assert.equal(escapeMarkdownV2('\\.'), '\\\\\\.');
});

// ─── escapeRecipeBody ─────────────────────────────────────────────────────────

test('escapeRecipeBody: converts **bold** to MarkdownV2 *bold*', () => {
  assert.equal(escapeRecipeBody('Cook for **5 min**.'), 'Cook for *5 min*\\.');
});

test('escapeRecipeBody: escapes reserved chars outside bold markers', () => {
  assert.equal(escapeRecipeBody('Step 1. Heat oil.'), 'Step 1\\. Heat oil\\.');
});

test('escapeRecipeBody: multiple bold segments', () => {
  assert.equal(
    escapeRecipeBody('Heat **1 min**. Simmer **5-6 min**.'),
    'Heat *1 min*\\. Simmer *5\\-6 min*\\.',
  );
});

test('escapeRecipeBody: no bold markers — plain escape', () => {
  assert.equal(escapeRecipeBody('Just cook it.'), 'Just cook it\\.');
});
