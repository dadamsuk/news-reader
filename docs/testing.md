# Testing

## Unit and pipeline tests (Jest)

```
npm test            # 78 tests, about 10 seconds
npm run typecheck
npm run lint
```

The tests in `test/` run the real code against a real SQLite database (better-sqlite3 in memory)
and a fake internet (`test/helpers/world.ts`): RSS feeds, a Guardian-style API, article pages and
an OpenRouter-compatible endpoint with deterministic embeddings and scripted model replies. They
cover every acceptance item the spec marks "(test)":

| Spec item | Test file |
| --- | --- |
| Every field of every source can be edited; applies at the next refresh | `sources.test.ts` |
| Two primary sources give one merged feed; BBC-only feed | `sources.test.ts` |
| Sources export and import round-trip without keys | `sources.test.ts` |
| Broken endpoint shows red; other sources still refresh | `sources.test.ts` |
| No seen article after 10 minutes in the background or pull-to-refresh | `seen.test.ts` |
| Seen as a second source or in Right press never appears as a feed card | `seen.test.ts` |
| Cluster rule: perspective articles suppressed 72 hours, primary pieces still appear | `seen.test.ts` |
| Extraction failure falls back to the adapter body and thumbnail | `reader.test.ts` |
| Changing a lean changes Right press at the next refresh | `pipeline.test.ts` |
| Right press: 2+ right-leaning outlets, no primary coverage, summary, links, count | `pipeline.test.ts` |
| 3 of every 20 feed slots are exploration | `ranking.test.ts` |
| Budget cap stops model calls, feed still loads | `pipeline.test.ts` |
| No API key in logs, exports or the database | `sources.test.ts` |

### Live checks (optional, cost a cent or two)

With `OPENROUTER_KEY` in `.env`:

```
LIVE=1 LIVE_DB=/tmp/news-live.db npx jest test/live.test.ts          # full refresh against the real feeds and OpenRouter
LIVE=1 LIVE_DB=/tmp/news-live.db npx jest test/extract-live.test.ts  # reader extraction on current articles per outlet
node scripts/sim-bands.js /tmp/news-live.db                          # headline pairs by similarity band, for threshold tuning
```

There is no Guardian API key in this repo, so the live run stands the Guardian's public RSS feed in
for the Content API. The Content API adapter itself is tested against the mock.

## End-to-end flows (Maestro)

The flows in `.maestro/` drive the real app against `tools/mock-server.js`, so results are
deterministic. They need the E2E build variant.

```
# 1. build and install the E2E variant (Android shown; on the Mac use the iOS simulator the same way)
E2E=1 npx expo prebuild --platform android --clean
cd android && E2E=1 ./gradlew assembleRelease -PreactNativeArchitectures=x86_64 && cd ..
adb install -r android/app/build/outputs/apk/release/app-release.apk

# 2. start the mock server, and let the emulator reach it
node tools/mock-server.js            # listens on :8787; the Android emulator sees it as 10.0.2.2:8787

# 3. run the flows
maestro test .maestro
```

On the iOS simulator the mock is `localhost:8787`: change the host in the `openLink` lines of
`.maestro/common/setup.yaml` and `01-setup-feed.yaml`, or pass it as a Maestro env variable.

| Flow | What it proves |
| --- | --- |
| `01-setup-feed` | Keys are asked for and validated by a test call; the first refresh fills the feed; second-source strips with angle notes; Right press items with summary, outlets and count; Debug shows the run |
| `02-seen-rule` | Half-on-screen is seen and a peek is not (checked against card geometry by the app's own audit); seen cards stay for the session; History and its search; nothing seen returns after 10 minutes in the background or pull-to-refresh |
| `03-reader-later` | Reader shows headline, byline, text and pictures; save from the reader and by swipe, with undo; reading to the end marks a saved item done and moves it to History; swipe left with undo; long-press menu; fallback to the adapter body |
| `04-bbc-primary` | BBC News as primary with the Guardian disabled gives a BBC-only feed, with second sources and Right press still working (the spec's e2e item) |
| `05-budget-health` | A $0.01 budget stops model calls and shows the banner while the feed still loads; a broken feed turns red, Test shows the error, other sources still refresh |

### The seen-rule audit

Maestro cannot measure how much of a card is on screen, so in E2E builds the feed keeps an
independent record: from each card's measured height and the scroll offset it works out the largest
fraction of the card that was ever visible. Settings, Debug then shows "Seen rule audit: OK" only
if every card that was clearly more than half visible is recorded as seen and no card that stayed
clearly under half is. The flow scrolls slowly, flings and scrolls back before checking it.

### Windows note

React Native's native build fails on Windows with `ninja: error: mkdir(...): No such file or
directory` once object paths pass 260 characters, wherever the repo lives: the Ninja 1.10 that
ships in the Android SDK's CMake folder ignores Windows long-path support. Drive aliases, junctions
and even a four-character project path do not get under the limit. The fix that works:

1. Long paths enabled in Windows (`LongPathsEnabled = 1` under
   `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`; it already was on this machine).
2. Replace `%LOCALAPPDATA%\Android\Sdk\cmake\3.22.1\bin\ninja.exe` with Ninja 1.12 or later from
   github.com/ninja-build/ninja/releases. This was done during the build; the original is beside
   it as `ninja.exe.orig-1.10.2`.

None of this applies to EAS cloud builds or to building on the Mac.
