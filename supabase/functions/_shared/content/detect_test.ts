import {
  detectContentRoute,
  isSubstackHost,
  looksLikeLiveBlogHtml,
  looksLikeSubstackHtml,
} from "./detect.ts";

function assertEquals<T>(actual: T, expected: T): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEquals failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

Deno.test("isSubstackHost detects hosted substack domains", () => {
  assertEquals(isSubstackHost("oneusefulthing.substack.com"), true);
  assertEquals(isSubstackHost("www.oneusefulthing.org"), false);
});

Deno.test("looksLikeSubstackHtml detects custom-domain Substack posts", () => {
  const html = `
    <html>
      <body>
        <script>window._preloads = JSON.parse("{\\"post\\":{},\\"pub\\":{}}")</script>
        <div class="single-post-container">
          <article class="typography newsletter-post post">
            <div class="available-content">
              <div class="body markup"><p>Hello</p></div>
            </div>
          </article>
        </div>
        <img src="https://substackcdn.com/image/fetch/example.png" />
      </body>
    </html>
  `;

  assertEquals(looksLikeSubstackHtml(html), true);
  assertEquals(
    detectContentRoute({
      host: "www.oneusefulthing.org",
      html,
    }),
    "substack-article",
  );
});

Deno.test("looksLikeLiveBlogHtml detects live-blog pages before generic article routing", () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "LiveBlogPosting",
            "headline": "Cop30 live"
          }
        </script>
      </head>
      <body>
        <main>
          <div id="liveblog-body">
            <article class="block"><p>Latest update</p></article>
          </div>
        </main>
      </body>
    </html>
  `;

  assertEquals(looksLikeLiveBlogHtml(html), true);
  assertEquals(
    detectContentRoute({
      host: "www.theguardian.com",
      html,
    }),
    "live-blog",
  );
});
