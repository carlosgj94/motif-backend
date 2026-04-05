import { parseHTML } from "npm:linkedom@0.18.12";

import { selectBestLiveBlogContent } from "./live_blog_heuristics.ts";
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
    languageCode: "en",
    coverImageUrl: null,
    siteName: "The Guardian",
    ...overrides,
  };
}

Deno.test("selectBestLiveBlogContent linearizes Guardian-style key events plus latest updates", () => {
  const keyEventsProps = JSON.stringify({
    keyEvents: [{
      title: "That is the state of play",
      attributes: { summary: true },
      elements: [
        {
          html:
            "&lt;ul&gt;&lt;li&gt;&lt;p&gt;The talks ran late into the evening.&lt;/p&gt;&lt;/li&gt;&lt;li&gt;&lt;p&gt;Countries announced a new disclosure pledge.&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;",
        },
        {
          html:
            "&lt;p&gt;Negotiators will resume on Thursday morning.&lt;/p&gt;",
        },
      ],
    }],
  });

  const html = `
    <html>
      <head>
        <title>Cop30 live: latest updates</title>
        <meta property="og:image" content="https://media.guim.co.uk/hero.jpg" />
      </head>
      <body>
        <div id="liveblog-body">
          <gu-island name="KeyEventsCarousel" props='${keyEventsProps}'></gu-island>
          <article class="block">
            <header>
              <a href="#block-1">
                <time dateTime="2025-11-12T16:25:38.000Z">12 Nov 2025</time>
                <span>17.25 CET</span>
              </a>
              <div><img alt="Fiona Harvey" src="https://i.guim.co.uk/profile.png" /></div>
              <span>Fiona Harvey</span>
            </header>
            <p>Al Gore said it was literally insane that leaders were still letting global heating happen.</p>
            <figure>
              <img src="https://media.guim.co.uk/chart.jpg" alt="Chart" />
              <figcaption>A protest flotilla arrived in Belem ahead of the negotiations.</figcaption>
            </figure>
            <footer><button>Share</button></footer>
          </article>
          <article class="block">
            <header>
              <a href="#block-2">
                <time dateTime="2025-11-12T16:10:00.000Z">12 Nov 2025</time>
                <span>17.10 CET</span>
              </a>
              <h2>Day three begins at Cop30</h2>
            </header>
            <p>Delegates returned to negotiations with finance and methane on the agenda.</p>
          </article>
        </div>
      </body>
    </html>
  `;
  const document = documentFromHtml(html);

  const selected = selectBestLiveBlogContent({
    document,
    resolvedUrl:
      "https://www.theguardian.com/environment/live/2025/nov/12/cop30-live",
    metadata: metadata({
      title: "Cop30 live: latest updates",
      description: "Fallback description",
      coverImageUrl: "https://media.guim.co.uk/hero.jpg",
    }),
  });

  assertEquals(selected, {
    title: "Cop30 live: latest updates",
    excerpt: "That is the state of play",
    author: "Fiona Harvey",
    publishedAt: null,
    coverImageUrl: "https://media.guim.co.uk/hero.jpg",
    siteName: "The Guardian",
    blocks: [
      { type: "heading", level: 2, text: "Key events" },
      { type: "heading", level: 3, text: "That is the state of play" },
      {
        type: "list",
        style: "bulleted",
        items: [
          "The talks ran late into the evening.",
          "Countries announced a new disclosure pledge.",
        ],
      },
      {
        type: "paragraph",
        text: "Negotiators will resume on Thursday morning.",
      },
      { type: "heading", level: 2, text: "Latest updates" },
      { type: "heading", level: 3, text: "17.25 CET | Fiona Harvey" },
      {
        type: "paragraph",
        text:
          "Al Gore said it was literally insane that leaders were still letting global heating happen.",
      },
      { type: "heading", level: 3, text: "17.10 CET" },
      { type: "heading", level: 4, text: "Day three begins at Cop30" },
      {
        type: "paragraph",
        text:
          "Delegates returned to negotiations with finance and methane on the agenda.",
      },
    ],
    strategyId: "dom-liveblog-root",
  });
});

Deno.test("selectBestLiveBlogContent falls back to LiveBlogPosting JSON-LD updates", () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "LiveBlogPosting",
            "headline": "Budget live: reforms and reaction",
            "datePublished": "2026-03-12T14:10:07Z",
            "author": [
              { "@type": "Person", "name": "Alice Example" },
              { "@type": "Person", "name": "Bob Example" }
            ],
            "liveBlogUpdate": [
              {
                "@type": "BlogPosting",
                "headline": "Markets react",
                "datePublished": "2026-03-12T14:10:07Z",
                "author": { "@type": "Person", "name": "Alice Example" },
                "articleBody": "Stocks rose after the announcement."
              },
              {
                "@type": "BlogPosting",
                "datePublished": "2026-03-12T13:45:00Z",
                "author": { "@type": "Person", "name": "Bob Example" },
                "articleBody": "Opposition parties said the package did not go far enough."
              }
            ]
          }
        </script>
      </head>
      <body></body>
    </html>
  `;
  const document = documentFromHtml(html);

  const selected = selectBestLiveBlogContent({
    document,
    resolvedUrl: "https://example.com/live/budget",
    metadata: metadata(),
  });

  assertEquals(selected, {
    title: "Budget live: reforms and reaction",
    excerpt: "Stocks rose after the announcement.",
    author: "Alice Example and others",
    publishedAt: "2026-03-12T14:10:07.000Z",
    coverImageUrl: null,
    siteName: "The Guardian",
    blocks: [
      { type: "heading", level: 2, text: "Latest updates" },
      { type: "heading", level: 3, text: "14:10 UTC | Alice Example" },
      { type: "heading", level: 4, text: "Markets react" },
      { type: "paragraph", text: "Stocks rose after the announcement." },
      { type: "heading", level: 3, text: "13:45 UTC | Bob Example" },
      {
        type: "paragraph",
        text: "Opposition parties said the package did not go far enough.",
      },
    ],
    strategyId: "jsonld-liveblog-updates",
  });
});
