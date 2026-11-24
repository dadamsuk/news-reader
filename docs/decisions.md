# Build decisions and verification notes

Written during the unattended build of 22 November 2026, for review afterwards. Each entry says
what was decided and why. Where the build departs from the letter of the spec, it says so.

The spec is [spec.md](spec.md). Section references below are to its headings.

## 1. What to check first

These are the choices most worth a second opinion. For modes and the AI mode (24 November 2026),
see the items marked **check** in section 15.

| # | Decision | Why | To change it |
| --- | --- | --- | --- |
| 1 | **Similarity thresholds are lower than the spec's 0.82 and 0.70.** Defaults: same story 0.75, second-source candidate 0.60, Right press "already covered" 0.72, Right press "ask the model" from 0.55, second source without the model (budget spent) 0.80. | Measured on a live refresh (494 articles, 10 outlets). With `text-embedding-3-small`, headline pairs at 0.75 and above were all the same event, 0.70 to 0.75 mostly, 0.60 to 0.70 mixed, below 0.60 only the same topic. At the spec's 0.82 only 23 of 494 articles joined a cluster and most same-event pairs were missed. The spec called both numbers starting points. | Settings, Ranking weights and thresholds. `node scripts/sim-bands.js <db>` prints real pairs per band. |
| 2 | **Embeddings are stored at 512 dimensions**, not the model's 1,536. | A third of the storage (about 29 MB instead of 86 MB for 14 days) and a third of the matching work on the phone, with almost identical similarity scores. `text-embedding-3` models are built to be shortened this way. | Settings, Ranking, Embedding dimensions (0 = native size). |
| 3 | **The seen rule uses "at least half of the card is visible"** (`itemVisiblePercentThreshold: 50`), where the spec's stack section names `viewAreaCoveragePercentThreshold: 50`. | The named option means "the card covers half the screen", which is not the rule the spec describes or tests. | `src/ui/seen.ts` |
| 4 | **Everything above the furthest half-visible card also counts as seen.** | A fast fling can skip a card's viewability callback although the card crossed the screen. The spec says "for any length of time". | `src/ui/seen.ts` |
| 5 | **The Spectator is a Google News search source** (`site:spectator.com`), not RSS, and is marked paywalled. | It moved to spectator.com and publishes no RSS feed (every candidate URL returned 404 on 22 Nov 2026). | Settings, Sources. |
| 6 | **Setup has a "Skip for now" button.** | Without it a missing Guardian key would lock you out of the app. Skipped sources show a red dot. | `src/app/setup.tsx` |
| 7 | **App ID `net.dsc.newsreader`** for both platforms; app name "News". | Needed a value; taken from your email domain. It cannot be changed after the first store upload. | `app.config.ts` |
| 8 | **Unseen articles older than 4 days leave the feed.** | Their freshness term is under 0.001, and loading two weeks of unseen articles on every feed refresh would slow the phone. They stay in the database (14-day retention) and still match as second sources. | `FEED_WINDOW_MS` in `src/core/feed.ts` |
| 9 | **New articles join the feed only once a refresh has matched and ranked them**, not the moment their headlines arrive. | Found on the emulator: shown early, the top cards were on screen (so "seen") before second-source matching ran, and never got a strip. The cost is that the very first refresh shows "Fetching the news" for about 20 seconds instead of headlines after 2. Later launches are unaffected: the cached feed is on screen at once. | `ready_at` in `src/pipeline/refresh.ts` |
| 10 | **Pull-to-refresh keeps its spinner until the new stories are ready** (25 seconds at most), then starts the new session with them ranked from the top. | Ending the session at the start of the pull put the leftover older cards on screen first, and the fresh stories arrived underneath them. | `onPull` in `src/app/(tabs)/index.tsx` |
| 11 | **A change to a source's role or on/off switch shows in the feed straight away**; matching and Right press follow at the next refresh, as the spec says. | The feed is a query over stored articles by current role. Waiting for a refresh would mean the feed kept showing a source you had just switched off. | `loadFeed` in `src/core/feed.ts` |
| 12 | **Nothing was committed to git.** | You asked for a build, not commits. Everything is in the working tree on `main`. | `git add -A && git commit` |

## 2. What was verified, and how

| Area | Verified by | Result |
| --- | --- | --- |
| Pipeline, matching, ranking, seen rule, sources, budget, reader fallbacks | 78 Jest tests against real SQLite and a fake internet; typecheck and lint clean | Pass |
| Full refresh on real data | Live runs in Node and on the emulator: 10 real outlets, real OpenRouter embeddings and Claude Haiku 4.5 | Pass. About 500 articles, 37 model calls, $0.037 for a first refresh |
| Reader extraction | Live pages from the Guardian, BBC, Daily Mail, Express, Sun and GB News | Text, lead picture, inline pictures and captions recovered; see section 6 |
| The app itself | Android emulator (Pixel 7, Android 16), release build | See section 9 |
| End-to-end flows | Maestro on the Android emulator against the mock server | See section 9 |

### Not verified, and why

| Item | Why not | What to do |
| --- | --- | --- |
| **Guardian Content API with a real key** | No Guardian key was available (the old public `test` key now returns 401). The adapter is tested against a mock that mimics the API's documented shape. Live runs used the Guardian's public RSS feed as the primary source, and real Guardian pages for extraction. | Enter your key at setup. If the first refresh shows a red dot on the Guardian, the error text is in Settings, Sources. |
| **iOS** | The build machine is Windows; iOS needs a Mac. No iOS-specific code was written, but nothing was run on a simulator. | `npx expo run:ios`, then `maestro test .maestro` with the mock host set to `localhost:8787`. |
| **EAS build, submit and update; Play internal testing; TestFlight** | They need your Expo, Google and Apple accounts. `eas.json`, the app config and the GitHub workflow are written but have never run. | [deploy.md](deploy.md), one-time setup. |
| **Background refresh on a real phone** | An emulator does not reproduce real scheduling. The task is registered and its code path is the same `refresh()` the tests cover. | Settings, Debug lists every run with its trigger ("background"). |
| **Chrome Custom Tabs sign-in for paywalled sources** | Needs your subscriptions. | Tap a Telegraph or Economist strip on your phone. |
| **The spot-check acceptance items** ("at least half of the top 10 have a second source on a big political day", "no more than 1 wrong in 20 strips") | They need a few days of real use to judge. Early evidence is in section 5. | Use Debug, Recent match decisions. |

