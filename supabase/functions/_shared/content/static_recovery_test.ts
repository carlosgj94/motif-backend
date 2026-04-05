import { runStaticRecovery } from "./static_recovery.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("runStaticRecovery persists materially better article recovery", async () => {
  const fetched = {
    resolvedUrl: "https://example.com/posts/recovery-target",
    host: "example.com",
    html: `
      <html>
        <head>
          <title>Recovery Target</title>
          <meta name="description" content="Why the recovery worker should try a stronger static strategy before rendering." />
          <meta name="author" content="Motif Team" />
        </head>
        <body>
          <main>
            <article>
              <h1>Recovery Target</h1>
              <p>By Motif Team</p>
              <p>Why the recovery worker should try a stronger static strategy before rendering.</p>
              <p>The current parser can occasionally settle for a body that is technically non-empty but still much too weak for the reading experience we want on the device. That is where a stronger recovery path helps, especially when a page ships multiple shells, repeated metadata, and a dense article body inside a less obvious container.</p>
              <p>A good recovery attempt should strip repeated title and teaser echoes, remove obvious calls to action, and search for denser body containers when the first pass left too much value on the page. It should prefer readable paragraphs over promo rails, and it should keep enough structure that the downstream device can still distinguish real sections from simple text blobs.</p>
              <p>It should also stay modular so a future rendered fallback worker can plug into the same queue, lifecycle, and diagnostics model without replacing the static path. That only works if the storage schema, queue semantics, and parser diagnostics are shared between the static and rendered recovery stages.</p>
              <p>Subscribe now</p>
            </article>
          </main>
        </body>
      </html>
    `,
    status: 200,
    fetchedAt: "2026-04-05T10:00:00.000Z",
    originalUrl: null,
    etag: '"abc"',
    lastModified: "Sat, 05 Apr 2026 10:00:00 GMT",
    notModified: false,
  };

  const result = await runStaticRecovery({
    fetched,
    current: {
      sourceKind: "article",
      parsedDocument: {
        version: 1,
        kind: "article",
        title: "Recovery Target",
        blocks: [{ type: "paragraph", text: "Tiny summary." }],
      },
      parserQualityScore: 4,
      parserRecovery: {
        shouldRecover: true,
        priority: "high",
        qualityScore: 4,
        route: "generic-article",
        selectedStrategyId: "fallback-container",
        reasons: ["article-empty-or-too-short"],
      },
    },
  });

  assert(result.kind === "persist", "expected recovery to persist");
  if (result.kind !== "persist") {
    return;
  }
  assert(
    result.recoveryStatus === "succeeded",
    `expected succeeded recovery status, got ${result.recoveryStatus}`,
  );
  assert(
    result.processed.wordCount > 120,
    `expected materially longer recovered content, got ${result.processed.wordCount}`,
  );
  assert(
    result.processed.parserName === "article-recovery-static",
    "expected static recovery parser name",
  );
});

Deno.test("runStaticRecovery dismisses unsupported non-article rows", async () => {
  const result = await runStaticRecovery({
    fetched: {
      resolvedUrl: "https://x.com/example/status/1",
      host: "x.com",
      html: "<html><body><article><p>Hello</p></article></body></html>",
      status: 200,
      fetchedAt: "2026-04-05T10:00:00.000Z",
      originalUrl: null,
      etag: null,
      lastModified: null,
      notModified: false,
    },
    current: {
      sourceKind: "post",
      parsedDocument: {
        version: 1,
        kind: "post",
        blocks: [{ type: "paragraph", text: "Hello" }],
      },
      parserQualityScore: 12,
      parserRecovery: null,
    },
  });

  assert(result.kind === "dismissed", "expected non-article dismissal");
});
