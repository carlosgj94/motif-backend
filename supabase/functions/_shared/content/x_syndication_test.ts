import {
  extractXStatusIdFromUrl,
  xPostFromSyndicationPayload,
} from "./x_syndication.ts";

function assertEquals<T>(actual: T, expected: T): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEquals failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

Deno.test("extractXStatusIdFromUrl reads status ids from X and Twitter URLs", () => {
  assertEquals(
    extractXStatusIdFromUrl("https://x.com/kevingu/status/2039843234760073341"),
    "2039843234760073341",
  );
  assertEquals(
    extractXStatusIdFromUrl(
      "https://twitter.com/karpathy/status/2039805659525644595?ref_src=twsrc%5Etfw",
    ),
    "2039805659525644595",
  );
});

Deno.test("xPostFromSyndicationPayload parses X article shares", () => {
  const parsed = xPostFromSyndicationPayload({
    text: "https://t.co/DBaiIhnhLQ",
    created_at: "2026-04-02T23:11:40.000Z",
    user: {
      name: "Kevin Gu",
      screen_name: "kevingu",
    },
    article: {
      rest_id: "2039807040743419904",
      title: "AutoAgent: first open source library for self-optimizing agents",
      preview_text:
        "today we're releasing AutoAgent, an open source library for autonomously improving an agent on any domain.\nAutoAgent hit both the #1 on SpreadsheetBench (96.5%) and the #1 GPT-5 score on TerminalBench",
      cover_media: {
        media_info: {
          original_img_url: "https://pbs.twimg.com/media/HE7dfFlasAA3nJb.jpg",
        },
      },
    },
    entities: {
      urls: [
        {
          expanded_url: "https://x.com/i/article/2039807040743419904",
        },
      ],
    },
  }, "https://x.com/kevingu/status/2039843234760073341");

  assertEquals(parsed, {
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
  });
});

Deno.test("xPostFromSyndicationPayload parses note-tweet teasers without forcing an article", () => {
  const parsed = xPostFromSyndicationPayload({
    text:
      "LLM Knowledge Bases\n\nSomething I'm finding very useful recently: using LLMs to build personal knowledge bases for various topics of research interest. In this way, a large fraction of my recent token throughput is going less into manipulating code, and more into manipulating",
    created_at: "2026-04-02T20:42:21.000Z",
    user: {
      name: "Andrej Karpathy",
      screen_name: "karpathy",
    },
    note_tweet: {
      id: "Tm90ZVR3ZWV0UmVzdWx0czoyMDM5ODA1NjU5MTk4NDM1MzI4",
    },
  }, "https://x.com/karpathy/status/2039805659525644595");

  assertEquals(parsed, {
    postId: "2039805659525644595",
    authorHandle: "karpathy",
    displayName: "Andrej Karpathy",
    publishedAt: "2026-04-02T20:42:21.000Z",
    text:
      "LLM Knowledge Bases\n\nSomething I'm finding very useful recently: using LLMs to build personal knowledge bases for various topics of research interest. In this way, a large fraction of my recent token throughput is going less into manipulating code, and more into manipulating",
    media: [],
    noteTweetId: "Tm90ZVR3ZWV0UmVzdWx0czoyMDM5ODA1NjU5MTk4NDM1MzI4",
    article: null,
  });
});
