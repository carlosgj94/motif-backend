import { parseHTML } from "npm:linkedom@0.18.12";

import {
  selectGenericArticleCoverImage,
  selectGenericArticleExcerpt,
} from "./generic_article_metadata.ts";
import type { ContentMetadata } from "./model.ts";

type Document = any;

function documentFromHtml(html: string): Document {
  return (parseHTML(html) as unknown as { document: Document }).document;
}

function assertEquals<T>(actual: T, expected: T): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEquals failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

function emptyMetadata(): ContentMetadata {
  return {
    title: null,
    description: null,
    author: null,
    publishedAt: null,
    languageCode: null,
    coverImageUrl: null,
    siteName: null,
  };
}

Deno.test("selectGenericArticleExcerpt prefers the body summary over truncated metadata", () => {
  const excerpt = selectGenericArticleExcerpt({
    metadataDescription:
      "I saw a post on LinkedIn the other day from a self-proclaimed agency veteran saying they were done with WordPress […]",
    candidateExcerpt:
      "I saw a post on LinkedIn the other day from a self-proclaimed 20 year agency veteran of WordPress saying that was it, they’re moving the entire agency off of WordPress and onto AI.",
    title: "The CMS is dead. Long live the CMS.",
  });

  assertEquals(
    excerpt,
    "I saw a post on LinkedIn the other day from a self-proclaimed 20 year agency veteran of WordPress saying that was it, they’re moving the entire agency off of WordPress and onto AI.",
  );
});

Deno.test("selectGenericArticleCoverImage rejects avatar metadata when the article has no lead image", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <meta property="og:image" content="https://example.com/avatars/site-owner.jpg" />
      </head>
      <body>
        <header>
          <img
            class="profile_photo u-photo"
            src="https://example.com/avatars/site-owner.jpg"
            alt="Author Profile Photo"
            width="80"
            height="80"
          />
        </header>
        <article class="post-content">
          <p>First actual paragraph with enough article text to count as prose.</p>
          <p>Second paragraph with more real content before the only image appears.</p>
          <p>Third paragraph that makes the late image a poor cover candidate.</p>
          <p>Fourth paragraph to make the image clearly non-hero content.</p>
          <img src="https://cdn.example.com/poster.png" width="460" height="600" alt="" />
        </article>
      </body>
    </html>
  `);

  const coverImageUrl = selectGenericArticleCoverImage({
    document,
    resolvedUrl: "https://example.com/posts/tiny-reader",
    metadata: {
      ...emptyMetadata(),
      siteName: "Example",
      coverImageUrl: "https://example.com/avatars/site-owner.jpg",
    },
    title: "Tiny Reader",
    author: "Author",
  });

  assertEquals(coverImageUrl, null);
});

Deno.test("selectGenericArticleCoverImage prefers the article hero image over site-level metadata", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <meta property="og:image" content="https://example.com/avatars/site-owner.jpg" />
        <meta property="og:image:alt" content="Author Profile Photo" />
      </head>
      <body>
        <header>
          <img src="https://example.com/avatars/site-owner.jpg" alt="Author Profile Photo" />
        </header>
        <main>
          <article>
            <header>
              <picture>
                <source
                  srcset="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fhero-cover.png&w=2048&q=75 2048w"
                  width="2048"
                  height="1152"
                />
                <img
                  src="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fhero-cover.png&w=1200&q=75"
                  alt="Intentional illustrated cover for the article"
                  width="1200"
                  height="675"
                />
              </picture>
            </header>
            <p>First article paragraph.</p>
            <p>Second article paragraph.</p>
          </article>
        </main>
      </body>
    </html>
  `);

  const coverImageUrl = selectGenericArticleCoverImage({
    document,
    resolvedUrl: "https://example.com/posts/hero-image",
    metadata: {
      ...emptyMetadata(),
      siteName: "Example",
      coverImageUrl: "https://example.com/avatars/site-owner.jpg",
    },
    title: "Hero Image",
    author: "Author",
  });

  assertEquals(coverImageUrl, "https://cdn.example.com/hero-cover.png");
});
