import { parseHTML } from "npm:linkedom@0.18.12";

type Document = any;

import {
  buildArticleBlocks,
  collectFaviconCandidates,
  collectMetadata,
  discoverArticleSourceUrl,
  extractArchiveSnapshot,
  extractFallbackArticleHtml,
  extractOriginalUrlFromLinkHeader,
  extractThreadPosts,
  fetchDocument,
  isPublicIpLiteral,
  parseDnsOverHttpsAnswers,
  resolveDnsOverHttps,
  sanitizeParsedBlocks,
  validateFetchTargetUrl,
  xPostFromOEmbedPayload,
} from "./content_processor.ts";

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

function assertObjectMatch(
  actual: { [key: string]: unknown },
  expected: { [key: string]: unknown },
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    const actualJson = JSON.stringify(actualValue);
    const expectedJson = JSON.stringify(expectedValue);
    if (actualJson !== expectedJson) {
      throw new Error(
        `assertObjectMatch failed for ${key}\nactual: ${actualJson}\nexpected: ${expectedJson}`,
      );
    }
  }
}

async function assertRejectsMessage(
  fn: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }

    throw new Error(
      `assertRejectsMessage failed\nactual: ${
        String(error)
      }\nexpected to include: ${expectedMessage}`,
    );
  }

  throw new Error(
    `assertRejectsMessage failed\nexpected to include: ${expectedMessage}`,
  );
}

Deno.test("buildArticleBlocks removes heading anchor noise and preserves rich blocks", () => {
  const blocks = buildArticleBlocks(
    `
      <nav>Ignore me</nav>
      <h2><a class="anchor" aria-hidden="true" href="#docs">#</a>Docs</h2>
      <p>Hello <strong>world</strong>.</p>
      <ul>
        <li>First</li>
        <li>Second<ul><li>Nested</li></ul></li>
      </ul>
      <pre><code class="language-rust">fn main() {\n  println!("hi");\n}</code></pre>
      <figure>
        <img data-src="/images/diagram.png" alt="diagram" />
        <figcaption>A diagram</figcaption>
      </figure>
    `,
    "https://example.com/posts/test",
  );

  assertEquals(blocks, [
    { type: "heading", level: 2, text: "Docs" },
    { type: "paragraph", text: "Hello world." },
    { type: "list", style: "bulleted", items: ["First", "Second"] },
    {
      type: "code",
      language: "rust",
      text: 'fn main() {\n  println!("hi");\n}',
    },
    {
      type: "image",
      url: "https://example.com/images/diagram.png",
      alt: "diagram",
      caption: "A diagram",
    },
  ]);
});

Deno.test("buildArticleBlocks falls back to a paragraph when only loose text is present", () => {
  const blocks = buildArticleBlocks(
    "Loose text without wrappers.",
    "https://example.com",
  );

  assertEquals(blocks, [
    { type: "paragraph", text: "Loose text without wrappers." },
  ]);
});

Deno.test("extractFallbackArticleHtml prefers the most readable content container", () => {
  const document = documentFromHtml(`
    <html>
      <body>
        <main><p>Short content.</p></main>
        <article>
          <p>This article body is much longer and should win.</p>
          <aside>Sidebar noise</aside>
          <p>It also has a second paragraph.</p>
        </article>
      </body>
    </html>
  `);

  const fallbackHtml = extractFallbackArticleHtml(document);

  assertEquals(fallbackHtml.includes("much longer and should win"), true);
  assertEquals(fallbackHtml.includes("Sidebar noise"), true);
});

Deno.test("collectMetadata reads meta tags and falls back to time datetime", () => {
  const document = documentFromHtml(`
    <html lang="en_US">
      <head>
        <title>Ignored title</title>
        <meta property="og:title" content="Optimizing Content for Agents" />
        <meta name="description" content="A practical article about parser design." />
        <meta name="author" content="Chris" />
        <meta property="og:image" content="https://example.com/cover.png" />
        <meta property="og:site_name" content="CRA" />
      </head>
      <body>
        <time datetime="2026-03-12"></time>
      </body>
    </html>
  `);

  assertEquals(collectMetadata(document), {
    title: "Optimizing Content for Agents",
    description: "A practical article about parser design.",
    author: "Chris",
    publishedAt: "2026-03-12T00:00:00.000Z",
    languageCode: "en-us",
    coverImageUrl: "https://example.com/cover.png",
    siteName: "CRA",
  });
});

Deno.test("extractOriginalUrlFromLinkHeader reads the archive original relation", () => {
  assertEquals(
    extractOriginalUrlFromLinkHeader(
      '<https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves>; rel="original", <http://archive.md/timegate/https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves>; rel="timegate"',
    ),
    "https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves",
  );
});

