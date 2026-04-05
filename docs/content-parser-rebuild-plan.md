# Content Parser Rebuild Plan

## Purpose

This document turns the parser/extractor rebuild into an ordered sequence of
changes that can be implemented as small, reviewable pull requests.

The goal is not to support every platform immediately. The goal is to replace
the current single-file parser with a modular extraction pipeline that is:

- text-first for the ESP32 reader
- fixture-driven and regression-tested
- able to route difficult pages to provider-specific adapters
- explicit about fetch policy, parser choice, and extraction quality

## Current Baseline

The current implementation is concentrated in
`supabase/functions/_shared/content_processor.ts`.

Important current constraints:

- Generic articles rely on `Readability` plus one fallback container heuristic.
- Archive and X/Twitter logic are implemented as hard-coded branches.
- Block extraction is generic DOM flattening, not provider-aware.
- Tests are mostly synthetic unit tests in
  `supabase/functions/_shared/content_processor_test.ts`.
- Device projection in `src/embedded_content.rs` ignores image blocks entirely,
  which means parser quality must be judged against a text-only reader.

## Design Principles

1. Treat the parser as infrastructure, not a helper.
2. Prefer stable public signals before scraping deeper.
3. Do not add stealth or impersonation behavior.
4. Separate fetch, detect, extract, score, and project.
5. Every parser failure should become a saved fixture.
6. Keep the edge-function entrypoint stable while internals are replaced.

## Target Shape

The parser should move toward this structure:

```text
supabase/functions/_shared/content/
  adapters/
    archive_snapshot.ts
    generic_article.ts
    substack_post.ts
    x_thread.ts
  extractors/
    json_ld_article.ts
    readability.ts
    semantic_dom.ts
  fixtures/
    generic/
    x/
    archive/
    substack/
  detect.ts
  fetch.ts
  model.ts
  normalize.ts
  project.ts
  registry.ts
  score.ts
  test_helpers.ts
```

`supabase/functions/_shared/content_processor.ts` should remain as the public
compatibility layer until the migration is complete.

## Change Sets

### Change Set 0: Baseline, Docs, Fixture Harness

Purpose: Create the scaffolding that lets us refactor without losing behavior.

Files to add:

- `docs/content-parser-rebuild-plan.md`
- `supabase/functions/_shared/content/test_helpers.ts`
- `supabase/functions/_shared/content_fixture_test.ts`
- `tests/fixtures/content/README.md`
- `tests/fixtures/content/generic/`
- `tests/fixtures/content/archive/`
- `tests/fixtures/content/x/`

Files to update:

- `README.md`

Work:

- Add a shared fixture format with `raw.html`, `headers.json`,
  `expected.parsed.json`, `expected.compact.json`, and `notes.md`.
- Build a test helper that loads a captured response and runs the parser from
  HTML to final compact output.
- Keep current behavior unchanged.

Acceptance criteria:

- Existing Deno tests still pass.
- A new fixture test can execute end to end from saved HTML to parsed document
  and compact output.
- The fixture format is documented.

### Change Set 1: Extract Fetch And Shared Types From The Monolith

Purpose: Make the parser composable before changing behavior.

Files to add:

- `supabase/functions/_shared/content/model.ts`
- `supabase/functions/_shared/content/fetch.ts`
- `supabase/functions/_shared/content/normalize.ts`

Files to update:

- `supabase/functions/_shared/content_processor.ts`
- `supabase/functions/_shared/content_processor_test.ts`

Work:

- Move shared types such as parsed blocks, fetched documents, partial updates,
  and processing results into `model.ts`.
- Move `fetchDocument`, `performValidatedFetch`, `readResponseBytes`,
  `validateFetchTargetUrl`, and hostname/IP helpers into `fetch.ts`.
- Move generic sanitization helpers into `normalize.ts`.
- Re-export the existing public functions from `content_processor.ts` so calling
  code does not change yet.

Acceptance criteria:

- No behavior change.
- Existing imports remain valid.
- Current tests pass with the new module boundaries.

### Change Set 2: Introduce Detection And Adapter Registry

Purpose: Replace hard-coded branching with a parser registry.

Files to add:

- `supabase/functions/_shared/content/detect.ts`
- `supabase/functions/_shared/content/registry.ts`
- `supabase/functions/_shared/content/adapters/generic_article.ts`
- `supabase/functions/_shared/content/adapters/archive_snapshot.ts`
- `supabase/functions/_shared/content/adapters/x_thread.ts`

Files to update:

