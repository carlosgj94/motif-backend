# Why this fixture exists

Real captured article from Xataka that exercises a strong generic-article path.

It is useful because it contains:

- a long, well-structured body
- headings
- multiple quote blocks
- Spanish language metadata
- real author and published date metadata

# Capture status

Captured from the live page on 2026-04-05 with `curl -L`.

# Current parser issues to track

- The generic scorer should keep stripping low-value ending blocks like
  `Imágenes | ...` and `En Xataka | ...`.
- The generic metadata ranker should keep preferring the article header image
  over weaker social-preview variants when multiple sizes are available.
- This fixture should remain stable enough to catch regressions in title,
  author, quote handling, non-English article extraction, excerpt selection, and
  cover-image ranking.
