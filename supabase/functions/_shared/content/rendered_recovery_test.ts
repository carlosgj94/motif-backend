import { runRenderedRecovery } from "./rendered_recovery.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("runRenderedRecovery persists a materially better rendered article parse", async () => {
  const result = await runRenderedRecovery({
    fetched: {
      resolvedUrl: "https://example.com/posts/rendered-target",
      host: "example.com",
      html: `
        <html>
          <head>
            <title>Rendered Target</title>
            <meta name="description" content="A rendered article recovered from a JS-heavy shell." />
            <meta name="author" content="Motif Team" />
          </head>
          <body>
            <div id="__next">
              <main>
                <article>
                  <h1>Rendered Target</h1>
                  <p>The rendered fallback worker exists for pages where the static HTML shell is too thin to produce a good reading experience, even though the fully rendered document contains the real article body.</p>
                  <p>Once a page is rendered we can reuse the existing provider and generic parser stack, instead of inventing a second extraction system only for rendered HTML. That keeps the architecture coherent and lets future parser improvements help both static and rendered recovery.</p>
                  <p>The worker should remain tightly scoped and host-gated, but when it runs it needs to produce a parse that is materially better than the weak stored version. Otherwise the system just burns resources without improving what the user actually reads.</p>
                  <p>That means the rendered worker is not allowed to persist marginal improvements. It should win only when the parsed body becomes clearly more complete, the structure becomes more coherent, or the quality score meaningfully improves relative to the weak stored parse that originally triggered recovery.</p>
                  <p>A conservative rendered path also scales better. When escalation is limited to high-priority weak articles with obvious JavaScript shells, the product gets the upside of rendered recovery without turning browser rendering into the normal ingestion path for every page on the web.</p>
                  <p>The important architectural point is that the rendered worker still hands the final document back to the same parser registry, diagnostics model, compact-body budget checks, and persistence path. Rendering should only change how the HTML is obtained, not how the final article representation is shaped.</p>
                </article>
              </main>
            </div>
          </body>
        </html>
      `,
      status: 200,
      fetchedAt: "2026-04-05T12:00:00.000Z",
      originalUrl: null,
      etag: null,
      lastModified: null,
      notModified: false,
    },
    current: {
      sourceKind: "article",
      parsedDocument: {
        version: 1,
        kind: "article",
        title: "Rendered Target",
        blocks: [{ type: "paragraph", text: "Thin shell teaser." }],
      },
      parserQualityScore: 5,
      parserRecovery: {
        shouldRecover: true,
        priority: "high",
        qualityScore: 5,
        route: "generic-article",
        selectedStrategyId: "fallback-container",
        reasons: ["article-empty-or-too-short"],
      },
    },
  });

  assert(result.kind === "persist", "expected rendered recovery to persist");
  if (result.kind !== "persist") {
    return;
  }
  assert(
    result.recoveryStatus === "succeeded",
    `expected rendered recovery to succeed, got ${result.recoveryStatus}`,
  );
  assert(
    result.processed.wordCount > 180,
    `expected rendered parse to be materially longer, got ${result.processed.wordCount}`,
  );
  assert(
    result.processed.parserName.includes("rendered"),
    `expected rendered parser name, got ${result.processed.parserName}`,
  );
});
