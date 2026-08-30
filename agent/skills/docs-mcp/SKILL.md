---
name: docs-mcp
description: >-
  Use when searching indexed library documentation through the docs-mcp MCP
  server, indexing or refreshing docs, scraping a documentation site, or reading
  a single web page via fetch_url. Covers the context-frugal search pattern,
  site probe ladder, scrape verification, and the CLI fallback.
---

# docs-mcp — shared documentation index

Self-hosted `@arabold/docs-mcp-server` at `https://docs-mcp.paragraph.red`,
reached through the `docs-mcp-server` entry in a project's `.mcp.json`. The index
is shared: a library is scraped once on the server, and every session searches
the same index. Never assume what is indexed — check first with `list_libraries`.
This skill deliberately lists no indexed libraries: such a list is stale data
the moment the index changes.

MCP tools: `scrape_docs`, `refresh_version`, `search_docs`, `list_libraries`,
`find_version`, `fetch_url`, and the job tools `list_jobs` / `get_job_info` /
`cancel_job`. (`read_libraries` and `read_jobs` duplicate the `list_*` tools.)

## Lookup: always digest, never dump

`search_docs` returns full page chunks — 7–30 KB per result. Dumping them into
context is the main failure mode of this server. The rules:

1. Call `search_docs` through `mcpScript` and return a digest: result URLs plus
   a ~200-char snippet each.
2. `limit: 1` (2 at most). Results are chunks of pages; a higher limit mostly
   returns the same URL several times.
3. Pick the right page from the digest. Read the full body only when the
   snippet is not enough — and then extract only the needed section by pattern
   inside `mcpScript`, never return the whole chunk.
4. When a raw result exceeds the adapter cap, it is spilled to a temp file and
   `r.data.omitted` is set. NEVER read a spill file whole — read slices with
   `offset` / `limit` and stop when the needed section is found.
5. Pin `version` to the major the project's `package.json` actually uses
   (for example `react` → `19`).

Digest pattern:

```js
const r = await tools.call("docs-mcp-server_search_docs", {
  library: "react", version: "19", query: "useSyncExternalStore getSnapshot caching", limit: 1,
});
const d = r.ok ? r.data : null;
if (!d) return { error: r.error };
const text = d.omitted
  ? `spilled to ${d.fullResultPath} — read with offset/limit only`
  : (d.content || []).map(b => b.text || "").join("\n");
const hits = [...text.matchAll(/Result \d+: (\S+)/g)].map(m => m[1]);
const snippet = text.replace(/\s+/g, " ").slice(0, 200);
return { urls: hits, snippet };
```

A disciplined lookup costs ~1–2 KB of context. An undisciplined one costs
10–30 KB, or more if a spill file is read whole.

## Indexing: probe the site's fetcher-friendly surface first

Before scraping any docs site, `fetch_url` three things: `<root>/llms.txt`,
`<root>/docs/llms.txt`, and one ordinary docs page (plus its `.md`-suffix
variant). The probe result picks the recipe, best surface first:

1. **Per-page `.md` links in llms.txt** — best search resolution (each chunk
   keeps its own page URL). Seed the crawl INSIDE the link subtree; the crawler
   probes root llms.txt itself and prefers `.md` variants for those links.
   Example: `pixijs.com/8.x/guides/`, scope subpages, maxPages 60.
2. **`llms-full.txt` single file** — for JS-shell sites whose llms.txt points to
   a full-docs dump. Scrape the file directly, scope subpages (keeps outbound
   doc links out of scope), maxPages 5. All chunks share the single file URL,
   so breadth verification must rely on topic-distinct prose, and queries must
   stay topic-specific because chunks can span adjacent doc sections.
   Example: `supabase.com/llms-full.txt`, version "2".
3. **Plain SSG HTML** (Docusaurus and similar) — page fetch returns real prose
   without llms.txt. Direct crawl. Examples: `redux.js.org` (maxPages 400),
   `react-redux.js.org` (maxPages 80), `react.dev`.
4. **Nothing fetchable** — repo sources (source-over-site, below).

Rules that apply to every scrape:

- **Version must be semver-shaped.** `latest` is rejected (`X`, `X.Y`, `X.Y.Z`).
  Pin the major from `package.json`.
- **Bound every scrape**: `scope: "subpages"` and an explicit `maxPages`.
- **Job monitoring**: `get_job_info` / `list_jobs` expose no progress numbers.
  Small jobs finish in ~30–60 s; a 400-page crawl runs minutes. The store is
  write-through — partial content is searchable while the job runs, so when a
  job seems slow, run one `search_docs` to prove liveness instead of restarting.
  Note: status text may be stale for a while after completion; re-read before
  concluding a job is stuck.
- `refresh_version` re-scrapes an indexed version, skipping unchanged pages.
  `remove_docs` is destructive — use it only when explicitly instructed, for
  example to clear a botched shallow index before re-scraping.

### Verify breadth after every scrape

1. Completion time is the first lie detector: a job that "completes" in seconds
   with a handful of pages on a large site is a shallow crawl (the crawler saw
   no links). Healthy crawls run tens of seconds to a few minutes — judge by
   indexed page count and snippet quality, not by a stopwatch.
2. Run 2–3 `search_docs` digests for topics that live on different pages. A
   crawl is good only if results return DISTINCT urls AND snippets contain real
   prose — not nav chrome like "skip to content". Single-file sources cannot
   return distinct urls; there the check is topic-distinct prose alone.
3. Distinct urls with empty shells mean the site serves a JS shell to the
   fetcher; the crawl is worthless, remove it and fall back.

## fetch_url

One page as Markdown, no indexing. Also the probe tool above. Subject to the
digest rules: prefer extracting what you need in `mcpScript` over returning the
whole page. Use it to preview a page before deciding to index its site.

## Source-over-site principle (fallback)

Static HTML sites are crawled directly. Sites with no fetcher-friendly surface
at all — no llms.txt, no `.md` variants, JS-shell HTML, hosts that 403 the
fetcher — are indexed from their REPOSITORY sources instead: markdown/mdx files
via `file://` or raw.githubusercontent.com. Most major libraries keep docs in a
repo (react.dev, supabase/supabase apps/docs, astro). Repo sources are
deterministic, git-versioned, and rendering-free. Raw GitHub one-off reads
work, but do NOT crawl raw URLs: mdx links are site-absolute and dead on the
raw domain.

## Site notes — hints, not authority

Site behaviors change (supabase.com gained `llms.txt` between probes). The
probe ladder decides what is true; these notes only say which probes are worth
running first. Observations below date from 2026-08-30.

- **supabase.com**: HTML pages are JS shells (`fetch_url` → "empty content"),
  per-page `.md` variants are empty, `/docs/llms.txt` 404s. Only the root
  `/llms.txt` exists and points to `llms-full.txt` — that is the indexable
  surface. Recipe: see llms-full above.
- **pixijs.com**: root `/llms.txt` lists guide `.md` links → per-page recipe.
  No API reference in the index: `pixijs.download` 403s the server fetcher and
  hosts the TypeDoc docs. For exact signatures use `node_modules/pixi.js`
  `*.d.ts` instead. Guide `.md` pages embed Sandpack JSX wrappers — minor chunk
  noise around real content.
- **Browser vs fetcher**: what a browser shows is manufactured client-side
  (JS execution) or gated per client (UA/TLS fingerprinting). "It works in my
  browser" predicts nothing about the plain fetcher — always probe.
- `--scrape-mode playwright` exists in the CLI but is rejected by design: a
  browser per page ruins the lightweight self-hosted premise (resources, speed,
  fragility). Do not propose it.