Deno.test("extractArchiveSnapshot keeps the first archive.is article and removes related-content noise", () => {
  const archiveUrl =
    "https://archive.is/2026.03.27-142331/https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves";
  const originalUrl =
    "https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves";
  const document = documentFromHtml(`
    <html>
      <head>
        <title>AI Changed Chess, Grandmasters Now Win With Unpredictable Moves - Bloomberg</title>
        <meta property="og:site_name" content="archive.is" />
      </head>
      <body>
        <input type="text" name="q" value="${originalUrl}" />
        <div id="that-jump-content--default"></div>
        <main>
          <article>
            <div>Weekend Essay</div>
            <div>
              <header>
                <h1>AI Perfected Chess. Humans Made It Unpredictable Again</h1>
                <div>
                  Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments.
                  Now grandmasters are winning by making less optimal moves.
                </div>
              </header>
            </div>
            <div>
              <figure>
                <button type="button">
                  <img
                    currentSourceUrl="https://assets.bwbx.io/images/chess-hero.webp"
                    src="/o69yu/chess-hero.webp"
                    alt="Magnus Carlsen at the board"
                  />
                </button>
                <figcaption>Illustration: Mathieu Labrecque for Bloomberg</figcaption>
              </figure>
            </div>
            <div>
              Gift this article
              <div>Contact us: Provide news feedback or report an error</div>
              <div>Confidential tip? Send a tip to our reporters</div>
            </div>
            <div>
              <div>By <a rel="author" href="https://archive.is/o/o69yu/https://www.bloomberg.com/authors/AYLW4J3fKV4/kevin-lincoln">Kevin Lincoln</a></div>
              <time datetime="2026-03-27T08:00:00Z">March 27, 2026 at 8:00 AM UTC</time>
              <div>
                At the biannual 2018 World Chess Championship, Magnus Carlsen defended his title against challenger
                Fabiano Caruana in a best-of-12 format. Classical chess allows players long stretches of time in which
                to make their moves, and the two logged more than 50 hours of play across 12 games. To the shock of
                the chess world, every single game resulted in a draw, a first in the history of the championship.
              </div>
              <div>
                This seemed to confirm a growing suspicion: Chess was dead and draws had killed it. But modern engines
                also changed how players prepare, creating a strange situation where the strongest moves are often
                understood best by computers while humans still have to navigate the practical game over the board.
              </div>
              <div>
                <div>Get the Bloomberg Weekend newsletter.</div>
                <div>Big ideas and open questions in the fascinating places where finance, life and culture meet.</div>
                <form>
                  <input type="email" name="email" placeholder="Enter your email" />
                  <button type="submit">Sign Up</button>
                </form>
                <div>
                  By continuing, I agree to the Privacy Policy and Terms of Service.
                </div>
              </div>
              <div>
                The next generation of grandmasters responded by searching for moves that were not strictly optimal but
                were difficult for other humans to solve. That pushed elite chess back toward surprise, psychology and
                practical pressure, making classical games more decisive again.
              </div>
              <button type="button">Copy Link</button>
              <div>Follow all new stories by <b>Kevin Lincoln</b></div>
              <button type="button">Get Alerts</button>
            </div>
            <div>
              <h3>More From Bloomberg</h3>
              <article>
                <h1>Different Story Entirely</h1>
                <div>Unrelated markets coverage should not leak into the parsed article.</div>
              </article>
            </div>
          </article>
        </main>
      </body>
    </html>
  `);

  const snapshot = extractArchiveSnapshot(document, archiveUrl, originalUrl);
  assertObjectMatch(snapshot as unknown as { [key: string]: unknown }, {
    sourceUrl: originalUrl,
    sourceHost: "www.bloomberg.com",
    siteName: "Bloomberg",
    title: "AI Perfected Chess. Humans Made It Unpredictable Again",
    description:
      "Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments. Now grandmasters are winning by making less optimal moves.",
    author: "Kevin Lincoln",
    publishedAt: "2026-03-27T08:00:00.000Z",
    coverImageUrl: "https://assets.bwbx.io/images/chess-hero.webp",
  });

  if (!snapshot.articleHtml) {
    throw new Error("expected archive article html");
  }

  assertEquals(snapshot.articleHtml.includes("More From Bloomberg"), false);
  assertEquals(
    snapshot.articleHtml.includes("Bloomberg Weekend newsletter"),
    false,
  );
  assertEquals(snapshot.articleHtml.includes("Privacy Policy"), false);
  assertEquals(snapshot.articleHtml.includes("Follow all new stories"), false);
  assertEquals(snapshot.articleHtml.includes("Get Alerts"), false);
  assertEquals(
    snapshot.articleHtml.includes(
      "At the biannual 2018 World Chess Championship",
    ),
    true,
  );

  const blocks = buildArticleBlocks(snapshot.articleHtml, archiveUrl);
  assertEquals(
    (blocks[0] as { type: string; text: string }).type,
    "paragraph",
  );
  assertEquals(
    (blocks[0] as { type: string; text: string }).text.includes(
      "At the biannual 2018 World Chess Championship",
    ),
    true,
  );
  assertEquals(
    blocks.some((block) =>
      "text" in block && String(block.text).includes("Different Story Entirely")
    ),
    false,
  );
});

