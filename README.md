# news-reader

A personal news reader for Android and iOS, built with React Native and Expo.

- Leads with one or more primary sources (the Guardian by default).
- Never shows a story twice: once a card has been on screen it is gone, unless saved for later.
- Learns what gets read and ranks the feed accordingly.
- Pairs primary stories with a second source from a different perspective, with a one-line note on how its angle differs.
- A Right press tab lists stories the right-leaning press is running that the primary sources have not covered.
- Every source, the Guardian included, is configurable data, not code.

Runs entirely on the phone. The only network calls are to the news sources and to OpenRouter.

## Spec

The full build spec, including acceptance criteria, is in [docs/spec.md](docs/spec.md). The live, editable version is the [News app spec](https://claude.ai/artifact/WUZ58V9cNht5iXyRuJCjZw) doc; `docs/spec.md` is a snapshot of it.

## Status

Spec complete. No code yet.