## 3. Platform and stack

- **Expo SDK 58, React Native 0.88, React 19.3, TypeScript 6** (the current SDK, as the spec asks). Routes live in `src/app/`, which is the current Expo Router convention.
- **No UI library and no state library.** Screens use React Native primitives and a 60-line store (`src/state/store.ts`). Fewer dependencies to break on the next SDK upgrade.
- **All logic outside `src/app`, `src/ui` and `src/platform` is plain TypeScript with dependencies passed in** (database, fetch, secure storage, clock, files). That is what lets one pipeline run in the app, in a background task and in Jest.
- **SQLite in tests is `better-sqlite3`**, on the phone `expo-sqlite`, both behind the same small interface (`src/db/db.ts`). Transactions are serialised over one connection and are never nested.
- **`linkedom` is imported from its main entry**, which Metro bundles without trouble; extraction was confirmed running under Hermes on the emulator.
- **`.npmrc` sets `legacy-peer-deps=true`.** `expo-router` pulls in `react-dom@19.3.1`, whose peer range rejects the SDK's pinned `react@19.3.0`; without the flag `npm install` fails.
- **`expo-dev-client` is installed** so the `development` EAS profile produces a development build, as the spec requires (no Expo Go). **`expo-font` is installed** because the icon set needs it as a direct dependency (`expo-doctor` now passes 20 of 20 checks).
- **Lint** is Expo's ESLint config (`npm run lint`), added during the build and clean. It includes the React Compiler rules, which is why a few components avoid effects that only copy props into state.
- **A config plugin in `app.config.ts` raises Gradle's memory.** The generated default (512 MB of metaspace) fails a release build of this many native modules.
- **EAS Update is off until `eas init` has run.** `app.config.ts` only sets the update URL when `EAS_PROJECT_ID` is present, so a local build never points at a project that does not exist.
- **Network requests use XMLHttpRequest, never `fetch` (`src/platform/fetch.ts`).** Found on a real phone (24 Nov 2026): background refresh never completed. On Android, React Native stops firing JavaScript timers while the app is in the background (`JavaTimerManager` pauses them unless a HeadlessJS task is running, and `expo-task-manager` does not start one). RN's `fetch` is the whatwg-fetch polyfill, which resolves every response inside `setTimeout(0)`, so the first request of a background run waited forever and Android ended the job (`dumpsys jobscheduler` showed two job timeouts in a day). The stuck run then held the refresh lock until the app was opened, timers resumed, and it finished in front of you, which is why the briefing appeared only after some minutes in the app. The XHR's `timeout` is enforced by OkHttp natively, so a stalled request still fails. **Rule: nothing a refresh awaits may depend on a timer.** The prefetch step's yield to the UI thread is passed in and is skipped unless the app is on screen.
- **A background run stops starting new steps after six minutes** (Android ends a job at about ten), so it is recorded as finished, not killed.
- **The catch-up briefing is written in the background** once the app has been away for the briefing gap, so it is on screen the moment the app opens. A later run rewrites it only if the set of stories changed; otherwise no model call is made.
- **Runtime version policy is `appVersion`.** A JavaScript-only update reaches any build with the same `version`; bump `version` when native code changes.

## 4. Sources

