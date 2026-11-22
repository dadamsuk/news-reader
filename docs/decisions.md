# Build decisions and verification notes

Written during the unattended build of 22 November 2026, for review afterwards. Each entry says
what was decided and why. Where the build departs from the letter of the spec, it says so.

The spec is [spec.md](spec.md). Section references below are to its headings.

## 1. What to check first

These are the choices most worth a second opinion.

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
- **Prompts** ask for British spelling, neutral wording, and no reference to "the primary" or "the candidate". Only headlines, standfirsts and article text are sent; a test asserts this.
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
