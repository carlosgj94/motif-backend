# Why this fixture exists

Real Guardian live-blog capture that freezes the new live-blog route against a
high-noise newsroom page with structured key-events summary cards, many update
blocks, share controls, author avatars, and inline media.

# Current expectations

The parser should keep the key-events summary first, then a bounded set of the
latest updates, with per-update time headings and update-level bylines when they
exist.

# Known current weaknesses

This fixture uses a closed live blog, so the page-level description still
reflects closure state in source metadata even though the parser now prefers the
structured key-events summary for the excerpt.