- **One source can have several feeds.** The endpoint field takes one URL per line (the spec's default table gives BBC, Telegraph and others two feeds each). A source with one failing feed and one working feed keeps the working items and shows red with the error.
- **Default feed URLs, all checked on 22 Nov 2026:** BBC (`/news/rss.xml`, `/news/politics/rss.xml`), Economist (`/latest/rss.xml`), Telegraph (`/rss.xml`, `/news/rss.xml`), Times (Google News `site:thetimes.com`), Spectator (Google News `site:spectator.com`), Daily Mail (`/news/index.rss`, `/news/uk-politics/index.rss`), Express (`/posts/rss/1/news`, `/posts/rss/139/politics`), Sun (`/news/feed/`, `/news/politics/feed/`), GB News (`/feeds/news.rss`, `/feeds/politics.rss`).
- **Default section exclusions.** Right-leaning outlets (the Telegraph included, not only the tabloids) exclude sport, showbiz, celebrity, TV, travel and similar, so two outlets covering the same football match do not produce a Right press item. The Guardian excludes crosswords and site-housekeeping sections. BBC excludes sport and programme pages. All editable per source.
- **Section filters match the section name, any category or tag, or a URL path part**, case-insensitive. Exclude wins over include.
- **Google News items keep Google's redirect link.** Decoding it to the publisher URL now needs an undocumented call, and these sources open in the in-app browser, which follows the redirect. Google's " - Outlet" headline suffix is stripped. These items have no summary and no picture. On a browser that has never accepted Google's cookie notice (the fresh emulator, for one), the first Times or Spectator link stops at Google's consent page once.
- **First fetch looks back 36 hours**, so the Right press window (36 hours) is full from the start; later fetches overlap the last success by 6 hours and de-duplicate on canonical URL.
- **De-duplication** is on canonical URL (host lower-cased, `www.` dropped, query and fragment stripped except identity parameters such as `id` and `p`, trailing slash dropped), plus same source and same headline within 7 days, which catches Google News listing one article under two links.
- **Guardian adapter** asks for 100 results a page, up to 6 pages, without the body field. The body is fetched per article only when the reader needs the fallback, which keeps the first refresh small.
- **Duplicate** creates a disabled copy with its own empty key slot. **Delete** removes the source's articles too. The last enabled primary source cannot be disabled, demoted or deleted.
- **Import replaces the list.** A source with the same name and adapter keeps its id, so its articles and stored key survive; others are removed. Import by file or by pasting JSON. Export by share sheet or on screen.
- **Health dots:** green, amber (nothing new in 24 hours), red (last fetch failed), grey (off or never fetched). "Test" fetches once with the form as it stands, saved or not, and shows the first five items or the error.

## 5. Matching, Right press and the model

- **One model call per primary article**, as costed in the spec. The spec's JSON has a single `match_id`, but step 4 picks among several confirmed candidates. So candidates are listed in preference order (explicit order from Settings if set, else lean furthest from the primary, ties by similarity) and the model is asked for the first one that is the same event. That gives the spec's pick with one call.
- **Rejected pairs are remembered** (`match_pair` table). A recheck in the 24-hour window sends only candidates not yet judged, and makes no call if there are none. A confirmed pair is never re-queried.
- **Angle notes over 20 words fail validation**, which triggers the one retry; a note that still passes validation is also hard-capped at 20 words. A note that says "primary" or "candidate" (the prompt's words, not a reader's) fails the same way; the prompt gives the outlet names so the model can use those instead.
- **Seen articles are never offered as candidates**, since a seen article may not appear again anywhere.
- **Right press makes one call per new story** (four at a time), returning both the neutral summary and, when a primary headline falls in the grey zone, whether the primary covered it. Stories are rechecked against new primary articles on every refresh and drop out if covered later. A summary is written once.
- **At the budget cap** embeddings continue (they cost fractions of a cent), model calls stop, second sources show the best candidate at or above 0.80 with the text "Also covering this story", and Right press shows a headline instead of a summary. A grey-zone Right press story waits, rather than risk showing something the primary did cover. When the month turns, missing notes and summaries are filled in.
- **Cost is taken from the `usage.cost` figure in each response** when present, else from token counts and the per-million prices in Settings.
- **Prompts** ask for British spelling, neutral wording, and no reference to "the primary" or "the candidate". The News prompts send headlines, standfirsts and article text. Since modes (section 15) the rule is "nothing secret leaves the phone": any app data may be sent, API keys never are, and a test checks every model request for keys.
- **Live result on 22 Nov 2026, before lowering thresholds:** 12 of 60 primary articles matched; Right press found 8 stories.
- **After tuning:** 21 of 60 matched with 24 model calls, including all of the eight highest-ranked cards. I read all 21 pairs and every one was the same event. For example, the Guardian's "Suffolk village votes to 'leave the UK'" was paired with GB News: "Emphasises safety concerns and characterises asylum seekers as 'unvetted males'; frames as protest against Labour rather than government plans." Every note was 20 words or fewer. Right press found 12 stories, each from two right-leaning outlets and none covered by the Guardian (a stabbing in Oldham, a Poundland takeover bid, the King and the mansion tax, and so on), with neutral one-sentence summaries. That is one evening's sample (a quiet Saturday night), not the spec's spot-check over real use.

## 6. Reader

- **The reader page is written to a file** beside its downloaded pictures and loaded from disk. That is what makes saved articles open with images in airplane mode on both platforms.
- **Sanitising is a whitelist**: about 45 tags, no attributes except link targets and image sources, a content security policy that blocks everything but images and the app's own inline script. Links open in the in-app browser, never inside the reader.
- **Lead picture:** many sites put the main picture outside the article body, so the extractor takes the first figure inside the page's `<article>` and puts it at the top with its caption. If there is none, the feed thumbnail is used.
- **Picture size:** from `srcset`, `<picture>` sources and width hints in the URL, the reader picks the smallest version at least 640 pixels wide.
- **Boilerplate removal:** navigation link lists, "skip to content" lines and timestamp-only paragraphs that Readability sometimes keeps are dropped (seen on the Express and Daily Mail).
- **Fallback chain** as specified: extract, then the adapter's body (the Guardian item endpoint, or `content:encoded` from a feed), then the in-app browser, which opens automatically. Failures are counted and listed in Debug.
- **Live blogs** are re-fetched if the stored copy is more than 5 minutes old.
- **A paywalled source set to `extract` is treated as `browser`**, per the spec's rule.
- **Saving an article fetches it immediately**, on any network. The Wi-Fi-only setting governs the bulk prefetch, not a single article you just asked to keep.
- **Time on page counts only while the app is in the foreground.** For the in-app browser, time on page is measured from opening to returning; no scroll depth is available there.

## 7. Learning and ranking

- **Affinity averages feature groups** (source, section, topics, type, writer, length), with an article's topic tags averaged into one group first. Read literally, "the mean over the article's feature values" would let twelve Guardian keywords outvote the section. With groups, 30 More-like-this taps on a section visibly move it up even during cold start (tested).
- **"Read" needs 5 seconds on the page** as well as 60% scroll (or 45 seconds). A one-screen article reports 100% scroll the moment it opens, so without the floor every glance would count as a read. The same floor applies to marking a Read later item done at 70%.
- **Each article teaches the model once per signal kind**, however often it is reopened.
- **"Shown, not opened" (-0.2) is applied when a session ends**, to feed cards that drew no interaction at all.
- **Interest centroids:** "read" is built from read, saved and More-like-this articles; "swiped away" from dismissed and Less-like-this. Both decay with the 30-day half-life.
- **Less like this also removes the card.**
- **Exploration:** slots 6, 12 and 18 of every 20. "Sections he rarely opens" means sections at or below the median positive weight among the sections currently on offer. The pick is random from the fresher half of those articles not yet placed, seeded by the session so the order is stable while you scroll.
- **Why am I seeing this** measures each feature against one you have no history with, so it lists real preferences, and prefers the more specific reason on a tie (a section over the source the whole feed shares).
- **Cold start** runs 14 days from first launch, and again from Reset learning.

## 8. Feed behaviour

- **A session** ends after 10 minutes in the background or on pull-to-refresh. Pull-to-refresh also forces a fetch of every source (at most once every ten seconds per source); refresh on open respects each source's refresh minutes.
- **Cards seen this session stay at the top in the order seen**; the rest are re-ranked when a refresh finishes. Nothing above your position moves.
- **Nothing is recorded as seen while the feed is covered** by the reader, Settings or another tab, or while the app is in the background. Cards in view are recorded the moment it is visible again.
- **New articles appear when the Score step finishes** (decision 9 above), before the prefetch of article bodies, which carries on behind. The top bar shows the step in progress.
- **Swipes follow the finger one to one** and commit after 72 points of travel. An earlier, stiffer setting made a swipe that started left of centre fall short.
- **The snackbar sits above the tab bar**, so its Undo never covers the tabs.
- **Cluster rule:** it hides second-source strips and Right press items for stories seen in an earlier session within 72 hours. Primary-source pieces always appear, as the spec says.
- **History** also lists Read later items marked done.
- **Retention** deletes an article once it was published, fetched and (if seen) seen more than 14 days ago, unless it is an open Read later item. Its offline pictures go with it.

## 9. Emulator results

Android emulator (Pixel 7 profile, Android 16, x86_64), release build, 22 November 2026.

### Maestro flows against the mock server

All five pass: `5/5 Flows Passed in 5m 39s` (`maestro test .maestro`). What each proves is listed in [testing.md](testing.md). Together they cover setup and key validation, the first refresh, second-source strips, Right press, the seen rule (with the geometry audit), sessions, History and search, the reader, Read later with undo and done-at-70%, swipe left with undo, the long-press menu, the fallback to the API body, BBC as the only primary, the budget cap and banner, and a broken feed going red while the rest refresh.

Getting them to pass found six real faults, all fixed: cards shown before matching (decision 9); pull-to-refresh ordering (decision 10); a snackbar covering the tab bar; swipes that needed too much travel; a 60-second floor between manual refreshes that swallowed a second pull; and Gradle's memory limit.

### Live data on the emulator (real feeds, real OpenRouter key, Guardian via RSS)

| Check | Result |
| --- | --- |
| Setup with the real OpenRouter key | The test call passed; the missing Guardian key was reported; Skip continued |
| First refresh, 381 articles from nine outlets | 20.5 seconds on the emulator, shown in Debug with per-step timings |
| Refresh with the Guardian added: 125 new articles, 60 checked against other outlets (24 model calls), Right press updated, 30 article bodies fetched and stored with pictures | 27.6 seconds in all. In an earlier run of the same size: clustering 0.6 s, matching 8.9 s, Right press 3.9 s, scoring 0.2 s, prefetch 8.6 s |
| Feed | Real Guardian cards with thumbnails, section, age, and second-source strips with angle notes |
| Reader on real Guardian articles | Headline, byline, date, lead photograph with caption and credit, body text with links; follows dark mode |
| Right press | 12 stories with summary, outlet links and counts; three dropped out when the Guardian turned out to have covered them |
| Cold start | About 0.6 s to first frame (`am start -W`, three runs: 598, 656 and 647 ms); the cached feed was loaded 111 ms after the app's code started. Settings, Debug shows that figure for every launch |
| Offline | An article saved for later opened with its photograph and full text in airplane mode, after the app was killed and restarted |
| Background refresh | The WorkManager job, forced with `cmd jobscheduler run` while the app was in the background, ran the pipeline; Debug listed it as a "background" run |
| In-app browser | A Times link opened in a Chrome Custom Tab |
| Export database | The Android share sheet opened with the file |
| Keys | The OpenRouter key is not in the APK (searched whole and by prefix) or in the device log |
| Scrolling | 700 frames while flinging the live feed: 1% janky, no missed vsync. The emulator renders in software, so its absolute frame times mean little; after a fast fling every card and thumbnail was drawn |
| Memory | About 150 MB with 500 articles stored |

### Not exercised on the emulator

Sign-in to a paywalled site, real overnight background scheduling, and anything on iOS.

## 10. Extra tables and columns

Beyond the spec's table list: `match_pair` (judged candidate pairs), `refresh_run` (Debug: last runs), `decision_log` (Debug: match, digest and extraction decisions), `centroid` (interest vectors). Extra columns: `source.last_fetch_at`, `source.last_new_at`; `article.url`, `external_id`, `adapter_body`, `body_source`, `body_tried_at`, `offline_images`, `score_a/s/i`; `cluster.size`, `outlet_count`, `last_article_at`, `digest_status`, `digest_checked`, `digest_at`; `impression.scored`; `second_source.similarity`, `method`. Interaction kinds add `bounce` and `ignored` to the spec's list.

## 11. Test tooling

- **E2E build variant.** `E2E=1` at build time allows plain HTTP (for the local mock server) and enables a `newsreader://e2e` deep link that points the app at the mock and can simulate time in the background. Production builds have neither; the route redirects to the feed.
- **Mock server** (`tools/mock-server.js`): Guardian-style API, RSS feeds, article pages with generated pictures and an OpenRouter-compatible API. Deterministic, so flows can assert exact headlines.
- **Seen-rule audit.** Maestro cannot measure how much of a card is visible, so E2E builds compute it from layout and compare with what was recorded. Debug shows the verdict.

## 12. Changes to this machine

- Installed **Maestro 2.12.1** to `C:\Users\da\tools\maestro` (not added to PATH).
- Gradle installed **Android NDK 27.1**, **CMake 3.22.1** and **Build-Tools 37** into the existing Android SDK.
- **Replaced `ninja.exe` in the SDK's CMake folder** (`%LOCALAPPDATA%\Android\Sdk\cmake\3.22.1\bin`) with Ninja 1.13.1, because the bundled 1.10.2 cannot create paths over 260 characters and React Native's build needs them. The original is beside it as `ninja.exe.orig-1.10.2`. For other Android projects on this machine the only effect is that long paths now work.
- Created an emulator, **`newsreader`** (Pixel 7, Android 16). Your `firstmate` emulator was not touched. Chrome on the new emulator went through its first-run screen during a browser test; nothing was signed in.
- **`C:\nr` is left over and can be deleted.** It is a 1.5 GB copy of the project (including `.env`) made while trying to get under the path limit, before the Ninja fix made it unnecessary. I tried to remove it, but the tool's safety check blocks deleting a folder at the drive root, so that one is yours: `rmdir /s /q C:\nr`.
- The app is installed on the `newsreader` emulator with live data in it.

## 13. Acceptance criteria, item by item

The spec says an item is done when it passes on a real Android phone and an iPhone. Nothing here
has run on real hardware or on iOS, so no item is fully closed. "Emulator" means the Android
emulator; "Jest" and "Maestro" name the automated check.

### Build and deploy

| Criterion | Status |
| --- | --- |
| EAS production build and submit to Play internal testing | **Not run.** Needs your accounts. Config written (`eas.json`, `app.config.ts`); a local release build of the same project succeeds |
| EAS production build and submit to TestFlight | **Not run.** Needs your accounts and a Mac for local builds |
| Maestro flows pass on iOS Simulator and Android emulator | **Android: pass (5 of 5). iOS: not run** |
| EAS Update reaches both phones | **Not run.** Wired up; switched on once `EAS_PROJECT_ID` is set |

### Sources

| Criterion | Status |
| --- | --- |
| First run seeds defaults, Guardian the only primary | Pass (Jest; seen on emulator) |
| Every field of every source editable, applied at next refresh | Pass (Jest; form used on emulator) |
| BBC primary, Guardian disabled: BBC-only feed, second sources and Right press still work | Pass (Maestro `04-bbc-primary`, Jest) |
| Two primaries give one merged feed | Pass (Jest) |
| Export and import round-trip without keys | Pass (Jest) |
| Test shows first five items or the error | Pass (Maestro `05-budget-health`, Jest) |
| Broken endpoint red, others still refresh | Pass (Maestro `05-budget-health`, Jest) |

### Setup and refresh

| Criterion | Status |
| --- | --- |
| Fresh install asks for keys and validates each with a test call | Pass (Maestro `01-setup-feed`; real OpenRouter key validated on emulator). Guardian validation only against the mock |
| First refresh fills the feed within 60 seconds on Wi-Fi | Pass on emulator: 20 to 28 seconds with live data. Not measured with the real Guardian API |
| Cached feed in under 1 second, then refreshes | Pass on emulator: about 0.6 s to first frame plus about 0.1 s to load the feed |
| Background refresh runs; Debug shows each run | Forced run passes on emulator. Real scheduling not observed |

### Seen rule

| Criterion | Status |
| --- | --- |
| Half or more on screen is seen; a peek is not | Pass (Maestro `02-seen-rule`, by the geometry audit) |
| No seen article after 10 minutes in the background or pull-to-refresh | Pass (Jest; Maestro `02-seen-rule`, with the 10 minutes simulated) |
| Seen cards stay within a session | Pass (Maestro `02-seen-rule`, Jest) |
| Seen as a strip or in Right press never becomes a feed card | Pass (Jest; also observed in `04-bbc-primary`) |
| Cluster rule: 72-hour suppression, primary pieces still appear | Pass (Jest) |
| History lists everything seen and search finds it | Pass (Maestro `02-seen-rule`, Jest) |

### Reading

| Criterion | Status |
| --- | --- |
| Guardian card opens the reader with headline, byline, lead image, text and inline photos | Pass on emulator with real Guardian pages; Maestro `03-reader-later` against the mock |
| Extraction failure falls back to the adapter body and thumbnail | Pass (Jest; Maestro `03-reader-later`) |
| Browser-mode source opens in Chrome Custom Tabs / SFSafariViewController | Android: pass on emulator. iOS: not run |
| Swipe right saves with undo; saved items open with images in airplane mode | Pass (Maestro `03-reader-later` for save and undo; airplane mode checked by hand on emulator) |
| Reading to 70% marks a Read later item done and moves it to History | Pass (Maestro `03-reader-later`, Jest) |

### Second source and Right press

| Criterion | Status |
| --- | --- |
| On a big political day, half of the top 10 have a second source with a note of 20 words or fewer | Encouraging, not proven: on one ordinary evening the eight top-ranked cards all had one. Notes are capped at 20 words in code |
| No more than 1 wrong in 20 strips | Encouraging, not proven: 0 wrong in the 21 I read |
| Changing a lean changes Right press at the next refresh | Pass (Jest) |
| Right press: 2+ right-leaning sources, no primary coverage, summary, links, count | Pass (Jest; Maestro `01-setup-feed`; live on emulator) |

### Learning and cost

| Criterion | Status |
| --- | --- |
| 30 More like this taps on a section move it up, and Why am I seeing this names it | Pass (Jest). The menu and Why box are exercised in Maestro `03-reader-later` |
| 3 of every 20 slots are exploration | Pass (Jest) |
| Reset learning returns to cold start | Pass (Jest). The Settings button was not tapped on the emulator |
| Spend shown from `llm_usage`; $0.01 budget stops calls, shows the banner, feed still loads | Pass (Maestro `05-budget-health`, Jest) |
| No API key in logs, bundle, sources export or database export | Pass: APK and device log searched for the real key; Jest covers the export and the database |

## 14. Five features added after the first build (22 November 2026)

Follow a story, Full coverage, the catch-up briefing, mute and watch lists, and "What the app has
learned". None is in [spec.md](spec.md). Each decision below is a choice I made; change any of them.

### What was verified

112 Jest tests pass (23 of them new, in `test/features.test.ts`), typecheck and lint are clean, and
Metro bundles the app. **None of the new screens has been run on a phone or emulator**, and there
is no Maestro flow for them. Migration 3 adds the tables; it only creates, so existing data is untouched.

### Follow a story

- **Follow from a card's long-press menu, from Full coverage, or from a Right press card.** A
  Following tab sits beside Outside your bubble, with a count of stories that have something new.
- **A story is the article's cluster at the moment you follow it.** Its centre never moves
  afterwards, so a story cannot drift into its whole topic. A later article joins when it is within
  the follow threshold of that centre (0.62, in Settings, Ranking) or when it shares a cluster with
  an article already in the story. 0.62 is looser than "same story" (0.75) on purpose: a running
  story moves on. It is a guess from the similarity bands in section 1 and has not been tuned on
  real data.
- **What is already published when you follow is background.** Only what arrives afterwards counts
  as new. Opening the story marks everything as looked at.
- **One model call per story per refresh, and only when the new coverage has grown.** It writes what
  changed in 45 words or fewer. At the budget cap the story shows its newest headline instead.
- **Articles are matched while they are under 84 hours old** (the embedding window), from every
  enabled source, whether or not you have seen them.
- **Followed stories do not bypass the seen rule or retention.** A story's list is like History:
  listing an article there does not mark it seen, opening it does. Articles still go after 14 days;
  the story stays until you stop following.

### Full coverage

- **The list is the article's cluster plus any article the model confirmed as the same event**
  (a second source can sit just outside the cluster).
- **Ordered along the leans set in Settings, but the leans are not shown or sent to the model**,
  in keeping with "the app never shows them as a rating of the outlet". The comparison prompt asks
  the model not to describe any outlet's politics; a test checks no lean reaches the prompt.
- **The comparison is made on request**, one call, from headlines and summaries only, and stored
  per story. If more outlets cover the story later, the button offers to compare again.
- **Opening an article from Full coverage or a followed story** records it as seen with its own
  surface (`coverage`), so it does not then appear among this session's feed cards.

### Catch-up briefing

- **Due after 8 hours away** (Settings; can be switched off). "Away" is measured from when the app
  last went to the background. A pull-to-refresh never triggers one.
- **Up to five stories that two or more outlets ran while you were away**, most outlets first, one
  model call for all the sentences. It looks back three days at most. Muted topics are left out.
- **It is a card above the first For you card** until dismissed, replaced, or a day old. Tapping a
  line opens Full coverage for that story. Briefing lines do not count as seeing the articles.
- **Not read aloud.** I mentioned text-to-speech when proposing this; it needs a new native module
  (`expo-speech`) and so a new build, and I left it out rather than add an untested native dependency.
- If the app was refreshed in the background within the last two minutes, opening it writes the
  briefing without fetching again.

### Mute and watch lists

- **Whole words and phrases, ignoring case, in the headline, standfirst, section and topic tags**;
  a plural "s" also matches. Settings, Learning, Muted and watched topics; or long-press a card and
  choose "Mute or watch a topic", which offers that card's topics.
- **Mute applies when the lists are drawn**, so it takes effect at once and ends by itself: For you,
  Right press (one outlet's wording is enough to mute the story), Outside your bubble and the
  briefing. Muted stories send no "shown, not opened" signal. Followed stories are not filtered.
- **Watch adds 3 to the card's score**, which puts it among the first cards, and marks it
  "Watching". It also brings in articles from perspective sources, one per story (the newest), when
  no primary card in the feed carries that story. This is the one way a non-primary article becomes
  a For you card, which departs from the spec's "the default feed is the primary sources only".
- **A term has one rule at a time.** Adding it again replaces the earlier rule on either list.

### What the app has learned

- **Lists every learned preference worth showing** (sections, topics, writers, sources, types,
  length), likes then dislikes, strongest first, with More, Less and Forget on each. More and Less
  weigh the same as "More like this" and "Less like this" on a card (3). Each change re-scores the
  waiting feed.
- **Preferences smaller than one clear signal are hidden** (a card merely scrolled past moves each
  of its features by about 0.04; the floor is 0.08).
- **The similarity part of the ranking (what your reading is "like") cannot be listed** and is not
  editable here; the screen says so and points to Reset learning.
- **Reading diet:** articles read (not merely opened) in the last seven days and the seven before,
  by section, by source and by the lean you gave each source. It is a count of your own settings,
  not a rating of any outlet.

### Other changes

- **Pipeline steps are now** fetch, embed, cluster, second sources, score, Right press, followed
  stories (`7b`), briefing (`7c`), prefetch, retention. Retention also clears old briefings and
  comparisons, expired topic rules, and story links to deleted articles.
- **`.gitignore`: `coverage/` became `/coverage/`.** The unanchored rule (for Jest's coverage
  folder) was silently ignoring the new `src/app/coverage/` screen.
- **Extra LLM cost** is one call per followed story with new coverage per refresh, one per briefing,
  and one per comparison you ask for, each about the size of a second-source check ($0.002).

## 15. Modes and the AI mode (24 November 2026)

Built from [the PRD](News%20Reader%20PRD%20Modes%20and%20the%20AI%20mode.md). Where it and the
sections above disagree, the PRD wins and the sections above have been changed to match (the
privacy rule in section 5; spec.md throughout). Each decision below is a choice I made; the ones
marked **check** are those most worth a second look.

### What was verified

- **Jest: 195 tests pass** (53 of them new, in `mode-data`, `mode-nav`, `ai-sources`,
  `ai-pipeline` and `ai-display-learning`), typecheck and lint clean. No earlier test changed except
  the one the PRD retires: the assertion that the match prompt carries no reading history became
  one that it carries no API key, and a new test checks every model request for keys.
- **The earlier tests still pin News behaviour**, including the exact list of refresh steps: the
  AI mode adds steps only when it has an enabled source, which no earlier test has.
- **Live, in Node, with the real default sources and OpenRouter** (`test/live-ai.test.ts`): see
  "Live result" below.
- **Emulator and Maestro: not finished.** The E2E build installs and flow `07-modes` gets through setup, the mode bar and switching mode, then fails waiting for the AI feed after pull-to-refresh. Flows 01 to 06 and live data on the emulator have not been run. See [handoff-modes.md](handoff-modes.md).

### Data and migration

- **Migration 7 only adds.** It creates `mode` (News is id 1, AI id 2), adds `mode_id` and the new
  columns, and the new tables. `article` is rebuilt so the canonical URL is unique per mode; every
  row and id is kept, and so is the table's AUTOINCREMENT position, because `interaction` rows
  outlive their articles and a reused id would hand an old "hidden" to a new story (tested).
- **News's settings are copied into the News mode and also left in `setting`** (the brief said
  never lose data). The mode's copy is the one read and written from now on; the old rows are inert.
  The column is `sort_order`, not `order` (a reserved word).
- **News's settings stay readable through `loadSettings`**, which merges the News mode's settings
  over the shared ones, and `saveSettings` routes each key to the right place. That kept every
  existing caller and test unchanged.
- **Every News query filters on the News mode** (sources, articles, clusters, feature stats,
  centroids, topic rules, stories, briefings, Pulse, the reading diet). `listSources`,
  `loadReadLater`, `loadHistory`, `exportSources` and `importSources` take a mode, News by default.
- **A signal reaches the right model through one door**: `applySignal` looks up the article's mode
  and hands sections-layout articles to the new learning module. So every existing action (save,
  thumbs, swipe, read, "seen, not opened") teaches the mode the card is in, and only that mode.
- **The AI mode's sources and starter profile are seeded by the app on first start**, once
  (`seedModes`), not by the migration: an install's first start after updating gets them, and
  deleting them all later does not bring them back. `createMode` adds a further mode from a
  definition alone (tested with a third, "Climate", mode).
- **The News layout is bound to the News mode.** A third mode can use the sections layout through
  configuration alone; a second News-layout mode would need the News-only features (Pulse, the
  briefing, followed stories) to take a mode, which the PRD keeps out of v1. **Check.**

### Sources (all URLs checked live on 24 Nov 2026)

| Source | Adapter and URL | Notes |
| --- | --- | --- |
| Simon Willison's Weblog | rss `https://simonwillison.net/atom/everything/` | |
| Latent Space | rss `https://latent.space/feeds/articles.xml` | **Substitute**: `latent.space/feed` now also carries AINews issues, so the articles-only feed |
| AINews (smol.ai) | rss `https://latent.space/feeds/news.xml`, digest | **Substitute**: AINews moved into Latent Space; `news.smol.ai/rss.xml` stopped on 9 Sep 2026 and `news.smol.ai` redirects. Reader mode browser (most links are X posts) |
| TLDR AI | rss `https://tldr.tech/api/rss/ai`, digest | Feed entries are bare links: each issue page is fetched and split |
| Engineering Enablement (DX) | rss `https://newsletter.getdx.com/feed` | |
| The Pragmatic Engineer | rss `https://newsletter.pragmaticengineer.com/feed` | Paywalled, reader mode browser |
| Interconnects | rss `https://www.interconnects.ai/feed` | |
| Import AI | rss `https://importai.substack.com/feed` | (`jack-clark.net/feed/` also works) |
| Hacker News | hn_api `.../v0/topstories.json` and `beststories.json` | 60 from each list, 150 points, AI keyword list in the source's options |
| Anthropic | html_list `https://www.anthropic.com/news` | No feed (`/rss.xml` is 404). Links matching `^/news/<slug>`, titles of 4+ words, date from the card |
| OpenAI | rss `https://openai.com/news/rss.xml` | |
| Google (Gemini and DeepMind) | rss: the Gemini, DeepMind and Google AI blog feeds | The blog.google feeds moved (`/products-and-platforms/products/gemini/rss/`, `/innovation-and-ai/technology/ai/rss/`); the new addresses are used |
| GitHub Copilot changelog | rss `https://github.blog/changelog/label/copilot/feed/` | |
| Cursor changelog | rss `https://cursor.com/changelog/rss.xml` | |

- **Priorities:** vendors high; blogs and newsletters normal; AINews, TLDR and Hacker News low.
  Within a priority an original item beats a digest's.
- **One item per URL per mode, and further sources become coverage.** When a second source brings a
  URL the mode already has (Hacker News linking to a vendor post, a digest linking to it), it is
  recorded as a mention (`article_mention`, a new table): it counts as a source of the story, adds
  its Hacker News points and digest words, and shows under "+N more" (Hacker News as its thread).
  If the newcomer has the higher priority it takes the item over and the old owner becomes the
  mention. The PRD asks both to "dedupe on canonical URL within the mode" and that the "same
  canonical URL joins immediately"; this does both.
- **Digest splitting** takes the issue's blocks (`<article>`, else top-level list items, else
  paragraphs) that link away from the digest's own site; the story link is the first one that is not
  social discussion (X, Reddit, Discord, YouTube and so on), else the first; sponsored blocks,
  sign-ups and forms are skipped; at most 25 stories an issue (an option). On the real issues: TLDR
  gave its 13 stories with the sponsors and the sign-up form left out; an AINews issue gave 25
  (capped) of about 40 story blocks.