Deno.test("discoverArticleSourceUrl prefers rel=home candidates", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <link rel="home" href="/blog/" />
      </head>
    </html>
  `);

  assertEquals(
    discoverArticleSourceUrl(document, "https://example.com/posts/hello-world"),
    "https://example.com/blog/",
  );
});

Deno.test("discoverArticleSourceUrl uses related JSON-LD site urls and ignores unrelated publisher urls", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@type": "Article",
            "isPartOf": {
              "@type": "WebSite",
              "url": "https://example.com/journal/"
            },
            "publisher": {
              "@type": "Organization",
              "url": "https://facebook.com/example-publication"
            }
          }
        </script>
      </head>
    </html>
  `);

  assertEquals(
    discoverArticleSourceUrl(document, "https://example.com/posts/hello-world"),
    "https://example.com/journal/",
  );
});

Deno.test("discoverArticleSourceUrl falls back to the site root when metadata is absent", () => {
  const document = documentFromHtml(`
    <html>
      <body><article><p>Hello world</p></article></body>
    </html>
  `);

  assertEquals(
    discoverArticleSourceUrl(document, "https://example.com/posts/hello-world"),
    "https://example.com/",
  );
});

Deno.test("collectFaviconCandidates prioritizes explicit icons before the fallback ico", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <link rel="apple-touch-icon" href="/apple-touch.png" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="shortcut icon" href="https://cdn.example.com/favicon.ico" />
      </head>
    </html>
  `);

  assertEquals(collectFaviconCandidates(document, "https://example.com/post"), [
    "https://example.com/favicon.svg",
    "https://cdn.example.com/favicon.ico",
    "https://example.com/apple-touch.png",
    "https://example.com/favicon.ico",
  ]);
});

Deno.test("extractThreadPosts prefers JSON-LD social posts when available", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@graph": [
              {
                "@type": "SocialMediaPosting",
                "url": "https://x.com/openai/status/123",
                "articleBody": "First post in the thread",
                "datePublished": "2026-03-17T10:00:00Z",
                "author": {
                  "@type": "Person",
                  "name": "OpenAI",
                  "alternateName": "@OpenAI"
                },
                "image": "https://pbs.twimg.com/media/one.jpg"
              },
              {
                "@type": "SocialMediaPosting",
                "url": "https://x.com/openai/status/124",
                "description": "Second post in the thread",
                "datePublished": "2026-03-17T10:01:00Z",
                "author": {
                  "@type": "Person",
                  "name": "OpenAI",
                  "additionalName": "@OpenAI"
                }
              }
            ]
          }
        </script>
      </head>
    </html>
  `);

  const metadata = collectMetadata(document);
  const posts = extractThreadPosts(
    document,
    "https://x.com/openai/status/123",
    metadata,
  );

  assertEquals(posts.length, 2);
  assertObjectMatch(posts[0] as unknown as { [key: string]: unknown }, {
    type: "thread_post",
    post_id: "123",
    author_handle: "OpenAI",
    display_name: "OpenAI",
    published_at: "2026-03-17T10:00:00.000Z",
    text: "First post in the thread",
    media: [{
      kind: "image",
      url: "https://pbs.twimg.com/media/one.jpg",
      alt: null,
    }],
  });
});

