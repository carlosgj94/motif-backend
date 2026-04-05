import { parseHTML } from "npm:linkedom@0.18.12";

import { selectBestBloombergArticleContent } from "./bloomberg_article_heuristics.ts";
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
    siteName: "Bloomberg",
    ...overrides,
  };
}

Deno.test("selectBestBloombergArticleContent strips Bloomberg promo and related noise from direct markup", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <title>AI Perfected Chess. Humans Made It Unpredictable Again - Bloomberg</title>
        <meta
          name="description"
          content="Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments. Now grandmasters are winning by making less optimal moves."
        />
      </head>
      <body>
        <main>
          <article class="body-copy-v2">
            <header>
              <div>Weekend Essay</div>
              <h1>AI Perfected Chess. Humans Made It Unpredictable Again</h1>
              <h2>
                Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments.
                Now grandmasters are winning by making less optimal moves.
              </h2>
              <figure>
                <img
                  src="https://assets.bwbx.io/images/chess-hero.webp"
                  alt="Magnus Carlsen at the board"
                />
                <figcaption>Illustration: Mathieu Labrecque for Bloomberg</figcaption>
              </figure>
              <div>
                By <a rel="author" href="https://www.bloomberg.com/authors/example">Kevin Lincoln</a>
              </div>
              <time datetime="2026-03-27T08:00:00Z"></time>
            </header>
            <div class="story-body">
              <p>
                At the biannual 2018 World Chess Championship, Magnus Carlsen defended his title against challenger
                Fabiano Caruana in a best-of-12 format.
              </p>
              <p>
                This seemed to confirm a growing suspicion: Chess was dead and draws had killed it.
              </p>
              <div>Gift this article</div>
              <div>Get the Bloomberg Weekend newsletter.</div>
              <form><input type="email" /></form>
              <p>
                The next generation of grandmasters responded by searching for moves that were not strictly optimal
                but were difficult for other humans to solve.
              </p>
              <div>Follow all new stories by <b>Kevin Lincoln</b></div>
            </div>
            <section>
              <h2>More From Bloomberg</h2>
              <article>
                <h1>Other story</h1>
                <p>Should never leak into the article body.</p>
              </article>
            </section>
          </article>
        </main>
      </body>
    </html>
  `);

  const selected = selectBestBloombergArticleContent({
    document,
    resolvedUrl:
      "https://www.bloomberg.com/features/2025-bottlenecks-transformers/",
    metadata: metadata({
      title:
        "AI Perfected Chess. Humans Made It Unpredictable Again - Bloomberg",
      description:
        "Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments. Now grandmasters are winning by making less optimal moves.",
    }),
  });

  assertEquals(selected, {
    title: "AI Perfected Chess. Humans Made It Unpredictable Again",
    excerpt:
      "Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments. Now grandmasters are winning by making less optimal moves.",
    author: "Kevin Lincoln",
    publishedAt: "2026-03-27T08:00:00.000Z",
    coverImageUrl: "https://assets.bwbx.io/images/chess-hero.webp",
    siteName: "Bloomberg",
    blocks: [
      {
        type: "paragraph",
        text:
          "At the biannual 2018 World Chess Championship, Magnus Carlsen defended his title against challenger Fabiano Caruana in a best-of-12 format.",
      },
      {
        type: "paragraph",
        text:
          "This seemed to confirm a growing suspicion: Chess was dead and draws had killed it.",
      },
      {
        type: "paragraph",
        text:
          "The next generation of grandmasters responded by searching for moves that were not strictly optimal but were difficult for other humans to solve.",
      },
    ],
    strategyId: "dom",
  });
});

Deno.test("selectBestBloombergArticleContent falls back to JSON-LD articleBody when markup is too thin", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <title>AI Perfected Chess. Humans Made It Unpredictable Again - Bloomberg</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "NewsArticle",
            "headline": "AI Perfected Chess. Humans Made It Unpredictable Again",
            "description": "Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments. Now grandmasters are winning by making less optimal moves.",
            "datePublished": "2026-03-27T08:00:00Z",
            "author": { "@type": "Person", "name": "Kevin Lincoln" },
            "image": "https://assets.bwbx.io/images/chess-hero.webp",
            "articleBody": "At the biannual 2018 World Chess Championship, Magnus Carlsen defended his title against challenger Fabiano Caruana in a best-of-12 format. Classical chess allows players long stretches of time in which to make their moves. This seemed to confirm a growing suspicion: Chess was dead and draws had killed it. The next generation of grandmasters responded by searching for moves that were not strictly optimal but were difficult for other humans to solve."
          }
        </script>
      </head>
      <body>
        <article>
          <header>
            <h1>AI Perfected Chess. Humans Made It Unpredictable Again</h1>
          </header>
          <div>Gift this article</div>
        </article>
      </body>
    </html>
  `);

  const selected = selectBestBloombergArticleContent({
    document,
    resolvedUrl:
      "https://www.bloomberg.com/features/2025-bottlenecks-transformers/",
    metadata: metadata(),
  });

  assertEquals(
    selected?.title,
    "AI Perfected Chess. Humans Made It Unpredictable Again",
  );
  assertEquals(selected?.author, "Kevin Lincoln");
  assertEquals(selected?.strategyId, "jsonld");
  assertEquals(
    selected?.coverImageUrl,
    "https://assets.bwbx.io/images/chess-hero.webp",
  );
  assertEquals(selected?.blocks.length, 2);
});

