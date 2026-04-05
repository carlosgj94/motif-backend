# Content Parser Modules

This directory contains the modular parser stack that sits behind
`../content_processor.ts`. The goal is to keep parser behavior decomposed into
stable layers so we can add provider-specific heuristics without growing another
monolith.

## Module Boundaries

- `config.ts` Shared parser limits, environment-backed knobs, and trusted-host
  lists.
- `model.ts` Canonical parser types and `ProcessingFailure`.
- `detect.ts` Lightweight route detection from fetched document context.
- `fetch.ts` Safe network access, redirect validation, archive mirror fallback,
  byte-limited reads, and conditional HTML revalidation with `ETag` and
  `Last-Modified`.
- `normalize.ts` Pure DOM and metadata helpers. This is where generic
  normalization logic belongs.
- `generic_article_heuristics.ts` Multi-candidate generic extraction, cleanup,
  and scoring for long-form articles.
- `generic_article_fallback.ts` Shared generic fallback builder for provider
  adapters that need generic article recovery without duplicating metadata and
  lead-block cleanup.
- `generic_article_metadata.ts` Generic article presentation heuristics for
  excerpt selection and article-level cover-image ranking.
- `compact_body.ts` Deno-side mirror of the Rust compact-body projection used
  for parser diagnostics and fixture review tooling.
- `diagnostics.ts` Shared parser diagnostics builders for byte-budget visibility
  and candidate summaries, including storage bounding for persisted diagnostics.
- `recovery.ts` Low-confidence recovery decisions for parses that should be
  routed into a stronger fallback path later.
- `aggressive_article_recovery.ts` Stronger static article extraction used by
  the recovery worker when the first parse was weak but a full rendered fallback
  is not justified yet.
- `static_recovery.ts` Shared static recovery pipeline that evaluates whether an
  aggressive article reparse is strong enough to persist or should be dismissed
  for a future stronger strategy.
- `recovery_quality.ts` Shared comparison rules for deciding whether a recovery
  parse is materially better than the currently stored parse.
- `rendered_fetch.ts` Remote renderer contract for the rendered recovery worker.
- `rendered_recovery_gate.ts` Conservative escalation logic from static recovery
  into rendered recovery.
- `rendered_recovery.ts` Shared rendered recovery pipeline that reparses a fully
  rendered HTML document through the normal registry and evaluates whether that
  result is strong enough to persist.
- `article_quality.ts` Cross-adapter article quality scoring and
  provider-versus-generic selection policy.
- `live_blog_heuristics.ts` Live-blog specific extraction for summary cards,
  bounded update selection, and linearized device-first output from newsroom
  live pages.
- `bloomberg_article_heuristics.ts` Bloomberg-specific extraction, cleanup, and
  source-aware fallback selection for direct pages and archived mirrors.
- `substack_article_heuristics.ts` Substack-specific route detection support,
  payload-aware extraction, and device-first cleanup for newsletter posts.
- `archive_source_heuristics.ts` Archive host delegation layer for applying
  source-specific extractors after the mirror snapshot has been isolated. This
  is where archived Bloomberg, archived Substack, and generic archived articles
  should diverge.
- `x_content_heuristics.ts` X-specific extraction and normalization for posts,
  threads, and long-form single-post content.
- `x_syndication.ts` Normalization of official public X syndication payloads
  into parser-friendly post and article signals.
- `registry.ts` Maps a detected route to an adapter.
- `adapters/*.ts` Provider or route specific extraction logic that returns
  `ProcessedContent`.

## Current Flow

1. `content_processor.ts` fetches HTML through `fetchDocument(...)`.
2. `parseFetchedDocument(...)` in the facade injects shared helpers like favicon
   plus X oEmbed and syndication fetchers.
3. `registry.ts` selects an adapter based on `detectContentRoute(...)`.
4. The adapter uses pure helpers from `normalize.ts` and returns a
   `ProcessedContent`, including parser diagnostics for review tooling.
5. The facade persists the normalized result, bounded parser diagnostics, fetch
   validators, parser quality score, parser recovery state, and links the
   content to a discovered source when possible.
6. If the stored parse is still weak, the facade enqueues `content_recovery`
   with `parser_recovery_stage = 'static'`.
7. The static recovery worker runs `static_recovery.ts` against a stronger
   static article strategy.
8. Only high-priority, JS-heavy article failures can be escalated through
   `rendered_recovery_gate.ts` into the separate rendered recovery queue.
9. The rendered recovery worker calls `rendered_fetch.ts`, reparses the fully
   rendered HTML through the normal registry, and persists it only if that
   result is materially better than the stored parse.

