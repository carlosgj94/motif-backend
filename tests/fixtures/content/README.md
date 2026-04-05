# Content Parser Fixtures

This directory is the shared parser corpus for both Deno parser tests and Rust
compact-body tests.

## Purpose

Fixtures exist to make parser changes reviewable and regression-tested.

Each fixture represents one fetched page and the reviewed outputs derived from
it:

- `raw.html`: the fetched response body. Most fixtures store HTML, but text
  routes may store raw markdown or plain text in this file to keep the replay
  contract consistent across providers.
- `headers.json`: stable fetch context used to replay parsing
- `expected.parsed.json`: reviewed parser output subset
- `expected.compact.json`: reviewed compact device output
- `notes.md`: why the fixture exists and what is still weak

Some providers may also include optional sidecar captures when the raw page HTML
is not the most stable or informative replay source:

- `x_oembed.json`: raw official X oEmbed payload
- `x_syndication.json`: raw official X syndication payload

## Directory Layout

```text
tests/fixtures/content/
  <provider>/
    <fixture_name>/
      raw.html
      headers.json
      expected.parsed.json
      expected.compact.json
      notes.md
      x_oembed.json           # optional
      x_syndication.json      # optional
```

Provider names should reflect the adapter or branch being exercised, for
example:

- `generic`
- `live_blog`
- `bloomberg`
- `archive`
- `x`
- `substack`
- `text`

Archive fixtures may represent either:

- a direct mirror snapshot routed through archive-source delegation
- a source-specific archived page that should resolve into Bloomberg, Substack,
  or generic article heuristics after mirror boilerplate is removed

## Fixture Rules

1. Prefer real captured pages over handcrafted HTML.
2. Keep seed fixtures deterministic and small enough to review in diffs.
3. Do not update expected outputs casually. Treat fixture diffs like API diffs.
4. Every parser bug should eventually add one new fixture.
5. `expected.parsed.json` should capture only the stable subset under test.
6. `expected.compact.json` should match the output of
   `build_compact_content_body`.
7. Optional sidecars should store the raw upstream payload, not a normalized
   derivative.

## Seed Fixture Status

The first fixtures in this repository are synthetic seed fixtures created during
Change Set 0 to bootstrap the harness. They are intentionally documented as
transitional and should be replaced by real captured pages as soon as the
fixture workflow is in place.

X fixtures are a special case today. Direct `x.com` HTML is often a JS shell, so
the stable replay source may be a combination of:

- minimal `raw.html` that exercises route detection and metadata behavior
- official `x_oembed.json`
- official `x_syndication.json`

That is still treated as a real capture when the sidecars come from the live
official endpoints for the same status URL.

Archive fixtures are the opposite special case: the raw HTML is often the best
replay source, but real captures can be difficult to refresh because `archive.*`
mirrors rate-limit aggressively. When that happens:

- keep existing real archive captures stable once reviewed
- allow a synthetic seed fixture only when it exists to guard a parser branch
  that cannot yet be captured reliably
- record the blocked live capture URL in `notes.md`

When replacing a seed fixture with a captured page:

1. Keep the fixture id stable if it exercises the same parser branch.
2. Update `notes.md` to record that the fixture is now captured from a real
   page.
3. Review both `expected.parsed.json` and `expected.compact.json` together.

## `headers.json` Schema

```json
{
  "resolvedUrl": "https://example.com/posts/example",
  "status": 200,
  "fetchedAt": "2026-04-05T00:00:00.000Z",
  "originalUrl": null,
  "contentType": "text/html; charset=utf-8"
}
```

`host` is intentionally omitted and should be derived from `resolvedUrl` in the
fixture loader.

## Running Fixture Tests

The Deno fixture test reads this directory directly, so it should be run with
read access to the fixture root:

```bash
deno test --allow-read=tests/fixtures/content \
  supabase/functions/_shared/content_fixture_test.ts
```
