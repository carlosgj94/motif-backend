import {
  discoverFeedCandidates,
  fetchTextResource,
  parseFeedDocument,
  selectBackfillEntries,
} from "./source_processor.ts";

function assertEquals<T>(actual: T, expected: T): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEquals failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

Deno.test("discoverFeedCandidates prefers same-host alternate feeds before common paths", () => {
  const candidates = discoverFeedCandidates(
    `
      <html>
        <head>
          <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
          <link rel="alternate" type="application/atom+xml" href="https://feeds.example.net/main.atom" />
        </head>
      </html>
    `,
    "https://example.com/blog",
  );

  assertEquals(candidates.slice(0, 4), [
    "https://example.com/feed.xml",
    "https://feeds.example.net/main.atom",
    "https://example.com/atom.xml",
    "https://example.com/feed",
  ]);
});

Deno.test("parseFeedDocument parses RSS items into normalized entries", () => {
  const parsed = parseFeedDocument(
    `<?xml version="1.0" encoding="UTF-8" ?>
      <rss version="2.0">
        <channel>
          <title>Example Blog</title>
          <link>https://example.com/</link>
          <description>Notes about systems.</description>
          <item>
            <title>First Post</title>
            <link>https://example.com/posts/first?utm_source=test</link>
            <guid>post-1</guid>
            <description><![CDATA[<p>Hello <strong>world</strong>.</p>]]></description>
            <author>alice@example.com (Alice)</author>
            <pubDate>Tue, 18 Mar 2026 10:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>`,
    "https://example.com/feed.xml",
  );

  assertEquals(parsed?.kind, "rss");
  assertEquals(parsed?.title, "Example Blog");
  assertEquals(parsed?.siteUrl, "https://example.com/");
  assertEquals(parsed?.entries[0], {
    entryKey: "post-1",
    entryGuid: "post-1",
    entryUrl: "https://example.com/posts/first",
    canonicalUrl: "https://example.com/posts/first",
    host: "example.com",
    title: "First Post",
    excerpt: "Hello world.",
    author: "alice@example.com (Alice)",
    publishedAt: "2026-03-18T10:00:00.000Z",
    rawPayload: {
      format: "rss",
      title: "First Post",
      excerpt: "Hello world.",
      author: "alice@example.com (Alice)",
      published_at: "2026-03-18T10:00:00.000Z",
      guid: "post-1",
      url: "https://example.com/posts/first",
    },
  });
});

Deno.test("parseFeedDocument parses Atom entries and falls back to feed author", () => {
  const parsed = parseFeedDocument(
    `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Example Atom</title>
        <subtitle>Posts and updates.</subtitle>
        <link rel="alternate" href="https://example.com/" />
        <author><name>Example Team</name></author>
        <entry>
          <id>tag:example.com,2026:first</id>
          <title>Shipping Sources</title>
          <link rel="alternate" href="https://example.com/posts/shipping-sources#intro" />
          <summary>Source subscriptions are live.</summary>
          <updated>2026-03-18T12:00:00Z</updated>
        </entry>
      </feed>`,
    "https://example.com/atom.xml",
  );

  assertEquals(parsed?.kind, "atom");
  assertEquals(parsed?.description, "Posts and updates.");
  assertEquals(parsed?.entries[0], {
    entryKey: "tag:example.com,2026:first",
    entryGuid: "tag:example.com,2026:first",
    entryUrl: "https://example.com/posts/shipping-sources",
    canonicalUrl: "https://example.com/posts/shipping-sources",
    host: "example.com",
    title: "Shipping Sources",
    excerpt: "Source subscriptions are live.",
    author: "Example Team",
    publishedAt: "2026-03-18T12:00:00.000Z",
    rawPayload: {
      format: "atom",
      title: "Shipping Sources",
      excerpt: "Source subscriptions are live.",
      author: "Example Team",
      published_at: "2026-03-18T12:00:00.000Z",
      id: "tag:example.com,2026:first",
      url: "https://example.com/posts/shipping-sources",
    },
  });
});

Deno.test("fetchTextResource sends conditional headers and treats 304 as not modified", async () => {
  let ifNoneMatch: string | null = null;
  let ifModifiedSince: string | null = null;

  const result = await fetchTextResource("https://example.com/feed.xml", {
    accept: "application/rss+xml",
    maxBytes: 1024,
    bodyLabel: "Feed body",
    etag: '"abc"',
    lastModified: "Wed, 18 Mar 2026 10:00:00 GMT",
    policy: {
      resolveDns: async (hostname, recordType) => {
        if (hostname !== "example.com") {
          return [];
        }

        return recordType === "A" ? ["93.184.216.34"] : [];
      },
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        ifNoneMatch = headers.get("if-none-match");
        ifModifiedSince = headers.get("if-modified-since");

        return new Response(null, {
          status: 304,
          headers: {
            etag: '"def"',
            "last-modified": "Thu, 19 Mar 2026 10:00:00 GMT",
          },
        });
      },
    },
  });

  assertEquals(ifNoneMatch, '"abc"');
  assertEquals(ifModifiedSince, "Wed, 18 Mar 2026 10:00:00 GMT");
  assertEquals(result, {
    resolvedUrl: "https://example.com/feed.xml",
    status: 304,
    contentType: null,
    etag: '"def"',
    lastModified: "Thu, 19 Mar 2026 10:00:00 GMT",
    notModified: true,
    text: "",
  });
});

Deno.test("selectBackfillEntries keeps the newest entries within the backfill cap", () => {
  const entries = Array.from({ length: 35 }, (_, index) => ({
    contentId: `content-${index}`,
    entryKey: `entry-${index}`,
    publishedAt: new Date(Date.UTC(2026, 2, 1, 0, index, 0)).toISOString(),
    deliveredAt: new Date(Date.UTC(2026, 2, 1, 0, index, 0)).toISOString(),
  }));

  const selected = selectBackfillEntries(entries, 30);

  assertEquals(selected.length, 30);
  assertEquals(selected[0]?.entryKey, "entry-34");
  assertEquals(selected[29]?.entryKey, "entry-5");
});
