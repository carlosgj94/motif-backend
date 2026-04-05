# Why this fixture exists

Real captured personal-blog article that exercises a smaller custom site with a
clean, readable body.

It is useful because it contains:

- strong long-form body paragraphs
- real publication metadata
- a final image block that is probably low-value for the device reader

# Capture status

Captured from the live page on 2026-04-05 with `curl -L`.

# Current parser issues to track

- The parser now recovers the site-owner byline, drops the trailing image block
  from `parsedDocument`, and rejects the site avatar as `coverImageUrl`.
- This fixture should continue returning `null` for `coverImageUrl` unless the
  page gains a clear article lead image instead of only late-post artwork.
