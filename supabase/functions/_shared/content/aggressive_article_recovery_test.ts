import { parseDocument } from "./normalize.ts";
import { selectAggressiveArticleRecoveryContent } from "./aggressive_article_recovery.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("selectAggressiveArticleRecoveryContent strips metadata echoes and boilerplate", () => {
  const html = `
    <html>
      <head>
        <title>Ship Better Parsers</title>
        <meta name="description" content="A practical guide to making article extraction resilient." />
        <meta name="author" content="Parser Team" />
      </head>
      <body>
        <main>
          <article>
            <h1>Ship Better Parsers</h1>
            <p>By Parser Team</p>
            <p>March 20, 2026</p>
            <p>A practical guide to making article extraction resilient.</p>
            <p>The first real paragraph explains why a device-first reader needs stronger extraction and tighter cleanup around obvious noise.</p>
            <p>The second paragraph goes deeper into fallback selection, explaining why multiple candidates matter when provider markup is unstable.</p>
            <p>The third paragraph closes with a concrete recommendation: keep the recovery path modular so stronger strategies can plug in later.</p>
            <figure>
              <img src="/hero.png" alt="hero" />
              <figcaption>Decorative hero</figcaption>
            </figure>
            <p>Share this article</p>
            <p>Subscribe now</p>
          </article>
        </main>
      </body>
    </html>
  `;

  const document = parseDocument(html);
  const selection = selectAggressiveArticleRecoveryContent({
    document,
    html,
    resolvedUrl: "https://example.com/posts/ship-better-parsers",
    metadata: {
      title: "Ship Better Parsers",
      description: "A practical guide to making article extraction resilient.",
      author: "Parser Team",
      publishedAt: "2026-03-20T00:00:00.000Z",
      languageCode: "en",
      coverImageUrl: "https://example.com/hero.png",
      siteName: "Example",
    },
  });

  assert(selection !== null, "expected aggressive recovery selection");
  if (!selection) {
    return;
  }
  assert(selection.blocks.length >= 3, "expected multiple readable blocks");
  assert(
    selection.blocks.every((block) => block.type !== "image"),
    "expected recovery selection to drop image blocks",
  );
  const texts = selection.blocks.map((block) =>
    "text" in block
      ? block.text
      : block.type === "list"
      ? block.items.join(" ")
      : ""
  ).join("\n");
  assert(
    !texts.includes("Share this article"),
    "expected share boilerplate to be removed",
  );
  assert(
    !texts.includes("Subscribe now"),
    "expected subscribe boilerplate to be removed",
  );
  assert(
    !texts.includes("By Parser Team"),
    "expected author echo lead block to be removed",
  );
});