- `supabase/functions/_shared/content_processor.ts`

Work:

- Create a `detectContentRoute()` function that decides between `generic`,
  `archive`, `x_thread`, and future providers using: URL host/path, JSON-LD
  types, meta tags, and DOM markers.
- Convert the current `processArticleDocument`, `processArchiveDocument`, and
  `processXDocument` implementations into adapter modules.
- Make `processClaimedContent()` call the registry instead of branching
  directly.
- Set `parser_name` to the adapter id instead of one global processor name.

Acceptance criteria:

- No functional regression for current generic, archive, and X paths.
- Parser choice is explicit and testable.
- Adapter id and version are persisted in `content`.

### Change Set 3: Candidate-Based Extraction For Generic Articles

Purpose: Replace the single generic extraction path with competing candidates
and a quality scorer.

Files to add:

- `supabase/functions/_shared/content/extractors/readability.ts`
- `supabase/functions/_shared/content/extractors/semantic_dom.ts`
- `supabase/functions/_shared/content/extractors/json_ld_article.ts`
- `supabase/functions/_shared/content/score.ts`

Files to update:

- `supabase/functions/_shared/content/adapters/generic_article.ts`
- `supabase/functions/_shared/content/model.ts`

Work:

- Define a normalized candidate shape: title, byline, published_at,
  language_code, blocks, diagnostics, score.
- Implement three initial generic candidates: `readability`, `semantic_dom`, and
  `json_ld_article`.
- Add scoring based on: text density, title agreement, byline/date confidence,
  heading quality, list/code preservation, CTA/share/comment penalties,
  duplicate penalties, and compact byte size.
- Pick the top-scoring candidate and persist diagnostics for debugging.

Acceptance criteria:

- Generic article parsing no longer depends on one extractor succeeding.
- Candidate scores are visible in logs or persisted diagnostics.
- Golden fixtures can assert which candidate won.

### Change Set 4: Device-First Block Normalization

Purpose: Normalize the document for a text-only reader rather than a browser.

Files to add:

- `supabase/functions/_shared/content/project.ts`

Files to update:

- `supabase/functions/_shared/content/normalize.ts`
- `src/embedded_content.rs`
- `src/saved_content.rs`
- `src/source_subscriptions.rs`

Work:

- Add normalization rules for: share bars, signup boxes, “related posts”, author
  promos, footers, comments, live-update rails, and repeated boilerplate.
- Convert meaningful figure captions into readable text when the image itself is
  not useful to the device.
- Ensure links are flattened to text without losing anchor text.
- Keep the canonical parsed document rich enough for future clients, but make
  the compact projection explicitly device-oriented.

Acceptance criteria:

- The compact body generated by Rust remains stable for current content.
- New fixture tests verify that image-only or promo-heavy sections do not
  dominate the output.
- Device output size is tracked in tests.

### Change Set 5: Add Parser Diagnostics And HTTP Revalidation For Content

Purpose: Make the parser observable and reduce unnecessary fetches.

Files to add:

- `migrations/<timestamp>_add_content_fetch_caching_and_parser_diagnostics.sql`
- `scripts/review_stored_content.ts`
- `scripts/report_stored_parser_diagnostics.ts`

Files to update:

- `supabase/functions/_shared/content/fetch.ts`
- `supabase/functions/_shared/content_processor.ts`
- `src/content.rs`

Schema additions to `content`:

- `fetch_etag text`
- `fetch_last_modified text`
- `parser_diagnostics jsonb`
- `parser_quality_score integer`

Work:

- Persist `ETag` and `Last-Modified` for article fetches, similar to the source
  refresher flow.
- Add conditional requests for content re-fetches where supported.
- Store adapter id, winner candidate id, score, and major penalties/reasons.
- Make parse failures easier to inspect without replaying production traffic.
- Add production review scripts so persisted diagnostics can be inspected from
  real `content` rows, not just fixture replays.
- Persist a bounded recovery decision for low-confidence parses so a later
  stronger fallback worker can target only the rows that actually need it.

Acceptance criteria:

- Re-fetches can use conditional headers.
- A parsed row can explain which adapter ran and why a candidate won.
- Diagnostics stay bounded in size.
- Low-confidence rows are explicitly marked for future recovery rather than
  being rediscovered ad hoc.

Follow-up implemented after this change set:

- `content_recovery` queue and `process-content-recovery-batch` now consume rows
  marked with `parser_recovery_status = 'needed'`.
- The first recovery strategy is a stronger static article reparse, not a
  rendered browser fallback. This keeps recovery cheap and modular.