For article-like routes, adapters may now compare a provider-specific result
against a generic fallback through `article_quality.ts`. The intended policy is:

- keep provider-specific extraction when it is already clean enough
- switch to generic only when the provider result is clearly weaker
- strip low-value lead blocks from generic fallback output before comparison

## Adapter Contract

Each adapter should:

- accept `FetchDocumentResult` plus optional injected helpers
- avoid direct network calls unless the adapter explicitly needs one
- use `buildBaseUpdate(...)` so parse failures can still persist useful metadata
- return `parserName` and `parserVersion` on every success
- return `parserDiagnostics` on every success, even if the candidate list is
  minimal for that route
- keep provider-specific heuristics in the adapter, not in `registry.ts`

Adapters should not:

- reach into Supabase persistence or queue logic
- duplicate fetch validation logic from `fetch.ts`
- silently swallow parse failures that should produce a tracked
  `ProcessingFailure`

## Where To Put New Logic

- Add a new adapter when the page shape or provider needs custom extraction
  behavior.
- Add to `detect.ts` only when the route decision itself changes.
- Add to `normalize.ts` only for reusable DOM/metadata transforms that are not
  provider-specific.
- Add to `generic_article_metadata.ts` when generic article output needs smarter
  ranking of multiple metadata signals, such as excerpt or cover-image choice.
- Add to `generic_article_fallback.ts` when provider adapters need a shared
  cleanup step for generic recovery, especially around duplicated excerpt/title
  lead blocks.
- Add to `compact_body.ts` only when the Rust compact-body contract changes and
  the Deno-side review tooling must stay byte-for-byte aligned.
- Add to `diagnostics.ts` when parser review needs better byte-budget
  visibility, candidate summaries, warning thresholds across routes, or tighter
  persisted-diagnostics bounds.
- Add to `recovery.ts` when low-confidence routing rules should change. Keep
  recovery decisions centralized there instead of spreading threshold checks
  across adapters or persistence code.
- Add to `aggressive_article_recovery.ts` when the static recovery worker needs
  stronger DOM cleanup, denser container recovery, or better article-only
  fallback extraction without changing the normal parser path.
- Add to `static_recovery.ts` when recovery acceptance thresholds or
  persist-versus-dismiss decisions change. Keep those rules there rather than
  burying them inside the queue worker.
- Add to `recovery_quality.ts` when both static and rendered recovery should
  inherit the same “materially better” policy.
- Add to `rendered_fetch.ts` when the renderer request or response contract
  changes. Keep the renderer protocol isolated there.
- Add to `rendered_recovery_gate.ts` when escalation policy changes. Keep
  rendered escalation conservative and centralized.
- Add to `rendered_recovery.ts` when the rendered worker needs better
  accept/reject logic after a fully rendered page has been parsed.
- Add to `article_quality.ts` when the system needs better cross-adapter
  ranking, fallback thresholds, or cleanliness penalties that should apply
  beyond one provider.
- Add to `live_blog_heuristics.ts` when newsroom live pages need better summary
  extraction, update selection, or per-update cleanup without polluting the
  generic article path.
- Add to `bloomberg_article_heuristics.ts` for Bloomberg-only cleanup, body
  extraction, or metadata recovery, including cases that also need to work when
  Bloomberg is seen through an archive mirror.
- Add to `substack_article_heuristics.ts` for Substack-only cleanup or payload
  extraction, especially when a custom domain should still route to the
  provider-specific adapter.
- Add to `archive_source_heuristics.ts` when a mirrored host should delegate to
  a source-specific extractor instead of staying on the generic archive path, or
  when archive-root cleanup needs to preserve enough structure for those
  provider heuristics to work.
- Add to `x_content_heuristics.ts` for X-specific post/thread/article
  normalization, especially when combining visible markup with embedded payload
  scripts or remote enrichment.
- Add to `x_syndication.ts` when official public X payload formats change and
  need a normalized mapping layer.
- Keep `content_processor.ts` thin. It is a compatibility facade and
  orchestration layer, not the place for new extraction heuristics.
- Keep `If-None-Match` / `If-Modified-Since` handling centralized in `fetch.ts`.
  Adapters should never assemble conditional request headers themselves.

## Tests

The parser regression corpus lives in `../../../../tests/fixtures/content`.

- Deno parser replay tests exercise
  `raw.html -> parseFetchedDocument(...) -> expected.parsed.json`.
- Rust compact-body tests exercise
  `expected.parsed.json -> build_compact_content_body(...) -> expected.compact.json`.

The fixture corpus now includes `live_blog` captures for newsroom live pages.
Those fixtures are especially important because route detection and content
quality depend on structured summary blocks plus bounded update selection, not
just generic article extraction.

