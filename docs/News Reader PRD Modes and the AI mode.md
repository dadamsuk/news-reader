# News Reader PRD: Modes and the AI mode

Nov 24, 2026 · @David Adams

## Purpose and scope

The news-reader app gains **Modes**: separate reading feeds, each with its own sources, display and learning. Mode 1 is **News** (current behaviour, unchanged). Mode 2 is **AI**, a filtered feed for keeping up with AI from a software engineering and CTO point of view. The design must let further modes be added later without code changes to existing modes.

The AI mode has three hard requirements:

1. **Brief summary.** Each item gets a one-line summary, so David can decide in seconds whether it is worth reading.
2. **Learns.** It learns from what he reads, ignores and rates, and ranks accordingly.
3. **In other news.** Below the main section ("Stuff you're interested in"), an "In other news..." section shows significant items the learned profile would otherwise filter out.

This PRD extends the existing news-reader spec (`docs/spec.md`) and the build decisions (`docs/decisions.md`). It assumes their decisions: React Native + Expo, Android first and iOS-capable, Claude Haiku via OpenRouter for LLM calls and `text-embedding-3-small` for embeddings, phone-only unless a server is required, "seen" means at least half the card was on screen, seen items are never shown again (News's Latest first setting is the one exception, and it stays in News), read now / read later, History, and the card actions and gestures in use today.

**How conflicts were resolved.** Where this PRD needs something to make modes work, it changes the existing app, and the changes are listed in "Changes to the existing app" below. Where something here was not needed for modes and contradicted the existing app, the existing behaviour was kept.

## Modes

A mode is a self-contained feed defined by data, not by code branches. Nothing that belongs to a mode crosses into another mode.

**A mode definition holds:**

- Name, icon and display order.
- Its sources (each source belongs to exactly one mode; the same feed URL can be configured in two modes as two separate sources).
- Its processing settings: summary prompt, tag taxonomy, clustering threshold and window, scoring weights and thresholds, max age.
- Its layout (see Layouts).
- Its learning state: interest profile, tag and source weights, signal log (or, for the News layout, the existing feature stats and interest centroids).
- Its item state: seen, opened, hidden, read later, thumbs, History.
- Its mode-specific settings. For News these are the settings that exist today: ranking weights and thresholds, cold-start date, Latest first, Unfiltered, filter threshold, Pulse hidden words, mute and watch lists.

**Isolation rules:**

- Signals in one mode never change ranking in another.
- Seen state is per mode. A Guardian article about AI can appear in both News and AI if both modes have a source that produces it; seeing it in one does not hide it in the other.
- Read-later lists and History are per mode.
- Resetting learning in one mode leaves the others untouched.

**Shared infrastructure (not mode state):** the refresh run and its lock, background task, source adapters, LLM client, monthly LLM budget, retention (14 days), storage layer, in-app article reader (including its Summary sheet), and the General, AI and budget, and Data settings tabs.

### Layouts

A mode's layout is one of two types:

- **News layout.** The existing feed screen, unchanged: the For you, Not for you, Outside, Following and More... tabs, the category filter, the catch-up briefing card and second-source strips. It is not refactored into section types.
- **Sections layout.** A single scroll made of an ordered list of section types, each with its own settings. Section types in v1:
  - *Ranked feed*: clusters ordered by relevance.
  - *In other news*: high-significance, low-relevance clusters (see Display).

The AI mode uses the sections layout with Ranked feed ("Stuff you're interested in") then In other news.

**News-only features in v1.** Following, Full coverage, the catch-up briefing, mute and watch lists, Pulse, second-source strips, Not for you, Outside, More..., Latest first, Unfiltered and the "What the app has learned" screen belong to the News layout. They keep working exactly as now, on the News mode's data. They are not available in the AI mode in v1.

**Adding a mode later** means: create a mode definition, add sources using existing adapters (or write a new adapter), choose a layout (and, for the sections layout, its sections), and write a starter profile. No changes to existing modes.

### Switching and navigation

- **Mode bar.** A thin row of mode chips sits above the feed tabs, each with the mode's unseen count. Tapping a chip switches mode. The app opens on the last-used mode. There is still no title bar.
- **Bottom tabs stay as they are:** Feed, Pulse, Read later, History, Settings. Feed, Read later and History show the current mode. Pulse covers the News mode only.
- **Tapping Feed again** opens the category list in News, as now. In a sections-layout mode it scrolls to the top.
- **Settings.** The Sources and Learning tabs gain a mode picker at the top and show that mode's sources and learning. General, AI and budget, and Data are shared.

**Migration:** existing data and settings become the News mode with no change in behaviour.

## AI mode: sources

The AI mode starts with the sources below. Every source is configurable (add, remove, enable or disable, set refresh minutes and priority) from Settings, Sources with the AI mode picked, as in News. The builder confirms each feed URL; none are hard-coded.

| Source | Adapter | Digest? | Notes |
| --- | --- | --- | --- |
| Simon Willison's Weblog | `rss` | No | Engineering practice with LLMs |
| Latent Space | `rss` (Substack) | No | AI engineering, agents, infra |
| AINews (smol.ai) | `rss` or `html_list` | Yes | Daily roundup of Discord, Reddit and X discussion |
| TLDR AI | `html_list` or `rss` | Yes | Daily link roundup |
| Engineering Enablement (DX) | `rss` (Substack) | No | Research on AI and developer productivity |
| The Pragmatic Engineer | `rss` (Substack) | No | Paywalled, reader mode `browser`; free posts are readable through it |
| Interconnects | `rss` (Substack) | No | Models and research |
| Import AI | `rss` | No | Research and policy |
| Hacker News | `hn_api` | No | Front-page and best stories only; points threshold (default 150) plus AI keyword prefilter |
| Vendor news and changelogs | `rss` where available, else `html_list` | No | Anthropic, OpenAI, Google (Gemini/DeepMind), GitHub (Copilot), Cursor; list is editable |

**Source record.** AI sources use the existing source record (name, adapter, endpoint with one URL per line, api key, role, lean, reader mode, paywalled, include and exclude sections, refresh minutes, enabled, health). It gains:

- `mode_id`.
- `priority` (high / normal / low).
- `is_digest` (yes / no).
- `config` (JSON) for adapter options, for example the HN points threshold and keyword list.

Role and lean are used only by the News layout; AI sources are saved as `primary` with lean `centre`, and the AI form hides both fields.

**New adapters in v1:** `hn_api` (Hacker News API) and `html_list` (title, link and date extracted from a configured page, for sites with no feed). `rss` already covers RSS, Atom and Substack.

**Digest sources** (a single issue that links to many stories) must be split into one item per linked story, each with its own URL and the digest's blurb as context. One AINews issue must not appear as one item. The digest's own commentary on each story is kept as extra context for summarising.

**Source priority** (high / normal / low) sets which item becomes the primary link when several sources cover the same story. Original sources (vendor post, paper, repo) beat commentary, which beats digests.

## Ingestion and processing

Items are fetched and fully processed as they arrive, so the feed is ready whenever David opens it, whether that is daily or every few days. Opening the app never waits on fetching or LLM calls for items already processed.

**Where it runs.** In the existing refresh run: the background task (requested every 30 minutes), refresh on open and pull-to-refresh. One run processes every mode in turn, News first, under the existing refresh lock. The existing rules apply to the AI steps:

- Nothing a refresh awaits may depend on a JavaScript timer (decisions §3).
- A background run starts no new step after six minutes. Unfinished AI enrichment carries over to the next run.

The pipeline stays a self-contained module with no UI dependencies, so it can move to a small server later if background runs prove unreliable (see Open questions).

**Pipeline for a sections-layout mode:**

1. **Fetch.** Poll each source when its refresh minutes have passed. Store items as `article` rows in the mode. Dedupe on canonical URL, using the existing canonical rules, within the mode.
2. **Split digests.** Explode digest issues into one item per linked story.
3. **Prefilter (no LLM).** Drop items older than the mode's max age (AI default: 7 days), items already seen in this mode, and Hacker News items below the points threshold or failing the keyword prefilter.
4. **Embed and cluster.** Embed headline plus summary, as the existing embed step does. Same canonical URL joins immediately. Otherwise join a cluster from the last 72 hours when similarity to its centroid is at or above the mode's cluster threshold. The default is 0.75, the value tuned on real data for News (decisions §1). The cluster's primary item is chosen by source priority.
5. **Enrich (LLM, once per cluster).** One Haiku call returns: a rewritten plain headline (10 words max), a one-line summary (20 words max), a "why it matters to you" line (15 words max, written against the current interest profile), topic tags from the mode taxonomy, item type (release, research, how-to, opinion, business, policy, tool), a 0 to 1 profile match score and a 0 to 1 industry impact score. Read time is calculated from article length, not by the LLM.
6. **Score.** Compute relevance and significance (see Learning).
7. **Assign.** Place the cluster in a section, or hold it back (see Display).

**Late-arriving coverage.** When a new item joins an existing unseen cluster, add it as an extra source and recompute significance. Do not re-summarise unless the new item is higher priority than the current primary. A story can therefore move into "In other news" as coverage grows over a day or two.

**Summary style rules** (put these in the enrichment prompt): plain English, British spelling, no hype words ("groundbreaking", "game-changing", "revolutionary"), no exclamation marks, no em dashes, state what the thing is and what changed, include numbers when the source gives them.

**Cost control.** One LLM call per cluster, never per item. Batch calls where possible. The existing monthly budget covers all modes. At the cap, model calls stop until the 1st of the next month, as now. AI cards then show the source headline only, and clusters still unseen are enriched when the month turns.

## Display

The AI mode shows two sections in a single scroll: **Stuff you're interested in**, then **In other news...**. Only unseen clusters appear.

**Stuff you're interested in**

- Clusters with relevance at or above the mode threshold (default 0.5), ordered by relevance, with significance as the tie-breaker.
- Shows the top 15, then a "Show more" control that reveals the next 15. Items not yet revealed are not marked seen.

**In other news...**

- Always after the main section, with its own heading.
- 3 to 5 clusters (default 4; 5 during the first two weeks) with relevance below the threshold and significance at or above 0.6, ordered by significance.
- Each card carries a short reason label: "Widely covered", "Major release" or "Trending on HN", taken from whichever significance input scored highest.
- If nothing qualifies, the section is hidden rather than padded.

**Item card** (both sections, same layout):

- Headline (rewritten, 10 words max).
- One-line summary (20 words max).
- "Why it matters to you" line, main section only.
- Source name, "+N more" if other sources cover it, read time, age.
- "+N more" expands to the other sources' links.

**Card actions** are the same as on News cards:

- Tap: read now, in the in-app reader (or the in-app browser for paywalled sources).
- Bookmark: read later, with undo.
- Thumbs up and thumbs down buttons.
- Swipe right: hide, with undo.
- Swipe left: "Show me less like this, because…" (this source, or these topics), with undo.
- Long press: the menu with More like this, Less like this, Why am I seeing this, Share link. "Why am I seeing this" shows the profile lines and tag weights that drove the score.

**Seen and expiry**

- A card is seen once at least half of it has been on screen (the existing rule). Seen cards stay in place for the rest of the session, then never appear again in this mode, except in Read later and History.
- Unseen clusters expire after the mode's max age (AI default: 7 days) unless significance is 0.8 or above, which extends them to 14 days. This stops a long backlog building up when the app isn't opened for a while.
- Held-back clusters (below both thresholds) are never shown and expire silently. They stay in the database for learning and debugging until the shared 14-day retention removes them.

**Read later** and **History** are the existing bottom tabs, showing the current mode's items.

## Learning

Each sections-layout mode learns from implicit and explicit signals through two layers: fast numeric weights that update on every signal, and a readable interest profile that an LLM rewrites periodically and David can edit. All of it is scoped to the mode. The News mode keeps its existing learning model unchanged.

**Signals** (weights are starting values, all tunable in mode settings):

| Signal | Weight | Applies when |
| --- | --- | --- |
| Thumbs up, or More like this | +1.0 | Any time |
| Read later | +0.7 | Added to list |
| Read to end, or read time over 60% of estimate | +0.6 | In-app reader, with the existing 5-second floor |
| Opened | +0.4 | Tap to read |
| Opened a "+N more" source | +0.2 | Expanded and tapped |
| Seen, not opened (including hidden) | -0.15 | When the session ends, as in News |
| Thumbs down, or Less like this | -1.0 | Any time |
| Less like this, because… | -1.0 on the named source or tags only | Swipe left |

In the "In other news..." section, the "seen, not opened" weight is multiplied by 0.2. Ignoring a left-field item is expected and must barely count; otherwise the section shrinks to nothing.

**Layer 1: fast weights.** Per-tag and per-source weights, updated on every signal as an exponential moving average (default alpha 0.1). A signal on a cluster updates every tag on that cluster and the primary source.

**Layer 2: interest profile.** A markdown document per mode with four headings: *Interested in*, *Not interested in*, *Sources I value*, *Notes*. An LLM rewrites it from the signal log weekly, or after every 50 new signals, whichever comes first. The profile is editable in the app. Lines David writes or edits are marked as pinned; the rewrite must keep pinned lines word for word and may only add to or adjust unpinned ones. Each rewrite is versioned, and the previous version can be restored.

**Relevance score** (0 to 1):

```latex
relevance = 0.6 \cdot profile\_match + 0.4 \cdot \sigma(\overline{tag\_weights} + source\_weight)
```

profile\_match comes from the enrichment call; σ is a logistic squash to 0 to 1. Because profile\_match is set at enrichment time, unseen clusters are re-scored against a new profile after each rewrite or edit, using a cheap batched call.

**Significance score** (0 to 1), independent of the profile:

- Number of distinct sources in the cluster (saturating at 5).
- Hacker News points, if present.
- Major release from a high-priority vendor source.
- LLM-judged industry impact (0 to 1), returned by the enrichment call.

Combine as a weighted sum; starting weights 0.35 / 0.2 / 0.2 / 0.25.

**Graduation from left field.** If David opens 3 or more "In other news" items sharing a tag within 30 days, that tag's weight is raised by one step and the next profile rewrite is told to consider it. This is how new interests move into the main section.

**Cold start.** The AI mode ships with a starter profile (below) for David to edit. For the first two weeks, "In other news" shows 5 items and the relevance threshold is 0.4, to gather signals faster.

**Transparency and control.** Settings, Learning, with the AI mode picked, shows the current profile (editable), top and bottom 10 tag weights, the last 50 signals, and a "Reset learning for this mode" action with confirmation. With News picked it shows the existing "What the app has learned" screen and Reset learning, which now resets News only.

**Starter profile for the AI mode** (a draft for David to correct before first run):

- *Interested in:* AI-assisted software engineering practice; coding agents and tools; evidence on AI and developer productivity; AI adoption in engineering organisations; model releases that change capability or cost; vendor pricing, licensing and terms changes; AI security, governance and data handling in companies; building and running LLM features in production.
- *Not interested in:* consumer AI gadgets; funding rounds under $100M; prompt-tip listicles; AI image and video generation for creative use.
- *Sources I value:* (empty; learned)
- *Notes:* reads as a software engineer and as a CTO, so both hands-on detail and organisational implications matter.

## Data model

Modes extend the existing SQLite tables (`src/db/db.ts`) through a numbered migration, rather than adding a parallel set. Every mode-owned row is in exactly one mode, and every query filters on it. That is how the isolation rules are enforced, not by convention in the UI.

**Mode ownership.** A new `mode` table holds id, name, icon, order, layout (json), settings (json) and created\_at. The migration creates the News mode and the AI mode.

- `source`, `cluster`, `feature_stat`, `centroid`, `topic_rule`, `story`, `briefing` and `llm_usage` gain `mode_id`. Existing rows get the News mode.
- `article` gains `mode_id`. Its unique key becomes (`mode_id`, `canonical_url`), so the same URL can be stored once per mode.
- Tables keyed by article (`impression`, `interaction`, `read_later`, `second_source`, `match_pair`, `article_summary`) need no new column. An article row belongs to one mode, so seen, read-later and History state are already per mode.
- Global settings stay in `setting`. The settings listed under "A mode definition holds" move into the News mode's `settings`.

**New and extended columns for sections-layout modes:**

| Table | Columns | Notes |
| --- | --- | --- |
| `source` | priority, is\_digest, config (json) | config holds adapter options, e.g. HN points threshold |
| `article` | digest\_context, hn\_points | one row per story after digest splitting |
| `cluster` | primary\_article\_id, headline, summary, why\_it\_matters, tags, item\_type, profile\_match, impact, relevance, significance, section, expires\_at, enriched\_at | the unit shown on a card |
| `interaction` | weight, section | the signal log; feeds learning |
| `tag_weight` (new) | mode\_id, tag, weight, updated\_at | layer 1 |
| `source_weight` (new) | mode\_id, source\_id, weight, updated\_at | layer 1 |
| `profile` (new) | id, mode\_id, version, markdown, pinned\_lines (json), created\_by (llm or user), created\_at | layer 2, versioned |

The schema stays portable so the pipeline module can run against a server database later.

## Non-functional requirements

- **Speed.** Opening a mode shows processed cards in under 1 second. Catch-up processing never blocks the UI.
- **Cost.** One LLM call per cluster. The single monthly budget covers all modes, default raised from $10 to $15 (the AI mode adds an estimated $4 to $8 a month to News's $5 to $6). Settings shows this month's spend in total and per mode.
- **Privacy.** Any data from inside the app may be sent to the model, including reading history, signals and the interest profile. API keys and other secrets never are. Signals, profiles and item state are stored only on the device (or David's own server if the pipeline moves). No third-party analytics.
- **Resilience.** A failing source shows red in Settings and is retried at the next run; it never stops the others. A failed enrichment leaves the card with the source headline and is retried at a later run. No retry waits on a timer.
- **Configurability.** All thresholds, weights, intervals and max ages live in mode settings, not in code.

## Changes to the existing app

These are needed for modes and replace the corresponding parts of `docs/spec.md` and `docs/decisions.md`:

- **Privacy rule.** The spec's "no reading history or personal data leaves the phone" becomes "nothing secret leaves the phone" (see Non-functional requirements). The test asserting that only headlines and article text are sent becomes a test that no API key is sent.
- **Default monthly budget** rises from $10 to $15. Spend is recorded per mode.
- **Schema** gains modes as described in Data model. The canonical URL is unique per mode, not across the app.
- **Settings** that today are global move into the News mode's settings (see "A mode definition holds"). Reset learning resets one mode.
- **The main screen** gains the mode bar above the feed tabs. Read later and History show the current mode's items.
- **The refresh run** processes each mode in turn.
- **Docs.** `docs/spec.md` and `docs/decisions.md` are updated in the same change that ships modes, so neither still states a rule this PRD replaces (for example the old privacy rule or the $10 budget).

## Out of scope for v1

- Email-only newsletters (sources with no feed or web archive).
- Full text from paywalled sources; link and preview only.
- Any cross-mode feature: combined feeds, combined read-later, shared learning.
- News-only features (see Layouts) in other modes.
- Sharing, desktop app, notifications.

## Acceptance criteria

- [ ] Existing News behaviour is unchanged after migration to the News mode.
- [ ] A third mode can be added through configuration alone, using existing adapters, layouts and section types.
- [ ] A thumbs-down in AI mode changes no weight, profile or ranking in News mode, and the reverse.
- [ ] Seeing an item in one mode does not mark it seen in another.
- [ ] Read later and History show only the current mode's items.
- [ ] A digest issue with 12 linked stories produces 12 items, not 1.
- [ ] The same story from 3 sources shows as one card with "+2 more".
- [ ] Every card has a headline of 10 words or fewer and a summary of 20 words or fewer.
- [ ] "In other news..." always sits below the main section, shows 3 to 5 items, and is hidden when nothing qualifies.
- [ ] Ignoring "In other news" items for 2 weeks does not stop the section appearing.
- [ ] Opening 3 left-field items with a shared tag raises that tag's weight.
- [ ] Pinned profile lines survive an LLM profile rewrite word for word.
- [ ] With the app closed for 3 days, opening it shows a processed feed with no expired items.
- [ ] At the monthly budget cap, AI cards show source headlines and both modes still load.
- [ ] No API key appears in any model request.
- [ ] `docs/spec.md` and `docs/decisions.md` match the shipped behaviour, with every item in "Changes to the existing app" reflected in them.

## Open questions

- [ ] Is an on-device background task reliable enough for "as items arrive", or should the pipeline run on the Hetzner server with the phone syncing? Recommend: start on-device, measure for 2 weeks, move if catch-up on open is regularly slow.
- [ ] Should email-only newsletters (e.g. TLDR AI or AlphaSignal if they have no archive) be ingested via a forwarding mailbox in v2?
- [ ] Should paid sources David subscribes to (The Pragmatic Engineer, Every) be read in full through his logged-in session in the in-app reader?
- [ ] Is 15 cards before "Show more" right for a feed checked every few days?