Deno.test("extractThreadPosts falls back to X article markup when JSON-LD is absent", () => {
  const document = documentFromHtml(`
    <html>
      <body>
        <article>
          <div data-testid="User-Name">
            <span>OpenAI</span>
            <span>@OpenAI</span>
          </div>
          <a href="/OpenAI/status/777"><time datetime="2026-03-17T12:30:00Z"></time></a>
          <div data-testid="tweetText">Shipping better tools for agents.</div>
          <img src="https://pbs.twimg.com/profile_images/avatar.jpg" alt="avatar" />
          <img src="https://pbs.twimg.com/media/thread-image.jpg" alt="thread image" />
        </article>
      </body>
    </html>
  `);

  const metadata = collectMetadata(document);
  const posts = extractThreadPosts(
    document,
    "https://x.com/OpenAI/status/777",
    metadata,
  );

  assertEquals(posts, [{
    type: "thread_post",
    post_id: "777",
    author_handle: "OpenAI",
    display_name: "OpenAI",
    published_at: "2026-03-17T12:30:00.000Z",
    text: "Shipping better tools for agents.",
    media: [{
      kind: "image",
      url: "https://pbs.twimg.com/media/thread-image.jpg",
      alt: "thread image",
    }],
  }]);
});

Deno.test("extractThreadPosts falls back to metadata when markup is unavailable", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <title>OpenAI on X: "Agents need better content."</title>
        <meta name="description" content="Agents need better content." />
        <meta property="og:image" content="https://pbs.twimg.com/media/fallback.jpg" />
      </head>
    </html>
  `);

  const metadata = collectMetadata(document);
  const posts = extractThreadPosts(
    document,
    "https://x.com/OpenAI/status/888",
    metadata,
  );

  assertEquals(posts, [{
    type: "thread_post",
    post_id: "888",
    author_handle: "OpenAI",
    display_name: "OpenAI",
    published_at: null,
    text: "Agents need better content.",
    media: [{
      kind: "image",
      url: "https://pbs.twimg.com/media/fallback.jpg",
      alt: null,
    }],
  }]);
});

Deno.test("xPostFromOEmbedPayload parses public oEmbed responses", () => {
  const post = xPostFromOEmbedPayload({
    author_name: "OpenAI",
    author_url: "https://twitter.com/OpenAI",
    html:
      '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Rollout complete ✅ <a href="https://t.co/demo">https://t.co/demo</a></p>&mdash; OpenAI (@OpenAI) <a href="https://twitter.com/OpenAI/status/1894583079404277864?ref_src=twsrc%5Etfw">February 26, 2025</a></blockquote>',
  }, "https://x.com/OpenAI/status/1894583079404277864");

  assertEquals(post, {
    type: "thread_post",
    post_id: "1894583079404277864",
    author_handle: "OpenAI",
    display_name: "OpenAI",
    published_at: "2025-02-26T00:00:00.000Z",
    text: "Rollout complete ✅ https://t.co/demo",
    media: [],
  });
});

Deno.test("validateFetchTargetUrl rejects localhost and userinfo URLs", async () => {
  await assertRejectsMessage(
    () => validateFetchTargetUrl("http://localhost/private"),
    "host is not allowed",
  );
  await assertRejectsMessage(
    () => validateFetchTargetUrl("https://user:pass@example.com/secret"),
    "must not include username or password",
  );
});

Deno.test("validateFetchTargetUrl rejects hosts that resolve to private IP space", async () => {
  await assertRejectsMessage(
    () =>
      validateFetchTargetUrl("https://example.com/article", {
        resolveDns: async () => ["10.0.0.5"],
      }),
    "must resolve to a public address",
  );
});

Deno.test("parseDnsOverHttpsAnswers returns only matching record types", () => {
  const payload = {
    Status: 0,
    Answer: [
      { type: 5, data: "example.com.cdn.cloudflare.net" },
      { type: 1, data: "93.184.216.34" },
      { type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" },
    ],
  };

  assertEquals(parseDnsOverHttpsAnswers(payload, "A"), ["93.184.216.34"]);
  assertEquals(parseDnsOverHttpsAnswers(payload, "AAAA"), [
    "2606:2800:220:1:248:1893:25c8:1946",
  ]);
});

Deno.test("resolveDnsOverHttps parses JSON responses", async () => {
  const addresses = await resolveDnsOverHttps(
    "example.com",
    "A",
    async () =>
      new Response(
        JSON.stringify({
          Status: 0,
          Answer: [
            { type: 5, data: "example.com.cdn.cloudflare.net" },
            { type: 1, data: "93.184.216.34" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        },
      ),
  );

  assertEquals(addresses, ["93.184.216.34"]);
});

Deno.test("fetchDocument rejects redirects to blocked destinations", async () => {
  await assertRejectsMessage(
    () =>
      fetchDocument("https://example.com/start", {
        resolveDns: async (host) =>
          host === "example.com" ? ["93.184.216.34"] : [],
        fetchImpl: async (input) => {
          const url = String(input);
          if (url === "https://example.com/start") {
            return new Response(null, {
              status: 302,
              headers: { location: "http://localhost/private" },
            });
          }

          throw new Error(`unexpected fetch: ${url}`);
        },
      }),
    "host is not allowed",
  );
});

Deno.test("fetchDocument rejects oversized HTML bodies before parsing", async () => {
  await assertRejectsMessage(
    () =>
      fetchDocument("https://example.com/huge", {
        resolveDns: async () => ["93.184.216.34"],
        fetchImpl: async () =>
          new Response("<html></html>", {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-length": String(2 * 1024 * 1024 + 1),
            },
          }),
      }),
    "exceeded the size limit",
  );
});

Deno.test("fetchDocument falls back to another archive mirror after a 429", async () => {
  const archiveUrl =
    "https://archive.is/2026.03.27-142331/https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves";
  const mirrorUrl =
    "https://archive.ph/2026.03.27-142331/https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves";
  const fetchCalls: string[] = [];

  const result = await fetchDocument(archiveUrl, {
    resolveDns: async () => ["93.184.216.34"],
    fetchImpl: async (input) => {
      const url = String(input);
      fetchCalls.push(url);

      if (url === archiveUrl) {
        return new Response("rate limited", {
          status: 429,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (url === mirrorUrl) {
        return new Response(
          "<html><body><article><p>Mirror fetch worked.</p></article></body></html>",
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              link:
                '<https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves>; rel="original"',
            },
          },
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  assertEquals(fetchCalls, [archiveUrl, mirrorUrl]);
  assertObjectMatch(result as unknown as { [key: string]: unknown }, {
    resolvedUrl: mirrorUrl,
    host: "archive.ph",
    originalUrl:
      "https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves",
  });
});

Deno.test("fetchDocument sends conditional headers and handles 304 not modified", async () => {
  let capturedIfNoneMatch = "";
  let capturedIfModifiedSince = "";

  const result = await fetchDocument(
    "https://example.com/article",
    {
      resolveDns: async () => ["93.184.216.34"],
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        capturedIfNoneMatch = headers.get("if-none-match") ?? "";
        capturedIfModifiedSince = headers.get("if-modified-since") ?? "";
        return new Response(null, {
          status: 304,
          headers: {
            etag: '"next-etag"',
            "last-modified": "Sat, 05 Apr 2026 10:00:00 GMT",
          },
        });
      },
    },
    {
      etag: '"previous-etag"',
      lastModified: "Fri, 04 Apr 2026 10:00:00 GMT",
    },
  );

  assertEquals(capturedIfNoneMatch, '"previous-etag"');
  assertEquals(capturedIfModifiedSince, "Fri, 04 Apr 2026 10:00:00 GMT");
  assertObjectMatch(result as unknown as { [key: string]: unknown }, {
    resolvedUrl: "https://example.com/article",
    host: "example.com",
    status: 304,
    html: "",
    etag: '"next-etag"',
    lastModified: "Sat, 05 Apr 2026 10:00:00 GMT",
    notModified: true,
  });
});

Deno.test("fetchDocument accepts markdown text responses for supported text documents", async () => {
  const result = await fetchDocument("https://example.com/notes/example.md", {
    resolveDns: async () => ["93.184.216.34"],
    fetchImpl: async () =>
      new Response("# Example\n\nHello from markdown.", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      }),
  });

  assertObjectMatch(result as unknown as { [key: string]: unknown }, {
    resolvedUrl: "https://example.com/notes/example.md",
    host: "example.com",
    contentType: "text/plain; charset=utf-8",
    status: 200,
    notModified: false,
  });
  assertEquals(result.html.includes("Hello from markdown."), true);
});

Deno.test("sanitizeParsedBlocks clamps oversized content", () => {
  const blocks = sanitizeParsedBlocks([
    { type: "paragraph", text: "x".repeat(5000) },
    {
      type: "list",
      style: "bulleted",
      items: Array.from(
        { length: 60 },
        (_, index) => `${index}-` + "y".repeat(600),
      ),
    },
  ]);

  assertEquals((blocks[0] as { text: string }).text.length, 4000);
  assertEquals((blocks[1] as { items: string[] }).items.length, 50);
  assertEquals((blocks[1] as { items: string[] }).items[0].length, 500);
});

Deno.test("isPublicIpLiteral rejects private and documentation IPs", () => {
  assertEquals(isPublicIpLiteral("10.0.0.1"), false);
  assertEquals(isPublicIpLiteral("203.0.113.5"), false);
  assertEquals(isPublicIpLiteral("93.184.216.34"), true);
  assertEquals(isPublicIpLiteral("2001:db8::1"), false);
});
