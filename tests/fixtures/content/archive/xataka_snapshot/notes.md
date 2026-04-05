# Why this fixture exists

Exercises the archive adapter on a non-Bloomberg article so the generic archive
delegation path is frozen end-to-end.

# Capture status

Synthetic archive wrapper built from real Xataka article content.

# What it guards

- source URL extraction from archive chrome
- generic archive-source delegation
- removal of newsletter and related-content mirror noise
- removal of a leading paragraph when it only repeats the stored excerpt
- preserved heading structure in the final parsed document