- **The prefilter runs before storing**: items older than the max age are not taken in, and a
  Hacker News story under 150 points is not stored, so it is looked at again when its points grow.
  Hacker News is read in full each fetch and points are updated.

### Pipeline

- **Steps** (named in Debug "AI: 1 Fetch, split and prefilter" to "AI: 5 Profile") run after News's
  prefetch and before the shared retention, in the same run, under the same lock and the same
  six-minute background limit. No timers; network through `src/platform/fetch.ts`.
- **Enrichment: one model call per story, five stories to a request** (`enrichBatchSize`). The PRD
  says both "one Haiku call per cluster" and "batch calls where possible"; batching several stories
  into one request keeps each story to one call's worth and costs about 40% less (the profile and
  rules are sent once per request). Set it to 1 for literally one request per story. **Check.**
- **The limits are enforced in code as well as asked for**: over-long headlines, summaries and "why"
  lines are cut at 10, 20 and 15 words; em dashes, exclamation marks and the named hype words are
  removed; tags outside the mode's taxonomy are dropped. The prompt asks for 9, 18 and 12 words, so
  cuts are rare (the live run before that change cut many "why" lines mid-sentence).
- **A story not yet enriched** (budget cap, or the call failed) shows in the main section with its
  source's headline, as the PRD's at-cap rule says. The "10 words" acceptance item therefore holds
  for enriched cards; a raw source headline can be longer. **Check.**
