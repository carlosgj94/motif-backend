# Why this fixture exists

Real captured modern Next.js article that still serves parsable HTML.

It is useful because it contains:

- a long article body
- modern app-router style markup
- real published date metadata
- a real article-level cover image

# Capture status

Captured from the live page on 2026-04-05 with `curl -L`.

# Current parser issues to track

- The parser now recovers the site-level `Person` author fallback and the
  structured `WebSite` name.
- The generic metadata ranker should keep preferring a body-derived excerpt over
  the truncated social teaser metadata for this page.
- This is a good regression target for modern framework-heavy sites where the
  server still renders enough HTML for a text-first parser.
