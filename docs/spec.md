# News app spec

Snapshot of the live spec doc as of 21 Nov 2026. Author: David Adams.

## Summary

A native mobile news reader for one person, built once in React Native with Expo so it ships to Android now and to iOS from the same code. It runs entirely on the phone, with no server. It leads with one or more primary sources (the Guardian by default), never shows a story twice, learns what David reads, pairs primary stories with a second source from a different perspective, and has a separate digest of what the right-leaning press is covering that the primary sources are not.

Every source, the Guardian included, is a configurable record: its type, address, key, role and lean are settings, not code.

The app has **modes**: separate reading feeds, each with its own sources, display and learning. **News** is everything this spec describes. **AI** is a filtered feed for keeping up with AI from a software engineering and CTO point of view, specified in [News Reader PRD: Modes and the AI mode](News%20Reader%20PRD%20Modes%20and%20the%20AI%20mode.md). Where this spec says "the feed", "sources" or "learning" without naming a mode, it means the News mode. See Modes below.

### Goals

- Every story appears on screen at most once, unless he saves it for later.
- Primary-source articles are read inside the app, with text and photos, not in the publisher's app.
- A primary story gets a second source from another outlet when one exists, with a one-line note on how its angle differs.
- A "Right press" tab lists stories two or more right-leaning outlets are running that no primary source has covered.
- Ranking improves from what he opens, finishes, saves and ignores.
- LLM spend stays around $5 to $6 a month for News and $4 to $8 for the AI mode, under one monthly hard cap ($15 by default) that degrades gracefully.
- One codebase builds for Android and iOS, shipped through his own Google Play and Apple developer accounts.

### Non-goals for v1

- Desktop or web clients, and any server or cross-device sync.
- Push notifications, comments, social media sources, multiple users or accounts.
- Public store listings. Builds reach his own phones through Google Play internal testing and TestFlight.
- Reading paywalled articles inside the app's own reader (they open in an in-app browser instead).

## Platform and architecture

React Native with Expo, in TypeScript. It gives one codebase for both phones, over-the-air updates for JavaScript changes, and a language and library set that coding models handle very reliably, which matters for a one-shot build. Builds can run in Expo's cloud or locally on his Mac. Everything runs on the phone: fetching, matching, ranking and storage. The only network calls are to the news sources and to OpenRouter.

### Stack