There is now a Deno-side compact-body parity test as well. That exists so parser
diagnostics can report compact-body byte sizes without drifting away from the
Rust device projection.

When parser behavior changes intentionally:

1. update or add a fixture
2. document the reason in the fixture `notes.md`
3. keep the adapter/facade split intact unless the change is architectural

## Review Tooling

Use these local commands when reviewing parser changes:

```bash
deno run --config supabase/functions/deno.json --allow-read=tests/fixtures/content \
  scripts/review_content_fixture.ts live_blog/guardian_cop30
```

This prints the selected parser strategy, byte-budget usage, candidate scores,
and the first compact blocks for one fixture.

```bash
deno run --config supabase/functions/deno.json --allow-read=tests/fixtures/content \
  scripts/report_parser_fixture_scores.ts
```

This prints a JSON report for the full fixture corpus with parser, strategy,
compact bytes, warnings, and selected candidate score for each fixture.

```bash
deno run --config supabase/functions/deno.json --allow-env --allow-net \
  scripts/review_stored_content.ts <content-id-or-url>
```

This prints the stored parser diagnostics and compact-body preview for a real
row from `public.content`, using `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
It also shows the stored `ETag`, `Last-Modified`, parser quality score, and
parser recovery state.

```bash
deno run --config supabase/functions/deno.json --allow-env --allow-net \
  scripts/report_stored_parser_diagnostics.ts 50
```

This prints a JSON summary over recent stored rows with persisted diagnostics,
including warning counts, selected strategy, byte-budget usage, and the stored
parser quality score.

```bash
deno run --config supabase/functions/deno.json --allow-env --allow-net \
  scripts/report_parser_recovery_candidates.ts 50
```

This prints the rows currently marked with `parser_recovery_status = 'needed'`,
including recovery priority and reasons. Rows that were already processed by the
static recovery worker move to `succeeded`, `failed`, or `dismissed`.

## Recovery Workers

The recovery system now has two stages:

- static queue: `content_recovery`
- static edge function: `process-content-recovery-batch`
- static worker: `../content_recovery_processor.ts`
- rendered queue: `content_render_recovery`
- rendered edge function: `process-content-render-recovery-batch`
- rendered worker: `../content_render_recovery_processor.ts`

The rendered worker talks to the standalone internal service documented in
`../../../../services/content-renderer/README.md`.

Current lifecycle:

1. the normal parser stores `parser_recovery_status = 'needed'` for weak parses
2. the normal parser sets `parser_recovery_stage = 'static'` and enqueues
   `content_recovery`
3. `process-content-recovery-batch` claims rows and fetches fresh HTML without
   conditional `304` short-circuiting
4. `static_recovery.ts` tries a stronger static article recovery
5. if the page is still weak but clearly JS-heavy and high-priority,
   `rendered_recovery_gate.ts` escalates it to
   `parser_recovery_stage = 'rendered'` and enqueues `content_render_recovery`
6. `process-content-render-recovery-batch` calls the configured remote renderer,
   reparses the rendered HTML through the normal registry, and persists the new
   parse only if it is materially better
7. rows end in:
   - `succeeded` when recovery clears the recovery decision
   - `dismissed` when the last available recovery stage ran but did not produce
     a sufficiently better parse
   - `failed` when the active recovery stage hit an operational failure and
     should retry later

This separation is intentional. It lets a future rendered fallback worker plug
into the same recovery queue and status model instead of reworking parser
storage again.

### Renderer Contract

The rendered worker expects a remote renderer configured via:

- `CONTENT_RENDERER_URL`
- `CONTENT_RENDERER_SECRET`

It sends a `POST` JSON body like:

```json
{
  "url": "https://example.com/post",
  "waitUntil": "networkidle",
  "timeoutMs": 30000
}
```

The renderer should reply with JSON like:

```json
{
  "resolvedUrl": "https://example.com/post",
  "status": 200,
  "html": "<html>...</html>"
}
```

Keep this contract simple and bounded. The renderer is an implementation detail
behind `rendered_fetch.ts`, not a second parser.

## Archive Notes

Archive mirrors are a first-class route, not a generic fallback hack.

Current archive delegation flow:

1. isolate the primary archive snapshot article
2. strip mirror boilerplate, signup modules, and related-content rails
3. preserve a cleaned source root for provider-aware detection
4. delegate to Bloomberg, Substack, or generic article heuristics based on the
   original source host and surviving source markup

This flow exists because many high-value publishers are blocked on their direct
HTML but still readable through archived mirrors. Be careful not to over-trim
the cleaned archive root: archive pages often wrap real article paragraphs in
plain `<div>` blocks rather than semantic `<p>` tags.
