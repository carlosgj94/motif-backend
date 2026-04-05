# Why this fixture exists

Exercises a real X Article share capture using official public sidecars from
oEmbed and syndication.

# Capture notes

`raw.html` is intentionally minimal because the direct `x.com` status page is a
JS shell in this environment. The parser relies on:

- `x_oembed.json` for the human-facing embed response
- `x_syndication.json` for the `article` object, preview text, and cover image

# Known current weakness

The public syndication payload exposes the article preview text, not the full
X Article body. This fixture still matters because it proves the parser can
distinguish a real article share from a normal post.
