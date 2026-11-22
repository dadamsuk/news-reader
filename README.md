# news-reader

A personal news reader for Android and iOS, built with React Native and Expo (SDK 58, TypeScript).

- Leads with one or more primary sources (the Guardian by default).
- Never shows a story twice: once a card has been on screen it is gone, unless saved for later.
- Learns what gets read and ranks the feed accordingly.
- Pairs primary stories with a second source from a different perspective, with a one-line note on how its angle differs.
- A Right press tab lists stories the right-leaning press is running that the primary sources have not covered.
- Every source, the Guardian included, is configurable data, not code.

Runs entirely on the phone. The only network calls are to the news sources and to OpenRouter.

## Documents

| | |
| --- | --- |
| [docs/spec.md](docs/spec.md) | The build spec and acceptance criteria (snapshot of the live [News app spec](https://claude.ai/artifact/WUZ58V9cNht5iXyRuJCjZw)) |
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
src/app/         screens (Expo Router): feed, reader, read later, history, setup, settings, debug
src/core/        feed and seen rule, ranking and learning, sources, settings (no React, no Expo)
src/adapters/    guardian_content_api, rss, google_news_search
src/pipeline/    the refresh pipeline: fetch, embed, cluster, second sources, digest, score, prefetch
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
