# Why this fixture exists

Exercises a real X note-tweet capture using official public sidecars rather
than handcrafted payloads.

# Capture notes

`raw.html` is a minimized shell because direct `x.com` status pages are mostly
client-side app chrome. The meaningful capture lives in:

- `x_oembed.json`
- `x_syndication.json`

# Known current weakness

The public syndication payload exposes only a teaser for this note-tweet, not
the full body. The parser should keep it as a `post`, not falsely upgrade it to
an `article`.
