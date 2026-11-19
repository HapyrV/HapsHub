# Explore tab: research and feature list (item 14)

Research date: 2026-11-19. Goal: replace the Worlds "Search" sub-tab with an "Explore" sub-tab that covers all
VRChat worlds, with filters, and holds the search bar. Build only what the user picks from the list below.

## What HapsHub has today

- Worlds sub-tabs: Favorites, Discover (Popular = `sort=popularity`, Discover = `sort=heat`), Recently Visited,
  My Worlds, Search.
- Search: name text + sort (Relevance, Popularity, Updated, Created, Shuffle), `n` + `offset` paging
  (`Services/VRChatAPI/WorldAPI.cs:416`).
- API rules already in place: every VRChat call sends `AppInfo.UserAgent` (`VRChatApiService.cs:73`), goes through
  `BackoffHandler` (429 back-off), and world objects are kept in an LRU cache (`WorldAPI.cs`).

## What the community asks for

| Theme | Where | Size / date |
|---|---|---|
| World ratings (thumbs or stars), "top rated" list | Canny "World ranking system" | 2.3k votes, since 2018; most-voted world request |
| Discovery sends everyone to the same old worlds; boosted by instance spam | Canny "World Discovery is Terrible" | 116 votes, Dec 2025 |
| More sorts (Hot, Highest rated, Most visited), categories, tag filtering, a "visited" mark, time decay on Trending | same thread, comments | Dec 2025 - Aug 2026 |
| Hide worlds, tags or authors (photosensitive/epilepsy reasons, low quality) | Canny "Ability to hide tags/worlds/authors" | 17 votes, 2023, comments to Nov 2026 |
| Language filter ("show worlds where French is spoken") | Canny "Visibility of language communities" | 41 votes, Apr 2025 |
| Quest-compatible filter while on PC | Dev stream Q&A, 29 May 2026 | VRChat: "would love more filtering options" |
| "Currently active" filter; too many empty worlds | ask.vrchat.com "hard to find actually active worlds" | 2025-26 |
| Trending should decay; drop worlds older than a year; separate Active PC / Cross-platform; pick the default category; saved searches; shareable lists; staff favorites | ask.vrchat.com "World Categories Discussion" (after Derafrog's YouTube video) | Aug 2024 |
| Follow curators, shareable themed lists | Canny "World Curators" | 10 votes, Feb 2026 |
| Filter by "published" in world list | Canny open-beta 1236 | - |
| Favorites cap (400, 800 with VRC+) is too small | several threads | - |

Context: on 28 Oct 2026 VRChat declined AI-content labels and filters, and announced private thumbs up/down
ratings for late 2026 / early 2027. Ratings are not in the API yet, so HapsHub cannot show VRChat ratings.

Not reached: Reddit blocks the fetch tool, so Reddit threads are missing; YouTube only through the forum summary of
Derafrog's video. The themes above repeat across every source that was reachable.

## What the API allows (GET /worlds, unofficial docs at vrchat.community)

- `search`, `sort` (popularity, heat, trending, favorites, publicationDate, labsPublicationDate, updated, created,
  random/shuffle, relevance, name, ...), `order`, `n` (max 100), `offset`.
- `tag` (any of, comma list) and `notag` (exclude, comma list): covers content warnings (`content_horror`,
  `content_gore`, `content_adult`, `content_sex`, `content_violence`, `content_combat`), Labs (`system_labs`),
  approved (`system_approved`), games (`author_tag_game`), avatar worlds (`author_tag_avatar`), any author tag.
- `platform` / `noplatform` (`standalonewindows`, `android`, `ios`), `featured`.
- `GET /config` -> `dynamicWorldRows`: the rows VRChat itself shows in game (Spotlight, New & Noteworthy, Games, ...).
- World objects carry `occupants`, `capacity`, `favorites`, `visits`, `publicationDate`, `labsPublicationDate`, tags.

Filters the API does not have (published date range, capacity, people now, visited, hidden) run on the results
HapsHub already fetched. A page can then come back short; "load more" fetches the next page, capped so one click
never sends more than a few requests.

## API rules (VRChat Creator Guidelines, API section)

User-Agent "name/version contact"; stop on 429; rate-limit and back off; cache; no calls on fixed clock intervals;
never store login data; never act for another user. Explore adds: search on Enter (no search-as-you-type),
no auto-refresh timer, cache per (query + filters) for a few minutes, `n` <= 100.

## Feature list (pick what to keep)

Browse
1. VRChat's own rows from `/config` (Spotlight, New & Noteworthy, Games, Avatar worlds, ...).
2. More sorts: Trending, Hot, Newly published, Community Labs, Most favorited, Random.
3. Active now: show/sort by people in the world now; mark worlds where friends are.
4. Saved searches: name a set of filters, reuse it, choose which one Explore opens on.

Filters
5. Platform: Quest/Android-compatible, PC-only, iOS.
6. Content: hide content-warning tags (horror, gore, adult, ...); include/exclude any tag.
7. Age and size: published within N days, hide worlds older than N years, capacity range.
8. Language: best effort through author tags and name/description words (VRChat has no language field).

Personal (stored locally, never sent to VRChat)
9. "Visited" badge and a "hide visited" switch (from HapsHub's own visit history).
10. Hide list: hide one world, every world by an author, or a tag.
11. Private like / dislike: dislike hides, like goes to a "Liked" list. Not shared.
12. Share a world list as a file or code to import (curator-style lists).

Layout
13. Discover sub-tab: merge it into Explore (Popular/Discover become rows or sorts) or keep it separate.

## User's picks (2026-11-19)

- Browse: all of 1-4 (user: "refer to public opinion"), plus a new **For You** view built from the tags of worlds
  the user visits.
- Filters: all of 5-8, plus **HapsHub's tag chips** (Chill, Flowers, Photography, ...). These are the worlds'
  `author_tag_*` tags, already shown in the world modal and the Favorites tag filter (`worlds.js:150`). The API
  filters on them server-side (`tag=author_tag_chill`), so they work over all of VRChat, not just one page.
- Personal: all of 9-12, plus an **AI filter** (asked as a question; design below).
- Discover: merge into Explore. Popular = `sort=popularity`, Discover = `sort=heat` become sorts/rows.

## Design: For You (dynamic feed)

What the community asks for in a feed: not only popularity; newer worlds get a fair chance (Trending decay, drop
worlds older than a year); private, positive-leaning signals; interest clusters; no filter bubble.

- Tag profile: count `author_tag_*` tags of visited worlds, weighted by time spent there (where the visit history has
  it) and by recency (half-life ~30 days). Favorites and "like" add weight; "dislike" and hidden worlds subtract.
- Candidates: one request per top tag (top 5 tags, `tag=author_tag_x&sort=heat&n=50`), cached 30 minutes, fetched
  only when the user opens For You or presses Refresh. Five requests at most per refresh.
- Score: tag overlap with the profile, x freshness (newer `publicationDate` scores higher), + a small
  log(favorites) term so quality still counts without letting the same old worlds win.
- Mix: at most 2 worlds per author; about 1 in 5 cards is an "explore" pick from a tag next to the user's tags or a
  new world, so the feed does not shrink to one theme.
- Excludes: visited (switchable), hidden, disliked, AI-marked when the AI filter is on.
- Each card says why it is there ("Because you like Chill, Photography").
- Not enough history yet (fewer than ~5 tagged visits): show Trending and say so.

## Design: AI filter

VRChat has no AI label in the API and declined to add one (28 Oct 2026). HapsHub can still do this locally:

- Text check: the world's author tags, name and description are matched against words such as "ai generated",
  "made with ai", "midjourney", "stable diffusion", "dall-e", tag `ai`. Phrases like "no ai" / "human made" count as
  the opposite. Result: a small "Maybe AI" badge, never stated as fact.
- My marks: right-click a world -> "Mark as AI" (local); optional "also all worlds by this author".
- Filter: Show all / Hide "Maybe AI" and my marks / Hide only my marks.
- Shared lists (feature 12) can carry AI marks, so friends can pass lists around.
- Not done: guessing from thumbnails with an image model. It would be slow and often wrong, and wrong labels are the
  harassment risk VRChat cited.

## Build order (one commit per step, tests in round6-test.mjs, i18n in 9 locales)

1. Explore view: replace Search, merge Discover; search bar, all sorts, paging, per-query cache. **Done 2026-11-19.**
   Views: Active now and Discover (live instance lists, as before), then GET /worlds with Hot (heat), Trending,
   Popular, New (publicationDate), Community Labs (labsPublicationDate + system_labs), Most favorited, Random
   (shuffle), and Best match (relevance, only with text). 40 per page; C# keeps each page 3 min, the page keeps a
   view 5 min; Refresh skips both. Text in a live view narrows it locally; Search there moves to Best match.
   Not checked signed in yet: whether VRChat honours `sort=trending` and `sort=favorites` (a 400 shows
   "Could not load worlds").
2. Filters: platform, content warnings, tag chips include/exclude, age, capacity, language. **Done 2026-11-19.**
   Sent to VRChat (part of the cache key): platform (`platform=android`; PC only = `platform=standalonewindows`
   + `noplatform=android`; `platform=ios`), `tag` = chips marked "only" (any of), `notag` = hidden warnings
   (`content_sex/adult/violence/gore/horror/other`) + chips marked "hide". C# passes on only `author_tag_*` and
   `content_*` tags, sorted, 20 at most. The page checks the same filters again on what comes back (and that Labs
   results still carry `system_labs` when chips widen the tag list), so live views are filtered too.
   Checked here only: published within 7/30/90 days or 1/2/3/5 years (`publicationDate`, else `created_at`),
   capacity min/max, language (author tags, script, common words; Latin text with nothing else = English).
   When filters hide most of a page, the next page is fetched too: three requests per click at most, then Load
   more. "New" stops paging once it is past the Published limit. Chips: the user's favorite and visited worlds'
   author tags, most common first (visited list asked for once when Explore opens). Filters persist
   (localStorage `vrcn_exploreFilters`). Not checked signed in: how VRChat combines several `tag` values.
3. Local store + personal tools: visited badge, hide list, like/dislike.
4. Active now (people in the world, friends there).
5. VRChat rows from `/config`, saved searches, default view.
6. AI filter.
7. For You.
8. Share list export/import.

## Sources

- https://feedback.vrchat.com/feature-requests/p/world-ranking-system
- https://feedback.vrchat.com/feature-requests/p/world-discovery-is-terrible-prevents-monetization-and-discourages-effort
- https://feedback.vrchat.com/feature-requests/p/ability-to-hide-tagsworldsauthors-from-worlds-tab
- https://feedback.vrchat.com/feature-requests/p/improving-the-visibility-of-language-communities-eg-french-speakers-in-vrchat
- https://feedback.vrchat.com/feature-requests/p/world-curators
- https://feedback.vrchat.com/open-beta/p/1236-add-filter-by-published-in-world-list
- https://ask.vrchat.com/t/world-categories-discussion/26007
- https://ask.vrchat.com/t/may-29-developer-stream-q-a-summary/48500
- https://ask.vrchat.com/t/can-we-talk-about-how-hard-it-is-to-find-actually-active-worlds-lately/44450
- https://mixed-news.com/en/?p=38727 (ratings announcement, AI labels declined)
- https://vrchat.community/openapi/search-worlds , https://vrchat.community/tags/world , https://vrchat.community/reference/get-config
- https://hello.vrchat.com/creator-guidelines (API section)
