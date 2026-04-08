# Plan 022: /feedback command

**Status:** Active
**Date:** 2026-04-08
**Affects:** `src/telegram/core.ts`, `src/telegram/bot.ts`, `feedback.md`, `feedback-assets/`

## Problem

When using Flexie day-to-day, product observations need to be captured in the moment. There's no in-product way to log them — they get lost before triage. A `/feedback` command writes them directly to a markdown file in the repo, optionally capturing the bot response being reacted to and a screenshot.

## Input modes

**Mode 1 — inline text** (with optional reply context):
```
/feedback the shopping list needs section grouping
```
→ saved immediately. If the command is a reply to a bot message, that message is also captured.

**Mode 2 — two-step** (required for voice and screenshots):
1. User sends `/feedback` alone (optionally as a reply to capture context)
2. Bot: "Send your feedback — type it, record a voice message, or attach a screenshot."
3. User sends one of:
   - Free text → saved
   - Voice message → transcribed via existing Whisper path → saved
   - Photo (with optional caption) → downloaded, saved to `feedback-assets/`, path recorded

Voice and photos are inherently two-step because Telegram can't combine a slash command with audio or photo attachments in a single message.

## Storage

`feedback.md` at repo root. Created on first write with header. Screenshots go in `feedback-assets/` at repo root.

Each entry is separated by `---`. Reply context and photo are on their own lines below the feedback text. Reply context is truncated to 120 chars (first line only) to prevent long bot messages from dominating the file.

```markdown
# Product Feedback

---

**2026-04-08 14:32** — Shopping list needs section grouping

---

**2026-04-08 15:01** — Error state after plan save

re: "Something went wrong. Please try again."

---

**2026-04-08 15:45** — Layout broken on small screens

re: "Here is your week plan. Tap a recipe to cook."
📎 [screenshot](feedback-assets/2026-04-08-15-45-00.jpg)

---

**2026-04-08 16:10** — *(no caption)*

📎 [screenshot](feedback-assets/2026-04-08-16-10-00.jpg)
```

## Data structures

### feedbackFlow session state (core.ts ~line 201)

```typescript
feedbackFlow: {
  phase: 'awaiting_input';
  /** Text of the bot message the user replied to when sending /feedback */
  replyContext?: string;
} | null;
```

### HarnessUpdate extensions (core.ts ~line 152)

```typescript
// Extend command type:
| { type: 'command'; command: string; args?: string; replyContext?: string }

// New photo type:
| { type: 'photo'; caption?: string; localPath: string; replyContext?: string }
```

`replyContext` is extracted in bot.ts from `ctx.message.reply_to_message?.text ?? ctx.message.reply_to_message?.caption`.

## Implementation steps

### 1. Extend HarnessUpdate (core.ts ~line 152)

Add `args?: string; replyContext?: string` to command variant. Add new `photo` variant.

### 2. Add feedbackFlow to BotCoreSession (core.ts ~line 190)

```typescript
/** Active when user sent /feedback without inline text — awaiting next message. */
feedbackFlow: { phase: 'awaiting_input'; replyContext?: string } | null;
```

Initialize to `null` in session object (~line 240).

### 3. Register command in bot.ts (~line 166)

```typescript
bot.command('feedback', async (ctx) => {
  const replyContext =
    ctx.message.reply_to_message?.text ??
    ctx.message.reply_to_message?.caption ??
    undefined;
  await runDispatch(
    { type: 'command', command: 'feedback', args: ctx.match?.trim() || undefined, replyContext },
    ctx, 'feedback'
  );
});
```

### 4. Add photo handler in bot.ts (after voice handler)

```typescript
bot.on('message:photo', async (ctx) => {
  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // highest res
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const localPath = `feedback-assets/${timestamp}.jpg`;
    await fs.mkdir('feedback-assets', { recursive: true });
    await fs.writeFile(localPath, buffer);
    const replyContext =
      ctx.message.reply_to_message?.text ??
      ctx.message.reply_to_message?.caption ??
      undefined;
    await runDispatch({ type: 'photo', caption: ctx.message.caption, localPath, replyContext }, ctx, 'photo');
  } catch (err) {
    log.error('BOT', 'Photo message error', err);
  }
});
```

Note: `fs` here is `node:fs/promises` — already imported for the feedback helper.

### 5. Update handleCommand (core.ts ~line 327)

Update signature to `handleCommand(command: string, args?: string, replyContext?: string, sink)` (or pass full update).