- **"Why am I seeing this"** needs to know which profile lines drove the score, so the enrichment
  (and the rescoring call) also returns up to two profile lines; they are shown with the tag and
  source weights.
- **Rescoring after a profile change** is one call per 25 unseen stories, asking only for the
  match. It runs at the next refresh after an edit, restore, reset or rewrite.
- **Significance labels**: the PRD's three labels come from whichever of coverage, Hacker News or a
  high-priority release contributed most; when only the model's impact score is non-zero the label is
  "High impact" (a fourth label). Coverage counts from the second source: one source gives 0, five
  give the full 0.35. Hacker News is full at 500 points. **Check** both scales.
- **Expiry** is counted from the story's first publication: 7 days, or 14 at significance 0.8 and
  above. Expired and held-back stories stay in the database until the shared 14-day retention.

### Learning

- **Signals** carry the PRD's starting weights, all in the mode's settings. "Read" in the AI mode is
  reaching the end (90% scroll) or staying for 60% of the read time estimated from the article's
  length (230 words a minute), with the 5-second floor; there is no bounce signal. "Opened" is the
  first open only. A "+N more" source opened counts on the card's story.
- **EMA**: each signal moves every tag of the story, and the primary item's source, a tenth of the
  way to the signal's weight. Undo runs the average backwards. "Less like this, because…" moves only
  the source or only the tags. Weights are kept between -1 and 1.
