import { parseHTML } from "npm:linkedom@0.18.12";

import { selectBestGenericArticleCandidate } from "./generic_article_heuristics.ts";
import { collectMetadata } from "./normalize.ts";

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

Deno.test("collectMetadata decodes entities and falls back to structured site data", () => {
  const document = documentFromHtml(`
    <html lang="en">
      <head>
        <title>The CMS is dead. Long live the CMS. | jazzsequence</title>
        <meta
          name="description"
          content="I saw a post on LinkedIn &amp;#8230; and it mattered."
        />
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebSite", "name": "jazzsequence" },
              { "@type": "Person", "name": "Chris Reynolds" }
            ]
          }
        </script>
      </head>
    </html>
  `);

  assertEquals(collectMetadata(document), {
    title: "The CMS is dead. Long live the CMS. | jazzsequence",
    description: "I saw a post on LinkedIn … and it mattered.",
    author: "Chris Reynolds",
    publishedAt: null,
    languageCode: "en",
    coverImageUrl: null,
    siteName: "jazzsequence",
  });
});

Deno.test("selectBestGenericArticleCandidate removes tail boilerplate and low-value images", () => {
  const html = `
    <html>
      <head>
        <title>Clean Parsing for Tiny Readers</title>
        <meta name="description" content="Parser quality matters." />
      </head>
      <body>
        <main>
          <article>
            <h1>Clean Parsing for Tiny Readers</h1>
            <p>First real paragraph with enough body text to count as the article.</p>
            <p>Second real paragraph that should survive candidate cleanup.</p>
            <figure><img src="/poster.png" alt="" /></figure>
            <p>Imágenes | Example Studio</p>
            <p>In Example | Another story readers should not see here</p>
          </article>
        </main>
      </body>
    </html>
  `;

  const metadata = collectMetadata(documentFromHtml(html));
  const selected = selectBestGenericArticleCandidate({
    html,
    resolvedUrl: "https://example.com/posts/tiny-readers",
    metadata,
  });

  if (!selected) {
    throw new Error("expected a selected candidate");
  }

  assertEquals(selected.title, "Clean Parsing for Tiny Readers");
  assertEquals(selected.blocks, [
    {
      type: "paragraph",
      text:
        "First real paragraph with enough body text to count as the article.",
    },
    {
      type: "paragraph",
      text: "Second real paragraph that should survive candidate cleanup.",
    },
  ]);
});
