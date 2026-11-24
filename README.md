# news-reader

A personal news reader for Android and iOS, built with React Native and Expo (SDK 58, TypeScript).

- Leads with one or more primary sources (the Guardian by default).
- Never shows a story twice: once a card has been on screen it is gone, unless saved for later.
  Or, with **Latest first** in Settings, the newest 100 stories in time order, which stay put.
- Every card shows its **match**: how well it suits you compared with the other stories on offer.
  Filtered (the default), For you is sorted by match and leaves out stories below a threshold set in
  Settings; **Unfiltered** (a switch behind the Feed tab) shows everything in time or news order.
- **Pulse**: the words in the latest headlines on one page. Size (and nearness to the middle) is how
  much coverage a word gets, hue is the kind of story, strength of colour is how fresh it is, and a
  triangle marks one that is rising. Headlines per hour underneath. Long-press a word to hide it
  (UK and USA are hidden to start with).
- Learns what gets read and ranks the feed accordingly.
- Pairs primary stories with a second source from a different perspective, with a one-line note on how its angle differs.
- A Right press tab lists stories the right-leaning press is running that the primary sources have not covered.
- Follow a story: new coverage from any source is gathered under it, with a note on what changed.
- Full coverage: every outlet's piece on a story side by side, and on request where they agree and differ.
- A catch-up briefing of the biggest stories after a long time away.
- Mute a topic for a while, or watch one so it always surfaces.
- Shows what it has learned, preference by preference, and lets you correct it.
- Every source, the Guardian included, is configurable data, not code.
- **Modes**: separate feeds, each with its own sources, display and learning, switched from a bar
  above the feed. **News** is everything above. **AI** follows AI from a software engineering and CTO
  point of view: each story once, from blogs, vendor changelogs, Hacker News and split-up digests,
  with a rewritten headline, a one-line summary and why it matters to you; "In other news..." keeps
  significant stories your interests would filter out. It learns from what you read and rate, and
  keeps an interest profile you can read and edit.

Runs entirely on the phone. The only network calls are to the news sources and to OpenRouter.

## Documents

| | |
| --- | --- |
| [docs/spec.md](docs/spec.md) | The build spec and acceptance criteria (snapshot of the live [News app spec](https://claude.ai/artifact/WUZ58V9cNht5iXyRuJCjZw)) |
| [docs/News Reader PRD Modes and the AI mode.md](<docs/News Reader PRD Modes and the AI mode.md>) | The PRD for modes and the AI mode |
| [docs/decisions.md](docs/decisions.md) | Every decision taken during the build, what was and was not verified, and what is left for you |
| [docs/deploy.md](docs/deploy.md) | EAS build, submit and update; one-time account setup |
| [docs/testing.md](docs/testing.md) | Jest tests, live checks and the Maestro end-to-end flows |

## Quick start

```
npm install
npm test                 # pipeline, matching, ranking and seen-rule tests
npm run typecheck
npx expo run:android     # development build on an emulator or phone (needs Android Studio's SDK)
npx expo run:ios         # on the Mac
```

On first launch the app asks for an OpenRouter key and a Guardian Open Platform key, tests both,
and then fills the feed.

## Layout

```
src/app/         screens (Expo Router): feed, reader, full coverage, followed story, read later, history, setup, settings, debug
src/core/        feed and seen rule, ranking and learning, stories, coverage, topics, briefing, sources, settings (no React, no Expo)
src/adapters/    guardian_content_api, rss, google_news_search
src/pipeline/    the refresh pipeline: fetch, embed, cluster, second sources, score, digest, followed stories, briefing, prefetch
src/reader/      article extraction (Readability + linkedom), sanitiser, reader page
src/llm/         OpenRouter client: embeddings, JSON chat, cost recording, budget cap
src/db/          SQLite schema and migrations behind a small interface
src/platform/    the Expo side: SQLite, secure storage, files, background task, in-app browser
src/ui/          cards, list rows, overlays, theme
test/            Jest tests and the fake internet they run against
tools/           mock server for end-to-end tests, icon generator, Windows build helper
.maestro/        end-to-end flows
```

Everything under `src/core`, `src/adapters`, `src/pipeline`, `src/reader`, `src/llm` and `src/db`
is plain TypeScript with its dependencies passed in, which is why the same code runs in the app,
in a background task and in Jest.

## Status

Built and tested on an Android emulator against live feeds, the real OpenRouter API and a mock
server. Not yet done, because they need your accounts or hardware: store builds through EAS, the
iOS build, and a run with a real Guardian key. See [docs/decisions.md](docs/decisions.md).