- Recovery rows now move through
  `needed -> in_progress -> succeeded/failed/dismissed` with row-level
  attempt/error tracking in `public.content`.
- A second recovery stage now exists for rendered fallback:
  `content_render_recovery` plus `process-content-render-recovery-batch`.

### Change Set 6: Add First Real Provider Adapter Beyond X And Archive

Purpose: Prove that the adapter model handles provider-specific extraction.

Files to add:

- `supabase/functions/_shared/content/adapters/substack_post.ts`
- `tests/fixtures/content/substack/`

Files to update:

- `supabase/functions/_shared/content/detect.ts`
- `supabase/functions/_shared/content/registry.ts`
- `supabase/functions/_shared/source_processor.ts`

Work:

- Detect Substack by host and page markers.
- Support Substack post extraction using metadata, structured data, and DOM
  conventions.
- Prefer the publication feed at `/feed` on the source discovery side when it is
  available.
- Add at least five real fixtures: plain essay, post with notes/callouts,
  paywall boundary, podcast/newsletter hybrid, and image-heavy post.

Acceptance criteria:

- The adapter wins on Substack pages instead of the generic parser.
- Source discovery can locate the feed for a Substack publication.
- Fixture regressions protect the behavior.

### Change Set 7: Add Corpus Review Tooling

Purpose: Make parser work measurable instead of anecdotal.

Files to add:

- `scripts/review_content_fixture.ts`
- `scripts/report_parser_fixture_scores.ts`

Work:

- Add a local review script that prints: adapter chosen, candidate scores,
  extracted title/byline, first blocks, and compact byte count.
- Add a report script that runs the full fixture corpus and summarizes pass
  rate, score distribution, and common failure reasons.

Acceptance criteria:

- A developer can inspect parser quality from fixtures without editing tests.
- Regressions are visible before shipping.

### Change Set 8: Optional Rendered Fallback Worker

Purpose: Handle JS-heavy pages that defeat static extraction without bloating
the edge function.

Files to add:

- `supabase/functions/process-content-render-recovery-batch/`
- `supabase/functions/_shared/content_render_recovery_processor.ts`
- `supabase/functions/_shared/content/rendered_fetch.ts`
- `supabase/functions/_shared/content/rendered_recovery.ts`

Work:

- Create a separate queue and worker for rendered fallback.
- Route only known-failing hosts or low-confidence parses into this path.
- Keep strict host budgets, concurrency limits, and timeouts.
- Do not make this the default parser path.

Acceptance criteria:

- Static extraction remains the default.
- Rendered fallback is isolated, observable, and rate-limited.

Follow-up implemented after this change set:

- `parser_recovery_stage` now splits recovery into `static` and `rendered`.
- `rendered_recovery_gate.ts` escalates only high-priority, JS-heavy article
  failures.
- `rendered_fetch.ts` isolates the remote renderer behind a bounded JSON
  contract using `CONTENT_RENDERER_URL` and `CONTENT_RENDERER_SECRET`.
- The rendered worker reparses fully rendered HTML through the normal registry
  instead of maintaining a separate parser stack.

## First Milestone

Milestone 1 should stop after Change Set 4.

That milestone is complete when:

- the monolith has been split into fetch, detect, registry, adapters, and
  normalization modules
- the current generic, archive, and X behavior runs through adapters
- generic articles use multiple extraction candidates with scoring
- fixture-based golden tests exist
- the device compact projection is covered by parser fixtures

Do not wait for Substack or rendered fallback before calling Milestone 1 done.

## Recommended PR Order

1. `docs + fixture harness`
2. `extract fetch + shared model`
3. `registry + current adapters`
4. `generic candidate extraction + scoring`
5. `device-first normalization`
6. `content fetch revalidation + diagnostics`
7. `substack adapter + fixtures`
8. `review scripts`
9. `optional rendered fallback worker`

## Testing Strategy

Run on every parser PR:

```bash
deno test supabase/functions/_shared/content_processor_test.ts
deno test supabase/functions/_shared/source_processor_test.ts
deno test --allow-read=tests/fixtures/content \
  supabase/functions/_shared/content_fixture_test.ts
cargo test build_compact_content_body
```

Later, once the fixture corpus exists, add one aggregate command that runs the
full parser corpus in CI.

## Explicit Non-Goals

- Full multi-provider coverage in the first phase
- Stealth fingerprint spoofing or anti-ban evasion work
- Browser rendering as the default fetch path
- UI work before parser diagnostics and fixtures exist
