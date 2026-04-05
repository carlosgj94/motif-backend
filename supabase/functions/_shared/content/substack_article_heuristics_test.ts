import { parseHTML } from "npm:linkedom@0.18.12";

import { selectBestSubstackArticleContent } from "./substack_article_heuristics.ts";
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

function metadata(overrides: Partial<ContentMetadata> = {}): ContentMetadata {
  return {
    title: null,
    description: null,
    author: null,
    publishedAt: null,
    languageCode: null,
    coverImageUrl: null,
    siteName: null,
    ...overrides,
  };
}

function substackPreloadsScript(data: Record<string, unknown>): string {
  return `<script>window._preloads = JSON.parse(${
    JSON.stringify(JSON.stringify(data))
  })</script>`;
}

Deno.test("selectBestSubstackArticleContent strips front matter and preserves meaningful captions", () => {
  const html = `
    <html>
      <head>
        <title>The Shape of the Thing</title>
        <meta property="og:site_name" content="One Useful Thing" />
        <meta name="author" content="Ethan Mollick" />
        <meta
          property="og:image"
          content="https://substackcdn.com/image/fetch/hero.png"
        />
      </head>
      <body>
        ${
    substackPreloadsScript({
      canonicalUrl: "https://www.oneusefulthing.org/p/the-shape-of-the-thing",
      pub: {
        name: "One Useful Thing",
        logo_url: "https://substackcdn.com/image/fetch/logo.png",
      },
      post: {
        title: "The Shape of the Thing",
        subtitle: "Where we are right now, and what likely happens next",
        post_date: "2026-03-12T14:10:07.054Z",
        cover_image: "https://substackcdn.com/image/fetch/hero.png",
        publishedBylines: [{
          name: "Ethan Mollick",
          photo_url: "https://substackcdn.com/image/fetch/avatar.png",
        }],
        body_html: `
              <p>In October of 2023, I wrote about the shape of the shadow of the Thing.</p>
              <div class="captioned-image-container">
                <figure>
                  <img src="https://substackcdn.com/image/fetch/chart.png" alt="" />
                  <figcaption>
                    A simulated version of Slack built by the Software Factory's testing agents.
                  </figcaption>
                </figure>
              </div>
              <p>Subscribe now</p>
              <p>Share</p>
              <p>The window to shape the Thing may not last long, but it is here now.</p>
            `,
      },
    })
  }
        <article class="typography newsletter-post post">
          <div class="post-header">
            <h1 class="post-title">The Shape of the Thing</h1>
            <h3 class="subtitle">Where we are right now, and what likely happens next</h3>
            <div class="byline-wrapper">
              <a href="https://substack.com/@oneusefulthing">Ethan Mollick</a>
              <div>Mar 12, 2026</div>
            </div>
          </div>
          <div class="available-content">
            <div class="body markup">
              <p>In October of 2023, I wrote about the shape of the shadow of the Thing.</p>
              <div class="captioned-image-container">
                <figure>
                  <img src="https://substackcdn.com/image/fetch/chart.png" alt="" />
                  <figcaption>
                    A simulated version of Slack built by the Software Factory's testing agents.
                  </figcaption>
                </figure>
              </div>
              <p>Subscribe now</p>
              <p>The window to shape the Thing may not last long, but it is here now.</p>
            </div>
          </div>
        </article>
      </body>
    </html>
  `;
  const document = documentFromHtml(html);

  const selected = selectBestSubstackArticleContent({
    document,
    html,
    resolvedUrl: "https://www.oneusefulthing.org/p/the-shape-of-the-thing",
    metadata: metadata({
      title: "The Shape of the Thing",
      description: "Where we are right now, and what likely happens next",
      author: "Ethan Mollick",
      siteName: "One Useful Thing",
      coverImageUrl: "https://substackcdn.com/image/fetch/hero.png",
    }),
  });

  assertEquals(selected, {
    title: "The Shape of the Thing",
    excerpt: "Where we are right now, and what likely happens next",
    author: "Ethan Mollick",
    publishedAt: "2026-03-12T14:10:07.054Z",
    coverImageUrl: "https://substackcdn.com/image/fetch/hero.png",
    siteName: "One Useful Thing",
    blocks: [
      {
        type: "paragraph",
        text:
          "In October of 2023, I wrote about the shape of the shadow of the Thing.",
      },
      {
        type: "paragraph",
        text:
          "A simulated version of Slack built by the Software Factory's testing agents.",
      },
      {
        type: "paragraph",
        text:
          "The window to shape the Thing may not last long, but it is here now.",
      },
    ],
    strategyId: "payload-body-html",
  });
});

Deno.test("selectBestSubstackArticleContent falls back to payload body_html when DOM body is absent", () => {
  const html = `
    <html>
      <head>
        <title>The Shape of the Thing</title>
      </head>
      <body>
        ${
    substackPreloadsScript({
      canonicalUrl: "https://www.oneusefulthing.org/p/the-shape-of-the-thing",
      pub: { name: "One Useful Thing" },
      post: {
        title: "The Shape of the Thing",
        subtitle: "Where we are right now, and what likely happens next",
        post_date: "2026-03-12T14:10:07.054Z",
        cover_image: "https://substackcdn.com/image/fetch/hero.png",
        publishedBylines: [{ name: "Ethan Mollick" }],
        body_html: `
              <p>The first paragraph of the article.</p>
              <h1>Riding up the Exponential</h1>
              <p>The second paragraph of the article.</p>
            `,
      },
    })
  }
      </body>
    </html>
  `;
  const document = documentFromHtml(html);

  const selected = selectBestSubstackArticleContent({
    document,
    html,
    resolvedUrl: "https://www.oneusefulthing.org/p/the-shape-of-the-thing",
    metadata: metadata(),
  });

  assertEquals(selected?.strategyId, "payload-body-html");
  assertEquals(selected?.blocks, [
    { type: "paragraph", text: "The first paragraph of the article." },
    { type: "heading", level: 1, text: "Riding up the Exponential" },
    { type: "paragraph", text: "The second paragraph of the article." },
  ]);
});
