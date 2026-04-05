# Why this fixture exists

Exercises the direct `bloomberg-article` adapter with:

- Bloomberg-specific title, byline, excerpt, and published date recovery
- body extraction from Bloomberg article markup
- promo, newsletter, and related-story removal
- cover image recovery without leaking the hero caption into the article body

# Capture status

Synthetic fixture standing in for a direct Bloomberg fetch, because the real
URL family currently returns `403` from this environment.

# Replacement guidance

Replace with a real captured Bloomberg page once we have a stable capture path.
