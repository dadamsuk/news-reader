# Handoff: modes and the AI mode (24 November 2026)

Where the build of [the modes PRD](News%20Reader%20PRD%20Modes%20and%20the%20AI%20mode.md) stands,
and what to do next. Decisions and their reasons are in [decisions.md](decisions.md) section 15.

## Done

All seven steps of the brief are built and committed on `main`:

1. **Modes in the data.** Migration 7 adds the `mode` table, `mode_id` columns and a per-mode unique
   canonical URL, and moves News's settings into the News mode (copied, nothing deleted). Every News
   query filters by mode.
2. **Navigation.** A mode bar above the feed tabs shows unseen counts, and the app opens on the
   last-used mode. Read later and History are per mode. Settings, Sources and Learning have a mode
   picker, and Reset learning works per mode.
3. **Sources.** There are new source fields and two new adapters, `hn_api` and `html_list`. Digest
   issues are split into one item per story. The AI mode's 14 default sources were checked live;
   the URLs used and the substitutes are in decisions.md §15.
4. **AI pipeline** (`src/pipeline/sections.ts`). It covers prefilter, clustering at 0.75,
   enrichment batched five stories to a call with the style rules, significance, relevance,
   sections, expiry, late-arriving coverage and the budget cap.
5. **Sections UI** (`src/ui/SectionsFeed.tsx`). It has both sections, the cards, the existing
   gestures and menu, Show more, and the seen rule.
6. **Learning** (`src/core/learning.ts`, `src/core/profile.ts`). It covers signal weights, EMA tag
   and source weights, graduation, the versioned profile with pinned lines and its rewrite, cold
   start, and the Learning screen (`src/app/settings/profile.tsx`).
7. **Docs.** spec.md, testing.md, the README and decisions.md (new §15) are updated.

## Verified

- `npx tsc --noEmit` and `npx expo lint` are clean.
- `npx jest`: 195 tests pass and 3 skip (the LIVE tests). Every existing test passes unchanged
  except the privacy assertion the PRD replaces.
- `LIVE=1 npx jest test/live-ai.test.ts`: a first AI-mode refresh against the real sources and
  OpenRouter. All 14 sources were fetched, giving 234 stories; 229 were enriched in 47 calls in
  about 80 seconds, costing **$0.24**.

> **Update, later on 24 November:** steps 2 to 4 below are done. The `07-modes` failure was a bug in
> the AI feed's pull-to-refresh (fixed), and all seven Maestro flows now pass. See "On the emulator"
> in decisions.md §15. Still open: step 5 (live data on the emulator) and step 7.

## Not verified yet: the emulator and Maestro

- **E2E build.** An E2E release APK was built and installed on the `newsreader` emulator.
- **Flow `07-modes`.** It passed setup, the mode bar and counts, and switching to AI. It then
  failed: after pull-to-refresh in the AI mode, "Coding agent now generally available" never
  appeared. The cause has not been looked into yet; the debug output is in
  `~/.maestro/tests/2026-11-24_200125` on the old machine.
- **Flows 01 to 06** have not been run against this build.
- **The AI mode with live data on the emulator** has not been run.
- **decisions.md §15** points to an "On the emulator" subsection that is not written yet; add it
  once the flows pass.

## Next steps

1. **Set up the machine.** Use [testing.md](testing.md), plus these notes from this session:
   - Gradle needs `ANDROID_HOME` set (for example `export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"`).
   - On a fresh Google Play emulator image, a "Digital Wellbeing isn't responding" dialog can cover
     the app at first launch and fail flows. Turn that app off on the emulator with
     `adb shell pm disable-user --user 0 com.google.android.apps.wellbeing`.
   - Maestro 2.12.1 is at `C:\Users\da\tools\maestro` on the old machine. The `newsreader` AVD there
     was recreated by hand (Pixel 7 profile, android-36.1 Google Play x86_64 image).
2. **Build and start everything.** Run
   `E2E=1 npx expo prebuild --platform android --clean`, then
   `cd android && E2E=1 ./gradlew assembleRelease -PreactNativeArchitectures=x86_64`, then
   `adb install -r android/app/build/outputs/apk/release/app-release.apk`. Start the mock server
   with `node tools/mock-server.js` (port 8787).
3. **Debug `07-modes` at the AI pull-to-refresh.** Things to check first:
   - Did the refresh run the AI steps? See Settings, Debug, last run: the steps named "AI: …".
   - Did `aimock` import the sources? See Settings, Sources, AI. They should be Vendor blog, Lab
     news, Engineering blog, The Digest and Hacker News, all enabled.
   - Is the mock reachable at `10.0.2.2:8787`? `curl localhost:8787/e2e/stats` shows whether the
     enrich count goes up.
   - Timing. `SectionsFeed.onPull` awaits the whole refresh, then starts a new session and reloads.
     Check the list reloads after it, and that `refreshing` turning false at News's Score step does
     not leave the empty state showing.
   - A Node run of the same pipeline against the mock gave the expected feed: 20 main cards and 3 In
     other news cards. So the cause is more likely on the app side (refresh trigger, reload, mode
     state) than in the fixtures.
4. **Run the rest.** Run `06-ai-feed`, then the full `maestro test .maestro` (01 to 05 must still
   pass; the `mock` action switches the AI sources off, so they should see News as before).
5. **Live data on the emulator.** Run setup with the real keys, open the AI mode and pull to
   refresh. Check the cards, In other news and the cost in Settings, AI and budget.
6. **Write up the results.** Add "On the emulator" to decisions.md §15, update the test counts if
   they changed, then commit.
7. **Decide the items marked "check" in decisions.md §15.** In particular:
   - the In other news significance threshold (0.6 left it almost empty on real data; about 0.45
     would have filled it);
   - the cold-start relevance threshold of 0.4;
   - five stories per enrichment request;
   - the graduation step of 0.25.

## Where things are

| What | Where |
| --- | --- |
| Mode records, AI defaults, starter profile | `src/core/modes.ts` |
| Sections feed (loading, placement, "why") | `src/core/sections.ts` |
| Learning (layer 1) / profile (layer 2) | `src/core/learning.ts`, `src/core/profile.ts` |
| AI pipeline | `src/pipeline/sections.ts` (wired in `src/pipeline/refresh.ts` after step 8) |
| New adapters and digest splitting | `src/adapters/sections.ts` |
| Migration 7 | `src/db/db.ts` |
| UI | `src/ui/ModeBar.tsx`, `src/ui/SectionsFeed.tsx`, `src/app/settings/profile.tsx`, `src/app/(tabs)/index.tsx` (`FeedTab`) |
| Tests | `test/mode-data`, `mode-nav`, `ai-sources`, `ai-pipeline`, `ai-display-learning`, `live-ai`; fixtures in `test/helpers/ai.ts` |
| E2E | `.maestro/06-ai-feed.yaml`, `.maestro/07-modes.yaml`; `newsreader://e2e?action=aimock`; AI fixtures in `tools/mock-server.js` |