- **Graduation**: three opened In other news stories sharing a tag within 30 days raise the tag by
  0.25 (one "step"; the PRD does not size it), once per 30 days per tag, and the next rewrite is
  told. **Check** the step size.
- **The profile rewrite** is due after 50 signals or a week, but only if there is at least one new
  signal (a weekly rewrite of nothing would only spend money). Pinned lines are put in the prompt and
  then enforced in code: a pinned line the model dropped or reworded goes back, word for word, under
  the heading it was under.
- **Pinning**: a line he adds or changes in an edit is pinned; a pinned line he deletes is gone;
  long-press a line on the Learning screen to pin or unpin it. Every save, rewrite, restore and reset
  is a new version. The starter profile is recorded as written by "starter" (the PRD lists only llm
  and user).
- **Reset learning for the AI mode** clears its tag and source weights, starts the cold start again,
  and makes the starter profile the newest version (earlier versions can be restored). Item state is
  untouched. In News it does what it always did, for News only. **Check** that the profile should
  go back too (the PRD counts it as learning state).
- **Cold start**: two weeks from the mode's first start (or a reset): relevance threshold 0.4 and
  five In other news stories.

### Display

- **Cards** follow the PRD: rewritten headline, one-line summary, "why it matters" (main section
  only), source, "+N more" (tap to list the other sources' links), read time, age, and on In other
  news cards the reason label. Same actions as News: tap, bookmark, thumbs up and down, swipe right
  to hide, swipe left for "less because" (this source, or these topics), long press for the menu
  (More like this, Less like this, Why am I seeing this, Share link).
- **Seen** is the News rule, applied per story: a card is seen at half on screen, stays for the
  session, then is gone for good in this mode (any item of the story seen counts). Cards not yet
  revealed by Show more are not drawn, so cannot be seen.
- **Tapping Feed again** scrolls a sections-layout feed to the top. The mode bar is hidden if there
  is only one mode. The budget banner says what the cap means in the mode on screen.

### Live result (real sources, real OpenRouter, first refresh from an empty database)

All 14 sources fetched without error. 275 items (125 from AINews issues, 72 from TLDR's five
issues) gave 234 stories; 229 were enriched in 47 requests, 5 were left for the next run. The AI
part of the refresh took 79 seconds (enrichment 69 s) and **cost $0.24** ($0.243 enrichment,
$0.0004 embeddings), about 59,000 tokens in and 37,000 out. Later refreshes only enrich new stories
(a few cents a day), in line with the PRD's $4 to $8 a month.

The headlines and summaries read well: plain, specific, with the source's numbers. For example
"Google releases Gemini 4 Neon with 1M token context window", from five sources (Google, Copilot's
changelog, Simon Willison, AINews, TLDR), labelled "Widely covered".

**Check: In other news will often be empty with the PRD's numbers.** On this run only 2 of 234
stories reached significance 0.6, and both were relevant enough for the main section. A story from
one source can score at most 0.45 (a vendor release 0.2 plus impact 0.25), and 90% of stories had
one source. Good left-field candidates sat just under the bar: Nvidia reinstating Jensen Huang (0.47,
2,774 points on Hacker News) and Genie 4 (0.49). I kept the PRD's 0.6; about 0.45 would have filled
the section on this sample. It is `otherNewsMinSignificance` in the mode's settings.

**Check: the cold start lets most stories into the main section**: 191 of 234 passed relevance 0.4
(0.6 × match + 0.4 × 0.5 needs a match of only 0.33). It is the PRD's value, and Show more pages it.
