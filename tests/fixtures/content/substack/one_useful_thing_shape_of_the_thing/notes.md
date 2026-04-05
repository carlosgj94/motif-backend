# Why this fixture exists

Exercises the `substack-article` adapter on a real custom-domain Substack post:

- custom-domain route detection instead of `*.substack.com` only
- extraction from the `window._preloads` payload with DOM fallback
- removal of subtitle, byline, date, share/subscribe controls, and inline image blocks
- preservation of article structure as text-first heading and paragraph blocks

# Capture status

Real captured page fetched from `https://www.oneusefulthing.org/p/the-shape-of-the-thing`
on 2026-04-05.

# Known current weaknesses

Inline figures are dropped for the device-first output. That is intentional for
now, but chart-heavy posts may eventually need richer caption-to-text handling.
