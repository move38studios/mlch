# mlch plan 4: calls that help live, words it learns, projects

From George's use of 0.3.x (2026-10-21). Approved as one sequence; built together for one beta.

## Status (2026-10-22): built, on beta

All of 0-6 built and checked: unit tests, and scenarios `card-edit`, `call` (real AI, a two-voice recording: no cards from speech during the call, the decisions card, two topics left to right, live cards in the topic of their moment, the last batch's decision after stopping, the tidy), `projects`, `project-suggest` (real AI), `share`.

## 0. Card headlines can be edited

Titles could not be edited anywhere (only the text). On the card (double-click) the headline edits with the text; in the side panel it edits in place. Cleared: the card has none.

## 1. Calls: two streams

Evidence: a 97-minute call made 341 cards from speech, 165 of them questions, most the AI's own ("If X, does Y?") drawn as the person's.

- **The record** (every batch, fast model): no cards from speech. The transcript card; decisions and to-dos go into one card that grows ("Decisions and to-dos", next to the transcript); when the conversation moves to a new topic, a new topic area (a group) starts, named after it. Topics run left to right in order, so the board reads like the call; the newest is "now". Instructions from [me] are handed off as before.
- **The live layer** (at most once a minute, the enrichment model, only while Live): looks at the last minute or two and adds only what someone glancing at the screen would find useful right now: a book, paper, person, company or place mentioned (its page), a question with an answer (the answer, with its source), an unfamiliar or central term (its definition), a claim worth checking (a source or the strongest counterpoint), an echo of the person's own material (a link). Several cards may come from one moment; nothing is a good answer. External first, the person's own material too. Never what is already on the board. Its cards go into the current topic.
- **The switch** is the existing Live / Quiet (top bar): Quiet means the record only, nothing added live. "Look that up" said aloud works either way.

## 2. Tidy the board when a call ends

Besides the notes card: the call's main points as cards (what was said, in its words), placed in their topics with the live cards; open questions people actually asked, together; repeats merged (the AI's own cards only), related cards connected across topics.

## 3. Words mlch learns

A list of names and terms (`<library>/words.json`), each with how it was misheard when known, for all work or for one project. Learned, never required:
- the AI's `remember_word` when the person corrects a name or term ("it's Fco", "they are called DCBL") or answers a question about one;
- the person's edits of speech: a word replaced in a card made from speech or in a call transcript;
- added or removed by hand in Settings.
Used: Groq's prompt (with recent speech); known mishearings are replaced in what is transcribed (any transcriber); the record and live prompts get the list.

## 4. Projects

A project is a named set of mulches (`<library>/projects.json`: projects and which mulch is in which). Home lists projects with their mulches inside, then loose mulches. New project on Home; a mulch moves into one by dragging it onto the project, or from the menu by its title in the mulch. Renaming; deleting a project leaves its mulches loose.

## 5. Project context

Instructions, enrichment and the live layer get a `<project>` block: its name, the other mulches in it, its words. Related material from the project's mulches comes first (`relatedElsewhere`).

## 6. Calls into projects

New in a project starts the mulch inside it (also for calls started from it). A mulch not in a project, a few minutes into a call (or once it has enough on it), gets a suggestion when the library index finds it close to one project: "Looks like <project>" with Move; dismissed, it is not asked again.

## Later

- Projected-screen mode: the view follows "now", older live cards step aside, bigger text.
- Parakeet steering by the word list (FluidAudio): check whether it can.

## Wording placeholders (George to replace)

"Decisions and to-dos", "Looks like …", "Move", "New project", "Words", "Not in a project".