Deno.test("selectBestBloombergArticleContent removes archive-style Bloomberg front matter blocks", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <title>AI Perfected Chess. Humans Made It Unpredictable Again - Bloomberg</title>
        <meta
          name="description"
          content="Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments. Now grandmasters are winning by making less optimal moves."
        />
      </head>
      <body>
        <article>
          <div>Weekend Essay</div>
          <header>
            <h1>AI Perfected Chess. Humans Made It Unpredictable Again</h1>
          </header>
          <div>
            <figure>
              <img
                currentSourceUrl="https://assets.bwbx.io/images/chess-hero.webp"
                src="/o69yu/chess-hero.webp"
                alt="Magnus Carlsen at the board"
              />
              <figcaption>Illustration: Mathieu Labrecque for Bloomberg</figcaption>
            </figure>
          </div>
          <div>
            By
            <a rel="author" href="https://www.bloomberg.com/authors/example">Kevin Lincoln</a>
          </div>
          <time datetime="2026-03-27T08:00:00Z">March 27, 2026 at 8:00 AM UTC</time>
          <div>
            At the biannual 2018 World Chess Championship, Magnus Carlsen defended his title against challenger
            Fabiano Caruana in a best-of-12 format. Classical chess allows players long stretches of time in which
            to make their moves, and the two logged more than 50 hours of play across 12 games.
          </div>
          <div>
            This seemed to confirm a growing suspicion: Chess was dead and draws had killed it. But modern engines
            also changed how players prepare, creating a strange situation where the strongest moves are often
            understood best by computers while humans still have to navigate the practical game over the board.
          </div>
        </article>
      </body>
    </html>
  `);

  const selected = selectBestBloombergArticleContent({
    document,
    resolvedUrl: "https://archive.ph/example",
    metadata: metadata({
      title: "AI Perfected Chess. Humans Made It Unpredictable Again",
      publishedAt: "2026-03-27T08:00:00.000Z",
      author: "Kevin Lincoln",
    }),
  });

  assertEquals(selected?.blocks, [
    {
      type: "paragraph",
      text:
        "At the biannual 2018 World Chess Championship, Magnus Carlsen defended his title against challenger Fabiano Caruana in a best-of-12 format. Classical chess allows players long stretches of time in which to make their moves, and the two logged more than 50 hours of play across 12 games.",
    },
    {
      type: "paragraph",
      text:
        "This seemed to confirm a growing suspicion: Chess was dead and draws had killed it. But modern engines also changed how players prepare, creating a strange situation where the strongest moves are often understood best by computers while humans still have to navigate the practical game over the board.",
    },
  ]);
  assertEquals(selected?.strategyId, "dom");
});
