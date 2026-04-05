import { processBloombergArticle } from "./adapters/bloomberg_article.ts";
import { processSubstackArticle } from "./adapters/substack_article.ts";

function assertEquals<T>(actual: T, expected: T): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEquals failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

function parsedBlocks(
  processed: { parsedDocument: Record<string, unknown> },
): Array<Record<string, unknown>> {
  return Array.isArray(processed.parsedDocument.blocks)
    ? processed.parsedDocument.blocks as Array<Record<string, unknown>>
    : [];
}

Deno.test("processBloombergArticle falls back to generic extraction when provider markup is too thin", async () => {
  const processed = await processBloombergArticle({
    resolvedUrl:
      "https://www.bloomberg.com/news/articles/2026-04-05/example-story",
    host: "www.bloomberg.com",
    html: `
      <html>
        <head>
          <title>Markets Learn To Bend - Bloomberg</title>
          <meta property="og:site_name" content="Bloomberg" />
          <meta name="author" content="Jane Example" />
          <meta
            name="description"
            content="A look at how operators adapt when systems stop behaving predictably."
          />
        </head>
        <body>
          <main>
            <article class="body-copy-v2">
              <header>
                <h1>Markets Learn To Bend</h1>
                <h2>A look at how operators adapt when systems stop behaving predictably.</h2>
              </header>
              <div>Gift this article</div>
            </article>
            <section class="story-content">
              <p>
                The best operators stop assuming that their process is the environment. They treat their process as a
                tool for navigating changing conditions, which lets them adapt without losing orientation.
              </p>
              <p>
                That matters most when a system begins failing in ways the documentation never described. In those
                moments, the quality of the response depends less on rigid procedure and more on whether the team can
                see the important state clearly enough to choose a better path.
              </p>
              <p>
                Products that remain trustworthy under stress are usually built by teams that practice fallback
                thinking early, not by teams that optimize only for the happy path.
              </p>
            </section>
          </main>
        </body>
      </html>
    `,
    status: 200,
    fetchedAt: "2026-04-05T00:00:00.000Z",
    originalUrl: null,
  }, {
    faviconFetcher: async () => null,
  });

  const blocks = parsedBlocks(processed);
  assertEquals(processed.title, "Markets Learn To Bend");
  assertEquals(blocks.length, 3);
  assertEquals(
    String(blocks[0]?.text).includes(
      "The best operators stop assuming that their process is the environment.",
    ),
    true,
  );
});

Deno.test("processSubstackArticle falls back to generic extraction when Substack body markers disappear", async () => {
  const processed = await processSubstackArticle({
    resolvedUrl: "https://example.substack.com/p/adaptation-is-the-product",
    host: "example.substack.com",
    html: `
      <html>
        <head>
          <title>Adaptation Is The Product</title>
          <meta property="og:site_name" content="Example Publication" />
          <meta name="author" content="Alex Example" />
          <meta
            name="description"
            content="What teams learn when the environment changes faster than the plan."
          />
        </head>
        <body>
          <article class="newsletter-post">
            <header>
              <h1>Adaptation Is The Product</h1>
              <p>What teams learn when the environment changes faster than the plan.</p>
            </header>
            <div class="subscription-widget">
              <form><input type="email" /></form>
            </div>
          </article>
          <main>
            <article class="post-shell">
              <p>
                Teams do not earn trust by pretending their systems never fail. They earn trust by making the failure
                modes legible and by giving people a calm path to recover when the situation changes.
              </p>
              <p>
                Once the environment becomes dynamic, static plans stop being enough. The product has to teach people
                what state matters now, what can be ignored, and what fallback remains safe.
              </p>
              <p>
                That is why adaptation is not a support concern. It is one of the core behaviors the product is
                responsible for delivering.
              </p>
            </article>
          </main>
        </body>
      </html>
    `,
    status: 200,
    fetchedAt: "2026-04-05T00:00:00.000Z",
    originalUrl: null,
  }, {
    faviconFetcher: async () => null,
  });

  const blocks = parsedBlocks(processed);
  assertEquals(processed.title, "Adaptation Is The Product");
  assertEquals(processed.author, "Alex Example");
  assertEquals(blocks.length, 3);
  assertEquals(
    String(blocks[1]?.text).includes(
      "Once the environment becomes dynamic, static plans stop being enough.",
    ),
    true,
  );
});