- Expo (current SDK), TypeScript, Expo Router. Development builds rather than Expo Go, because of background tasks and native modules.
- `expo-sqlite` for all data, behind a small typed repository layer with numbered migrations. Embeddings stored as Float32Array blobs.
- `expo-background-task` for periodic refresh (requested every 30 minutes, configurable). It uses [WorkManager on Android and BGTaskScheduler on iOS](https://docs.expo.dev/versions/latest/sdk/background-task). The app also refreshes on open and on pull-to-refresh.
- `fast-xml-parser` for RSS and Atom. `@mozilla/readability` with `linkedom` to extract article bodies in plain JavaScript, so extraction also works inside background tasks, where no WebView exists.
- `expo-image` for images and caching, `expo-file-system` for offline article copies, `react-native-webview` for the reader, `expo-web-browser` for paywalled articles (Chrome Custom Tabs on Android, SFSafariViewController on iOS).
- `FlatList` with `onViewableItemsChanged` and `viewAreaCoveragePercentThreshold: 50` drives the seen rule. `react-native-gesture-handler` and Reanimated for swipes.
- `expo-secure-store` for API keys (Android Keystore, iOS Keychain). Nothing secret is compiled into the app.
- Jest for the pipeline, matching, ranking and seen logic. Maestro flows for the end-to-end checks, run on both platforms.

### Build and deploy

- Android: EAS Build `production` profile produces an AAB, and `eas submit --platform android` uploads it to the Google Play internal testing track. A `preview` profile also produces an APK for quick sideloading.
- iOS: EAS Build `production` profile, then `eas submit --platform ios` to TestFlight (internal testers only). Either step can run locally on his Mac with `eas build --local` or Xcode.
- Day-to-day development and Maestro end-to-end runs use the iOS Simulator and an Android emulator on the Mac.
- EAS Update pushes JavaScript-only changes to both phones without a new store build.
- One `eas.json` with `development`, `preview` and `production` profiles. A GitHub Actions workflow runs tests on every push and builds and submits on a tag.

### Refresh pipeline

Each refresh runs these steps in order for the News mode, then each other mode's own steps in turn (see Modes), then retention, all under one refresh lock. A failed step is logged and skipped. It never blocks the steps after it.

1. Fetch every enabled source through its adapter (see News sources), from its last successful fetch onwards.
2. Normalise to `article` rows and de-duplicate on canonical URL (strip query strings and tracking parameters) within the mode: the same URL can be stored once in each mode.
3. Embed each new article's headline plus summary through OpenRouter, in batches.
4. Cluster: attach each new article to an existing cluster from the last 72 hours if cosine similarity to the cluster centroid is at least 0.82. Otherwise start a new cluster.
5. Second sources: for the primary articles most likely to be shown, find and confirm a second source (see Second source matching).
6. Right press: rebuild the digest (see Right-wing press digest).
7. Score and order the feed (see Learning and ranking).
8. Prefetch bodies and images for the top 30 unseen feed items and all read-later items. Wi-Fi only by default.

The app always opens straight onto the cached feed and refreshes in the background. This matters most on iOS, where [the system decides when a background task runs](https://docs.expo.dev/versions/v54.0.0/sdk/background-task/) from battery, network and usage patterns, so it may run only a few times a day. Refresh on open is the main path on both platforms; background refresh is a bonus.

### Retention

Articles older than 14 days are deleted, except read-later items. Interaction history and learned feature stats are kept indefinitely (they are small).

## News sources

Every source, including the Guardian, is a row in the `source` table that he edits in Settings. Nothing about any particular outlet is hard-coded except the adapter types. Adding an outlet, swapping the primary source or changing a lean needs no rebuild.

### Source record

| Field | Values | Purpose |
| --- | --- | --- |
| name | text | Shown on cards and in the reader |
| adapter | `guardian_content_api`, `rss`, `google_news_search`, `hn_api`, `html_list` | How the app fetches it |
| endpoint | URL, or a search query for `google_news_search` | Where it fetches from |
| api_key | optional, held in secure storage | For adapters that need one |
| role | `primary`, `perspective` | Primary sources make up the For you feed. Perspective sources supply second sources and the Right press digest |
| lean | `left`, `centre-left`, `centre`, `centre-right`, `right` | Drives second-source preference and the digest |
| reader_mode | `extract`, `api_body`, `browser` | Extract from the web page, use the adapter's own body, or open in the in-app browser |
| paywalled | yes or no | Paywalled sources never use `extract` |
| include_sections, exclude_sections | lists | Filters by section, category or URL path |
| refresh_minutes | number, default 30 | Minimum gap between fetches of this source |
| enabled | yes or no | Off sources are kept but not fetched |
| mode | a mode | Each source belongs to exactly one mode; the same feed can be a source in two modes |
| priority, is_digest, config | high, normal, low; yes or no; JSON | Sections-layout modes: which source leads a story covered by several, whether issues are split into stories, and adapter options (for example the Hacker News points threshold). Role and lean are News-only; such sources are saved as primary, centre |

Rules: any number of sources can be primary; at least one must be enabled. Changing a source's role takes effect at the next refresh. Settings can export all sources as JSON and import them again, with keys left out of the export.

### Adapters

- `guardian_content_api`: the Guardian Content API with a free developer key ([Open Platform](https://open-platform.theguardian.com/)). Supplies headline, standfirst, byline, word count, section, keyword and tone tags, and body. Works for any query and section filter, not just the front page.
- `rss`: any RSS 2.0 or Atom feed. Section comes from the feed's category element or URL path.
- `google_news_search`: Google News RSS search for a query such as `site:thetimes.com`, for outlets with no usable feed of their own.

### Default sources on first run

| Source | Role | Lean | Adapter and endpoint | Reader mode |
| --- | --- | --- | --- | --- |
| Guardian | primary | left | `guardian_content_api` | extract, falling back to api_body |
| BBC News | perspective | centre | `rss`: `https://feeds.bbci.co.uk/news/rss.xml` plus the UK politics feed | extract |
| The Economist | perspective | centre | `rss`: `https://www.economist.com/latest/rss.xml` ([feed list](https://feeder.co/knowledge-base/rss-content/the-economist-rss-feeds/)) | browser (paywalled) |
| The Telegraph | perspective | right | `rss`: `https://www.telegraph.co.uk/rss.xml` and `/news/rss.xml` | browser (paywalled) |
| The Times | perspective | right | `google_news_search`: `site:thetimes.com` | browser (paywalled) |
| The Spectator | perspective | right | `rss`, URL verified at build | browser (metered) |
| Daily Mail | perspective | right | `rss`, news and politics feeds, URLs verified at build | extract |
| Daily Express | perspective | right | `rss`, news and politics feeds, URLs verified at build | extract |
| The Sun | perspective | right | `rss`, news and politics feeds, URLs verified at build | extract |
| GB News | perspective | right | `rss`: `https://www.gbnews.com/feeds/news.rss` and the politics feed ([feed](https://feeder.co/id/discover/7926b0c6d0/gbnews-com)) | extract |

The leans are his settings, not a claim about the outlets. Right-leaning tabloids default to news and politics feeds only, never showbiz, sport or celebrity, to keep the digest about public affairs.

### Guardian photos: an important constraint

The free developer key is for non-commercial use, which covers this app. But its free content comes with only thumbnail images, and in 2024 the Guardian removed images from the API's body text [at the request of its Licensing department](https://groups.google.com/g/guardian-api-talk/c/3pqUQfJ28iE). So the Guardian's default reader mode is `extract`: load the article's public page on theguardian.com and pull out the body and images, the same request a browser makes. If that fails, it falls back to the API body plus the thumbnail.

### Feed health

Each source records its last success and last error. Settings shows a green, amber (no new items in 24 hours) or red (last fetch failed) dot per source, and a Test button that fetches once and shows the first five items.

## Feed, seen rule, read now and read later

A story that has been on screen is never shown in the feed again. The only ways back to it are Read later and History.

### Seen rule

- A card is **seen** the first time at least 50% of its area is visible on screen while the app is in the foreground, for any length of time. The seen timestamp is written to the database immediately.
- Seen cards stay in the list for the rest of the current session, so scrolling back up still works. A session ends when the app has been in the background for 10 minutes, or on pull-to-refresh.
- A new session shows only unseen articles.
- The same rule applies everywhere an article can appear: the main feed, a second-source strip and the Right press tab. An article seen as a second source never turns up later as a feed card.
- Cluster rule: once any article in a cluster has been seen, other outlets' articles in that cluster are suppressed for 72 hours. Other primary-source pieces in the cluster (an analysis, a comment piece, a live blog) still appear, because they are different articles.

### Card

Thumbnail, headline, two lines of standfirst, section, age ("2h"), and a comment or analysis label where the source tags it so. If a second source exists, a strip underneath shows the outlet name and the one-line angle note.

### Actions

- Tap: read now, in the reader.
- The bookmark icon: read later. A snackbar offers undo.
- Swipe right, or the thumbs-down icon: dismiss (not interested). Removes the card and counts as a negative signal. A snackbar offers undo.
- Swipe left: "Show me less like this, because…", then removes the card.
- An article that has been open for 5 seconds leaves the feed at once (it does not wait for the session to end). It is then in History.
- Long press: menu with More like this, Less like this, Why am I seeing this, Share link.
- Tap the second-source strip: opens that article (reader for free sources, in-app browser for paywalled ones).

### Reader

- A WebView showing sanitised article HTML with the app's own stylesheet: headline, byline, date, lead image, body with inline images and captions. Follows system dark mode. Text size set in Settings.
- Bottom bar: Save for later toggle, Second source (if one exists), Share, Open original.
- Records time on page and maximum scroll depth for learning.
- Guardian live blogs show the latest 20 blocks from the API, newest first. If extraction fails, the reader falls back to the adapter's own body where it has one, then to the in-app browser.

### Read later

- A list of saved articles, newest saved first, available offline with images.
- An item is marked done automatically when read to 70% scroll depth, or manually by swiping. Done items move to History.

### History

Everything seen in the last 14 days, newest first, with a text search on headlines. This is the safety net for stories scrolled past by accident. Opening an item from History reads it but does not put it back in the feed.

## Second source matching

A primary story gets a second source only when a perspective source covered the same event. A weak match is worse than none, so the app shows nothing rather than force one.

1. **Which primary articles:** the top 60 unseen primary articles by feed score, at each refresh. Unmatched articles are rechecked at later refreshes for 24 hours, because other outlets often publish later.
2. **Candidates:** articles from enabled perspective sources published within 48 hours either side, with cosine similarity of at least 0.70. Keep the top 5.
3. **Confirm with Haiku:** send the primary headline and standfirst, and each candidate's headline and summary (plus the first 600 words of body for free sources already fetched). Ask for JSON: `{"match_id": string|null, "same_event": bool, "angle_note": string}`.
4. **Pick:** among confirmed same-event candidates, choose the one whose lean is furthest from the primary source's lean, using the order left, centre-left, centre, centre-right, right. Ties go to the higher similarity score. With the default sources this means right-leaning outlets first, then The Economist and BBC. Settings can override with an explicit preference order.
5. **Angle note:** at most 20 words, neutral, about framing and emphasis rather than repeating the facts. Example: "Leads on the cost to taxpayers; quotes the opposition rather than the minister."
6. Store the result in `second_source` and never re-query a confirmed pair.

The 0.70 and 0.82 thresholds are Settings values, and a debug screen (Settings, then Debug) lists recent clusters and match decisions with their scores, so they can be tuned on real data.

## Right-wing press digest

The Right press tab shows stories that at least two right-leaning perspective sources ran in the last 36 hours and no primary source has covered at all. "Right-leaning" means a lean of `right` or `centre-right`, so which outlets count is set in Settings.

### Qualifying a story

1. The cluster has articles from 2 or more distinct right-leaning sources, published in the last 36 hours.
2. No primary-source article in the last 72 hours has similarity of 0.70 or more to the cluster centroid.
3. If the nearest primary article scores between 0.60 and 0.70, Haiku is shown its headline alongside the cluster's headlines and asked whether the primary source has covered the same story. A yes disqualifies the cluster.

### Each digest item

- A one-sentence neutral summary of what the story is, written by Haiku from the headlines and summaries. It says what is being reported, not whether it is true or important.
- The outlets covering it, each a link, with a count ("4 outlets").
- An image from the first free source that has one.
- Tapping an outlet opens that article (reader for free sources, in-app browser for paywalled ones).

### Ordering and limits

Ranked by number of outlets, then recency, then learned interest (same model as the feed, lighter weight). At most 15 new items per refresh. The seen rule applies exactly as in the main feed.

## Learning and ranking

The model is deliberately simple and explainable: smoothed open rates per feature plus similarity to what he has read, all computed on the phone.

### Signals

| Signal | Meaning | Weight |
| --- | --- | --- |
| More like this | Strong positive | +3 |
| Read: scroll 60% or more, or 45 seconds or more on page | Positive | +1 |
| Saved for later | Positive | +1 |
| Opened but left within 3 seconds | Weak negative | -0.3 |
| Shown, not opened | Weak negative | -0.2 |
| Swiped away | Negative | -1 |
| Less like this | Strong negative | -3 |

All signals decay with a 30-day half-life.

### Features

Source, section, each keyword or category tag, tone tag where the adapter supplies one (news, comment, analysis, live), byline, word-count band (under 600, 600 to 1,500, over 1,500), and the article embedding.

### Score

```
score = 1.0 * A + 1.5 * S + 1.0 * F + 0.5 * I
```

- A, affinity: the mean over the article's feature values of log((positive weight + 1) / (negative weight + 5)), using the decayed sums for that feature value.
- S, interest: cosine similarity to the decayed centroid of read articles, minus 0.5 times the similarity to the centroid of swiped-away articles.
- F, freshness: 0.5 raised to (age in hours / 8).
- I, importance: log(1 + number of distinct outlets in the article's cluster).

Weights live in Settings. For the first 14 days (cold start), A and S are multiplied by 0.3, so freshness and importance dominate.

### Exploration

In every 20 feed slots, 3 go to unseen articles from sections he rarely opens, chosen at random from the top half by freshness. This stops the feed narrowing into a bubble, which matters here given the point of the app. Exploration cards are not labelled.

### Why am I seeing this

The long-press menu shows the three largest score contributions (for example "Section: Politics", "Similar to 6 stories you read", "Covered by 5 outlets"). Settings has Reset learning, which resets the mode picked in Settings, Learning, and no other.

## LLM use and cost

Two kinds of call go through OpenRouter, and the expected cost is about $5 to $6 a month at Claude Haiku 4.5 list prices.

| Use | Model (Settings default) | Calls per day (estimate) | Tokens per call |
| --- | --- | --- | --- |
| Embeddings of headline plus summary | `openai/text-embedding-3-small` via the [embeddings endpoint](https://openrouter.ai/docs/api/reference/embeddings) | about 1,000 items, batched | about 80 |
| Second-source confirmation and angle note | `anthropic/claude-haiku-4.5` | about 60 | 1,500 in, 150 out |
| Digest summary and primary-coverage check | `anthropic/claude-haiku-4.5` | about 20 | 1,500 in, 150 out |

Haiku 4.5 is listed on OpenRouter at [$1 per million input tokens and $5 per million output tokens](https://openrouter.ai/models/anthropic/claude-4.5-haiku-20251001). About 80 calls a day is roughly 120,000 input and 12,000 output tokens, so about $0.18 a day. Embeddings cost a fraction of a penny a day. Both model IDs are Settings values, so a newer, cheaper Haiku can be swapped in without a rebuild.

### Rules for every call

- Temperature 0, JSON output validated against a schema. One retry on invalid JSON, then skip and log.
- Nothing secret leaves the phone: API keys and other secrets are never sent to the model. Any data from inside the app may be (headlines, article text, and for the AI mode reading history, signals and the interest profile). Signals, profiles and item state are stored only on the phone. No third-party analytics.
- Cost is recorded per call from the usage figures in each response, into `llm_usage`.
- One monthly budget in Settings covers every mode, default $15; spend is recorded per mode and Settings shows it in total and per mode. At the cap, in News, LLM steps stop until the 1st of the next month: the feed still works on embeddings alone, second-source strips show the best match above 0.85 without an angle note, and the digest shows headlines instead of summaries; in the AI mode new cards show their source's headline and are summarised when the month turns. Both modes still load. A banner says so.

## Data model, screens and settings

### Tables (SQLite)

| Table | Key columns |
| --- | --- |
| `mode` | id, name, icon, sort_order, layout (JSON), settings (JSON), created_at |
| `source` | id, mode_id, name, adapter, endpoint, api_key_ref (secure-store key name), role, lean, reader_mode, paywalled, include_sections, exclude_sections, refresh_minutes, enabled, priority, is_digest, config (JSON), last_ok_at, last_error |
| `article` | id, mode_id, source_id, canonical_url (unique per mode), title, summary, image_url, published_at, section, tags (JSON), tone, byline, word_count, embedding, cluster_id, body_html, fetched_at |
| `cluster` | id, created_at, centroid, has_primary, right_outlet_count, digest_summary |
| `impression` | article_id (unique), first_seen_at, session_id, surface (feed, second_source, digest) |
| `interaction` | id, article_id, kind (open, read, save, unsave, dismiss, more, less), at, dwell_seconds, max_scroll_pct |
| `second_source` | primary_article_id, other_article_id (nullable for confirmed no-match), angle_note, checked_at |
| `read_later` | article_id, saved_at, done_at |
| `feature_stat` | feature_key, positive_weight, negative_weight, updated_at |
| `llm_usage` | id, at, model, purpose, input_tokens, output_tokens, cost_usd |
| `setting` | key, value (JSON) for the settings shared by every mode. The News mode's own settings (ranking weights and thresholds, cold-start date, Latest first, Unfiltered, filter threshold, Pulse hidden words) live in its `mode.settings` |

`cluster`, `feature_stat`, `centroid`, `topic_rule`, `story`, `briefing` and `llm_usage` also carry `mode_id`. Tables keyed by article (`impression`, `interaction`, `read_later`, `second_source`, `match_pair`, `article_summary`) need none: an article belongs to one mode, so seen, Read later and History are per mode. The AI mode's own tables and columns are in the PRD's Data model.

### Screens

1. **Feed**: a mode bar (one chip per mode, with its unseen count) above the mode's own feed. The app opens on the last mode used. For News, tabs: For you (primary sources), Right, Outside, Following and More... (every headline from the other sources, newest first, with no ranking or filtering). Pull to refresh. Last-refreshed time in a line under the tabs. Tapping the Feed button while the feed is showing lists the categories; picking one shows only that category's cards in For you and Outside.
2. **Reader** (see Feed section).
3. **Read later**, for the current mode.
4. **History**, with search, for the current mode.
5. **Settings**: OpenRouter key; Sources (list with health dots, then a form per source for every field in the source record, plus Test, Add, Duplicate, Delete, and JSON import and export); second-source preference; model IDs; monthly budget and spend so far; refresh interval; Wi-Fi-only prefetch; text size; ranking weights and thresholds; Reset learning; Export database (shares the SQLite file); Debug. The Sources and Learning tabs have a mode picker at the top and show that mode's sources and learning; General, AI and budget, and Data are shared.
6. **Debug**: last 20 refresh runs with per-step timing and errors; recent clusters with member articles and similarity scores; recent match and digest decisions with the LLM's JSON.

Bottom tabs: Feed, Pulse, Read later, History, Settings. Feed, Read later and History show the current mode; Pulse covers News only, and its tab is hidden in other modes. There is no title bar. Settings is split into tabs: General, Sources, AI and budget, Learning, Data. Layout and gestures are identical on Android and iOS; platform differences are limited to the in-app browser and system share sheet.

## Acceptance criteria

The build is done when every item below passes on a real Android phone and on an iPhone installed through TestFlight. Items marked (test) also need an automated Jest test; items marked (e2e) need a Maestro flow.

### Build and deploy

- [ ] `eas build --platform android --profile production` plus `eas submit` puts a build on the Google Play internal testing track, and it installs on his phone from Play.
- [ ] `eas build --platform ios --profile production` plus `eas submit` puts a build in TestFlight, and it installs on his iPhone.
- [ ] The Maestro flows pass on the iOS Simulator and an Android emulator.
- [ ] An EAS Update with a JavaScript-only change reaches both phones without a new build.

### Sources

- [ ] First run seeds the default sources table, with the Guardian as the only primary source.
- [ ] Every field of every source, the Guardian included, can be edited in Settings, and changes apply at the next refresh. (test)
- [ ] Making BBC News primary and disabling the Guardian produces a For you feed of BBC articles only, with second sources and Right press still working. (e2e)
- [ ] Two primary sources at once produce a single merged feed. (test)
- [ ] Export then import of sources as JSON round-trips every field except keys. (test)
- [ ] Test on a source shows its first five items, or the error.
- [ ] A source with a broken endpoint shows a red dot, and the other sources still refresh. (test)

### Setup and refresh

- [ ] Fresh install asks for the OpenRouter key and a key for each enabled source that needs one (by default only the Guardian), and validates each with a test call.
- [ ] With keys entered, the first refresh fills the feed with primary articles from the last 24 hours within 60 seconds on Wi-Fi.
- [ ] Opening the app shows the cached feed in under 1 second, then refreshes.
- [ ] Background refresh runs on Android about every 30 minutes when the phone allows it, and on iOS whenever the system schedules it; Debug shows each run.

### Seen rule

- [ ] A card scrolled so that half or more of it is on screen is recorded as seen, even if on screen for a fraction of a second. A card that only peeks less than half into view is not. (e2e)
- [ ] After 10 minutes in the background, or pull-to-refresh, no seen article appears in the feed. (test)
- [ ] Within a session, scrolling back up still shows the cards already seen.
- [ ] An article seen as a second-source strip or in Right press never appears as a feed card. (test)
- [ ] Once a cluster has been seen, perspective-source articles in it do not appear for 72 hours; new primary-source pieces in it still do. (test)
- [ ] History lists every seen article from the last 14 days and its search finds them by headline.

### Reading

- [ ] Tapping a Guardian card opens the in-app reader with headline, byline, lead image, body text and inline photos.
- [ ] If extraction fails, the reader falls back to the adapter's body and thumbnail instead of an error. (test)
- [ ] A source with reader mode `browser` opens in Chrome Custom Tabs on Android and SFSafariViewController on iOS.
- [ ] The bookmark saves to Read later with undo; swipe right dismisses with undo; saved items open with images in airplane mode.
- [ ] Reading to 70% scroll marks a Read later item done and moves it to History.

### Second source and Right press

- [ ] On a day with a major political story, at least half of the top 10 primary cards show a second source, each with an angle note of 20 words or fewer.
- [ ] No second source is shown when the candidate is about a different event (spot-check 20 strips: no more than 1 wrong).
- [ ] Changing an outlet's lean in Settings changes whether it appears in Right press at the next refresh. (test)
- [ ] Right press shows only clusters with 2 or more right-leaning sources and no primary coverage, each with a summary, outlet links and a count. (test)

### Learning and cost

- [ ] After 30 More like this taps on one section, articles from that section move up the feed, and Why am I seeing this names it.
- [ ] 3 of every 20 feed slots are exploration items. (test)
- [ ] Reset learning returns ranking to cold-start behaviour, for the mode picked only.
- [ ] Settings shows this month's LLM spend from `llm_usage`. Setting the budget to $0.01 stops LLM calls and shows the banner, and the feed still loads. (test)
- [ ] No API key appears in logs, the app bundle, a sources export or an exported database.

## Modes

The full design is the PRD, [Modes and the AI mode](News%20Reader%20PRD%20Modes%20and%20the%20AI%20mode.md); the build's decisions are in [decisions.md](decisions.md) section 15. In brief:

- A mode is data: a row in `mode` with its name, icon, order, layout and settings, plus its own sources, item state and learning. Nothing in one mode changes another: signals, seen state, Read later, History and Reset learning are per mode. A further mode needs no code: a mode definition, sources using existing adapters, a layout and a starter profile.
- Two layouts. The **News layout** is this spec, unchanged, and is used by the News mode only. The **sections layout** is one scroll of section types; the AI mode shows "Stuff you're interested in" (ranked by relevance, 15 at a time) then "In other news..." (3 to 5 significant stories the profile would filter out, hidden when none qualify).
- Shared: the refresh run and its lock, the background task, adapters, the LLM client, the one monthly budget, 14-day retention, the reader and its Summary sheet, and the General, AI and budget, and Data settings.
- Adapters gain `hn_api` (Hacker News, with a points threshold and keyword prefilter) and `html_list` (titles, links and dates from a page with no feed). Digest sources are split into one item per linked story.
- The AI mode learns through per-tag and per-source weights (exponential moving averages of signals) and a readable interest profile the model rewrites weekly or every 50 signals, keeping the lines he pinned word for word.

## Decisions taken and open risks

### Decisions made in this spec (change any before the build)

| Decision | Why |
| --- | --- |
| React Native with Expo, TypeScript | One codebase for both phones, over-the-air updates, and the stack coding models are most reliable in. Flutter would also work now there is a Mac; Kotlin Multiplatform shares logic well but its iOS UI is less mature |
| Every source is data, with roles of primary or perspective | The Guardian can be swapped, joined or switched off with no code change |
| The default feed is the Guardian only; other outlets appear as second sources or in Right press | Matches "I always start with the Guardian" and keeps the feed from filling with tabloid volume |
| "On screen" means at least 50% of the card visible | Stops a sliver at the screen edge from burning a story |
| Seen cards stay put until the session ends | Otherwise cards vanish while scrolling back up |
| History screen added | A safety net for stories scrolled past by accident, given the strict seen rule |
| Second source picks the lean furthest from the primary | The point is a different perspective; with the defaults that means right-leaning outlets first |
| Paywalled articles open in the in-app browser | Uses the platform's browser session for subscriptions, with no login code in the app |
| No server | He reads on his phone only; refresh on open plus background tasks is enough. The sections pipeline is a self-contained module so it could move to a server later |
| Play internal testing on Android, TestFlight on iOS | Uses his existing developer accounts; updates install like any store app, with no public listing |

### Risks

- **iOS background refresh is sparse:** iOS decides when the task runs and may allow only a few runs a day. Mitigation: refresh on open is the main path, and the cached feed always shows first.
- **Economist sign-in on iOS:** SFSafariViewController keeps its own cookies, separate from Safari, so he signs in to the Economist once inside the app's browser. On Android, Custom Tabs share his Chrome session.
- **Guardian page changes:** photo extraction depends on theguardian.com page markup. Mitigation: API body and thumbnail fallback, and an extraction failure counter in Debug.
- **Feed URLs move or die:** sources are data, with health dots and a Test button. Endpoints marked "verified at build" in the default sources table must be checked by the builder and replaced with working ones before shipping.
- **The Times has no reliable RSS:** the Google News search source may lag or be incomplete. Acceptable for a second source.
- **Threshold tuning:** 0.70 and 0.82 are starting points. Expect to adjust them in the first week using the Debug screen.
- **Lean labels are judgement calls:** they are his settings, and the app never shows them as a rating of the outlet.
- **Native gaps:** if something needs a native capability Expo lacks, it is added as a local Expo module or config plugin, built on the Mac.

## Sources

- [Expo: Submit to the Apple App Store](https://docs.expo.dev/submit/ios)
- [Expo BackgroundTask reference](https://docs.expo.dev/versions/latest/sdk/background-task)
- [Expo BackgroundTask: iOS scheduling](https://docs.expo.dev/versions/v54.0.0/sdk/background-task/)
- [Guardian Open Platform](https://open-platform.theguardian.com/)
- [Guardian API forum: images removed from body text, May 2024](https://groups.google.com/g/guardian-api-talk/c/3pqUQfJ28iE)
- [Guardian Open Platform terms (copy on inkl)](https://www.inkl.com/news/terms-and-conditions-585d930a-46a2-4889-90d0-cf075865e192)
- [Economist RSS feeds, checked October 2026 (Feeder)](https://feeder.co/knowledge-base/rss-content/the-economist-rss-feeds/)
- [GB News RSS feed (Feeder)](https://feeder.co/id/discover/7926b0c6d0/gbnews-com)
- [Telegraph RSS feed (Feeder)](https://feeder.co/de/discover/617e0446b8/telegraph-co-uk)
- [OpenRouter embeddings API](https://openrouter.ai/docs/api/reference/embeddings)
- [OpenRouter: Claude Haiku 4.5 pricing](https://openrouter.ai/models/anthropic/claude-4.5-haiku-20251001)
