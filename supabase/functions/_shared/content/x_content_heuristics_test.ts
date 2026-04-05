import { parseHTML } from "npm:linkedom@0.18.12";

import { selectBestXContent } from "./x_content_heuristics.ts";
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
    siteName: "X",
    ...overrides,
  };
}

Deno.test("selectBestXContent turns a long X payload into article blocks", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <title>kevingu on X: "Shipping the future of research agents."</title>
        <meta
          name="description"
          content="Shipping the future of research agents […]"
        />
      </head>
      <body>
        <script type="application/json">
          {
            "data": {
              "tweetResult": {
                "result": {
                  "rest_id": "2039843234760073341",
                  "core": {
                    "user_results": {
                      "result": {
                        "legacy": {
                          "name": "Kevin Gu",
                          "screen_name": "kevingu"
                        }
                      }
                    }
                  },
                  "legacy": {
                    "created_at": "Sat Apr 05 10:30:00 +0000 2026"
                  },
                  "note_tweet": {
                    "note_tweet_results": {
                      "result": {
                        "text": "Shipping the future of research agents.\\n\\nThis is the first paragraph of a longer argument about why personal knowledge tools need better retrieval and memory primitives.\\n\\nThe second paragraph explains how the system should feel for readers on constrained devices.",
                        "entity_set": {
                          "media": [
                            {
                              "media_url_https": "https://pbs.twimg.com/media/kevin-long.png",
                              "ext_alt_text": "diagram of an agent workflow"
                            }
                          ]
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        </script>
      </body>
    </html>
  `);

  const selected = selectBestXContent({
    document,
    resolvedUrl: "https://x.com/kevingu/status/2039843234760073341",
    metadata: metadata({
      title: 'kevingu on X: "Shipping the future of research agents."',
      description: "Shipping the future of research agents […]",
    }),
  });

  assertEquals(selected, {
    sourceKind: "article",
    title: "Shipping the future of research agents.",
    excerpt:
      "This is the first paragraph of a longer argument about why personal knowledge tools need better retrieval and memory primitives.",
    author: "Kevin Gu",
    publishedAt: "2026-04-05T10:30:00.000Z",
    coverImageUrl: "https://pbs.twimg.com/media/kevin-long.png",
    blocks: [
      {
        type: "paragraph",
        text: "Shipping the future of research agents.",
      },
      {
        type: "paragraph",
        text:
          "This is the first paragraph of a longer argument about why personal knowledge tools need better retrieval and memory primitives.",
      },
      {
        type: "paragraph",
        text:
          "The second paragraph explains how the system should feel for readers on constrained devices.",
      },
    ],
  });
});

Deno.test("selectBestXContent enriches visible X markup with richer payload text", () => {
  const document = documentFromHtml(`
    <html>
      <body>
        <article>
          <div data-testid="User-Name">
            <span>Kevin Gu</span>
            <span>@kevingu</span>
          </div>
          <a href="/kevingu/status/2039843234760073341">
            <time datetime="2026-04-05T10:30:00Z"></time>
          </a>
          <div data-testid="tweetText">Shipping the future of research agents.</div>
        </article>
        <script type="application/json">
          {
            "result": {
              "rest_id": "2039843234760073341",
              "core": {
                "user_results": {
                  "result": {
                    "legacy": {
                      "name": "Kevin Gu",
                      "screen_name": "kevingu"
                    }
                  }
                }
              },
              "legacy": {
                "created_at": "Sat Apr 05 10:30:00 +0000 2026"
              },
              "note_tweet": {
                "note_tweet_results": {
                  "result": {
                    "text": "Shipping the future of research agents.\\n\\nThe real body continues here with enough detail to exceed a normal post and should win over the teaser markup."
                  }
                }
              }
            }
          }
        </script>
      </body>
    </html>
  `);

  const selected = selectBestXContent({
    document,
    resolvedUrl: "https://x.com/kevingu/status/2039843234760073341",
    metadata: metadata(),
  });

  assertEquals(selected?.sourceKind, "article");
  assertEquals(selected?.blocks, [
    {
      type: "paragraph",
      text: "Shipping the future of research agents.",
    },
    {
      type: "paragraph",
      text:
        "The real body continues here with enough detail to exceed a normal post and should win over the teaser markup.",
    },
  ]);
});

Deno.test("selectBestXContent upgrades a link-only X article share from syndication", () => {
  const document = documentFromHtml(`
    <html>
      <body>
        <blockquote class="twitter-tweet">
          <p lang="zxx" dir="ltr">
            <a href="https://t.co/DBaiIhnhLQ">https://t.co/DBaiIhnhLQ</a>
          </p>
        </blockquote>
      </body>
    </html>
  `);

  const selected = selectBestXContent({
    document,
    resolvedUrl: "https://x.com/kevingu/status/2039843234760073341",
    metadata: metadata(),
    oEmbedPost: {
      type: "thread_post",
      post_id: "2039843234760073341",
      author_handle: "kevingu",
      display_name: "Kevin Gu",
      published_at: "2026-04-02T23:11:40.000Z",
      text: "https://t.co/DBaiIhnhLQ",
      media: [],
    },
    syndicatedPost: {
      postId: "2039843234760073341",
      authorHandle: "kevingu",
      displayName: "Kevin Gu",
      publishedAt: "2026-04-02T23:11:40.000Z",
      text: "https://t.co/DBaiIhnhLQ",
      media: [],
      noteTweetId: null,
      article: {
        articleId: "2039807040743419904",
        title: "AutoAgent: first open source library for self-optimizing agents",
        previewText:
          "today we're releasing AutoAgent, an open source library for autonomously improving an agent on any domain.\nAutoAgent hit both the #1 on SpreadsheetBench (96.5%) and the #1 GPT-5 score on TerminalBench",
        coverImageUrl: "https://pbs.twimg.com/media/HE7dfFlasAA3nJb.jpg",
        url: "https://x.com/i/article/2039807040743419904",
      },
    },
  });

  assertEquals(selected, {
    sourceKind: "article",
    title: "AutoAgent: first open source library for self-optimizing agents",
    excerpt:
      "today we're releasing AutoAgent, an open source library for autonomously improving an agent on any domain.\nAutoAgent hit both the #1 on SpreadsheetBench (96.5%) and the #1 GPT-5 score on TerminalBench",
    author: "Kevin Gu",
    publishedAt: "2026-04-02T23:11:40.000Z",
    coverImageUrl: "https://pbs.twimg.com/media/HE7dfFlasAA3nJb.jpg",
    blocks: [
      {
        type: "paragraph",
        text:
          "today we're releasing AutoAgent, an open source library for autonomously improving an agent on any domain.",
      },
      {
        type: "paragraph",
        text:
          "AutoAgent hit both the #1 on SpreadsheetBench (96.5%) and the #1 GPT-5 score on TerminalBench",
      },
    ],
  });
});

Deno.test("selectBestXContent does not promote truncated note-tweet teasers into articles", () => {
  const document = documentFromHtml("<html><body></body></html>");

  const selected = selectBestXContent({
    document,
    resolvedUrl: "https://x.com/karpathy/status/2039805659525644595",
    metadata: metadata(),
    syndicatedPost: {
      postId: "2039805659525644595",
      authorHandle: "karpathy",
      displayName: "Andrej Karpathy",
      publishedAt: "2026-04-02T20:42:21.000Z",
      text:
        "LLM Knowledge Bases\n\nSomething I'm finding very useful recently: using LLMs to build personal knowledge bases for various topics of research interest. In this way, a large fraction of my recent token throughput is going less into manipulating code, and more into manipulating",
      media: [],
      noteTweetId: "Tm90ZVR3ZWV0UmVzdWx0czoyMDM5ODA1NjU5MTk4NDM1MzI4",
      article: null,
    },
  });

  assertEquals(selected?.sourceKind, "post");
  assertEquals(selected?.title, "LLM Knowledge Bases");
  assertEquals(selected?.author, "Andrej Karpathy");
  assertEquals(selected?.blocks, [
    {
      type: "thread_post",
      post_id: "2039805659525644595",
      author_handle: "karpathy",
      display_name: "Andrej Karpathy",
      published_at: "2026-04-02T20:42:21.000Z",
      text:
        "LLM Knowledge Bases\n\nSomething I'm finding very useful recently: using LLMs to build personal knowledge bases for various topics of research interest. In this way, a large fraction of my recent token throughput is going less into manipulating code, and more into manipulating",
      media: [],
    },
  ]);
});

Deno.test("selectBestXContent keeps multiple posts as a thread", () => {
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

  const selected = selectBestXContent({
    document,
    resolvedUrl: "https://x.com/openai/status/123",
    metadata: metadata(),
  });

  assertEquals(selected?.sourceKind, "thread");
  assertEquals(selected?.coverImageUrl, "https://pbs.twimg.com/media/one.jpg");
  assertEquals(selected?.blocks.length, 2);
});
