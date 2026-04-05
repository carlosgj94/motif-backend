# Why this fixture exists

Synthetic long-form X post that exercises payload-script enrichment and
article-style normalization for a single post.

It is useful because it contains:

- no visible article markup
- a long `note_tweet` payload inside JSON
- multi-paragraph text that should become article blocks
- attached media that should become `coverImageUrl`

# Capture status

Synthetic fixture modeled after the blocked real X long-post backlog.

# Replacement guidance

Replace this with a real captured public long post once the X capture path is in
place. Keep the fixture id stable if it still exercises the same long-post
normalization path.