Handle `'feedback'`:
```typescript
if (command === 'feedback') {
  if (args) {
    await saveFeedback({ text: args, replyContext });
    await sink.reply('Feedback saved.');
  } else {
    session.feedbackFlow = { phase: 'awaiting_input', replyContext };
    await sink.reply('Send your feedback — type it, record a voice message, or attach a screenshot.');
  }
  return;
}
```

### 6. Clear feedbackFlow in /cancel (core.ts ~line 340)

Add `session.feedbackFlow = null;`.

### 7. Intercept in handleTextInput() (core.ts ~line 1236) — before progressFlow check

```typescript
if (session.feedbackFlow) {
  const { replyContext } = session.feedbackFlow;
  session.feedbackFlow = null;
  await saveFeedback({ text, replyContext });
  await sink.reply('Feedback saved.');
  return;
}
```

Catches both free text and voice (voice is pre-transcribed through the same dispatch path).

### 8. Handle photo update type in dispatch() (core.ts ~line 300)

```typescript
case 'photo':
  await handlePhoto(update, sink);
  return;
```

```typescript
async function handlePhoto(update: Extract<HarnessUpdate, { type: 'photo' }>, sink: OutputSink): Promise<void> {
  if (session.feedbackFlow) {
    const { replyContext } = session.feedbackFlow;
    session.feedbackFlow = null;
    await saveFeedback({ text: update.caption, replyContext, photoPath: update.localPath });
    await sink.reply('Feedback saved.');
  }
  // Outside feedbackFlow: silently ignore (no photo handling elsewhere in the bot)
}
```

### 9. saveFeedback() helper

```typescript
interface FeedbackEntry {
  text?: string;
  replyContext?: string;
  photoPath?: string;
}

async function saveFeedback(entry: FeedbackEntry): Promise<void> {
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const textLine = entry.text
    ? `**${timestamp}** — ${entry.text}`
    : `**${timestamp}** — *(no caption)*`;
  const replyLine = entry.replyContext
    ? `re: "${entry.replyContext.split('\n')[0].slice(0, 120)}"`
    : '';
  const photoLine = entry.photoPath
    ? `📎 [screenshot](${entry.photoPath})`
    : '';
  const parts = [textLine, replyLine, photoLine].filter(Boolean).join('\n');
  const block = `\n---\n\n${parts}\n`;

  const filePath = new URL('../../../feedback.md', import.meta.url).pathname;
  const exists = await fsPromises.access(filePath).then(() => true).catch(() => false);
  if (!exists) {
    await fsPromises.writeFile(filePath, `# Product Feedback\n${block}`);
  } else {
    await fsPromises.appendFile(filePath, block);
  }
}
```

## Progress

- [ ] Extend HarnessUpdate (command args/replyContext + photo type)
- [ ] Add feedbackFlow to BotCoreSession + initialize
- [ ] Register /feedback command in bot.ts with replyContext
- [ ] Add photo handler in bot.ts
- [ ] Update handleCommand to handle 'feedback'
- [ ] Clear feedbackFlow in /cancel
- [ ] Intercept feedbackFlow in handleTextInput
- [ ] handlePhoto() in dispatch
- [ ] saveFeedback() helper
- [ ] npm test — confirm no regressions

## Decision log

- Decision: No new test scenario for initial implementation.
  Rationale: No AI calls, no branching exercised by existing flows. If a bug surfaces, author one then.
  Date: 2026-04-08

- Decision: feedback.md at repo root, feedback-assets/ at repo root.
  Rationale: Operational output, not documentation. Easy to find and git-ignore if needed later.
  Date: 2026-04-08

- Decision: Always download photos in bot.ts; let core decide what to do.
  Rationale: Mirrors the voice transcription pattern (adapter does I/O, core does logic). Avoids coupling adapter to session state.
  Date: 2026-04-08

- Decision: Truncate replyContext to 120 chars in the saved entry.
  Rationale: Bot messages can be long; the first ~120 chars is enough to identify which response is being referenced.
  Date: 2026-04-08

## Validation

1. `npm test` — no regressions from session shape + HarnessUpdate changes.
2. `npm run dev` — `/feedback quick note` → entry in feedback.md.
3. `npm run dev` — reply to a bot message with `/feedback note` → entry includes re: context.
4. `npm run dev` — `/feedback` alone → prompt → voice message → transcription saved.
5. `npm run dev` — `/feedback` → prompt → send a screenshot → photo saved to feedback-assets/, path in feedback.md.
6. `npm run dev` — reply to a bot message with `/feedback` → prompt → send screenshot → both context and photo captured.
7. `npm run dev` — `/feedback` → `/cancel` → no orphaned state.
