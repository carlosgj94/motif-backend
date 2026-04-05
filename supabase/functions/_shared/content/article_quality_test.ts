import {
  rankArticleQualityCandidates,
  selectBestArticleQualityCandidate,
  selectPreferredArticleQualityCandidate,
} from "./article_quality.ts";

function assertEquals<T>(actual: T, expected: T): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEquals failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

Deno.test("selectBestArticleQualityCandidate prefers a strong generic body over a weak provider teaser", () => {
  const selected = selectBestArticleQualityCandidate([
    {
      id: "provider",
      title: "Systems At Scale",
      excerpt: "A short teaser.",
      author: "Jane Example",
      publishedAt: "2026-04-05T10:00:00.000Z",
      siteName: "Example News",
      coverImageUrl: null,
      blocks: [
        {
          type: "paragraph",
          text:
            "A short teaser about systems at scale and how organizations respond.",
        },
      ],
      selection: "provider",
      preferenceBias: 10,
    },
    {
      id: "generic",
      title: "Systems At Scale",
      excerpt: "A deeper look at how teams adapt under pressure.",
      author: "Jane Example",
      publishedAt: "2026-04-05T10:00:00.000Z",
      siteName: "Example News",
      coverImageUrl: null,
      blocks: [
        {
          type: "paragraph",
          text:
            "Organizations rarely fail because they lack information. They fail because the shape of the work changes faster than the structures built to contain it, and those structures become friction instead of leverage.",
        },
        {
          type: "paragraph",
          text:
            "That is why operational systems need to be judged by how they behave when the inputs are messy, incomplete and time-sensitive. A good system keeps the human operator oriented while the environment shifts underneath them.",
        },
        {
          type: "paragraph",
          text:
            "In practice, that means reducing ceremony, clarifying fallback paths and keeping the most important state visible. These are boring decisions individually, but together they determine whether a product remains trustworthy under load.",
        },
      ],
      selection: "generic",
    },
  ]);

  assertEquals(selected?.selection, "generic");
});

Deno.test("rankArticleQualityCandidates keeps a provider-specific result when quality is comparable", () => {
  const ranked = rankArticleQualityCandidates([
    {
      id: "provider",
      title: "The Shape of the Thing",
      excerpt: "Where we are right now, and what likely happens next.",
      author: "Ethan Example",
      publishedAt: "2026-04-05T10:00:00.000Z",
      siteName: "Example Publication",
      coverImageUrl: "https://cdn.example.com/cover.png",
      blocks: [
        {
          type: "paragraph",
          text:
            "We have entered a phase where useful AI systems are cheap enough that the limiting factor is no longer access. The constraint is organizational design, and that changes the shape of the problem.",
        },
        {
          type: "paragraph",
          text:
            "When delegation becomes fast and cheap, management turns into a first-class knowledge-work skill. Teams need to learn how to specify work, inspect it, and decide what should remain under direct human control.",
        },
        {
          type: "paragraph",
          text:
            "That is a structural shift, not a tooling detail. It changes incentives, team boundaries, and what competent execution looks like day to day.",
        },
      ],
      selection: "provider",
      preferenceBias: 8,
    },
    {
      id: "generic",
      title: "The Shape of the Thing",
      excerpt: "Where we are right now, and what likely happens next.",
      author: "Ethan Example",
      publishedAt: "2026-04-05T10:00:00.000Z",
      siteName: "Example Publication",
      coverImageUrl: null,
      blocks: [
        {
          type: "paragraph",
          text:
            "We have entered a phase where useful AI systems are cheap enough that the limiting factor is no longer access. The constraint is organizational design, and that changes the shape of the problem.",
        },
        {
          type: "paragraph",
          text:
            "When delegation becomes fast and cheap, management turns into a first-class knowledge-work skill. Teams need to learn how to specify work, inspect it, and decide what should remain under direct human control.",
        },
        {
          type: "paragraph",
          text:
            "That is a structural shift, not a tooling detail. It changes incentives, team boundaries, and what competent execution looks like day to day.",
        },
      ],
      selection: "generic",
    },
  ]);

  assertEquals(ranked[0]?.selection, "provider");
});

Deno.test("selectPreferredArticleQualityCandidate keeps a decent provider result unless generic is clearly better", () => {
  const selected = selectPreferredArticleQualityCandidate({
    preferred: {
      id: "provider",
      title: "AI Perfected Chess",
      excerpt: "A clean standfirst.",
      author: "Kevin Example",
      publishedAt: "2026-04-05T10:00:00.000Z",
      siteName: "Bloomberg",
      coverImageUrl: "https://cdn.example.com/chess.webp",
      blocks: [
        {
          type: "paragraph",
          text:
            "Modern chess is not becoming less interesting because machines are stronger. It is becoming more interesting because humans adapt to the pressure created by strong machine guidance.",
        },
        {
          type: "paragraph",
          text:
            "That adaptation changes preparation, risk tolerance and the kinds of positions players are willing to enter when they know that perfect play is no longer a useful human target.",
        },
        {
          type: "paragraph",
          text:
            "The result is a game that remains deeply strategic while becoming harder to summarize with simple narratives about optimization and perfect knowledge.",
        },
      ],
      selection: "provider",
      preferenceBias: 20,
    },
    fallback: {
      id: "generic",
      title: "AI Perfected Chess",
      excerpt: "A clean standfirst.",
      author: "Kevin Example",
      publishedAt: "2026-04-05T10:00:00.000Z",
      siteName: "Bloomberg",
      coverImageUrl: "https://cdn.example.com/chess.webp",
      blocks: [
        { type: "paragraph", text: "Weekend Essay" },
        { type: "heading", level: 1, text: "AI Perfected Chess" },
        { type: "paragraph", text: "Gift this article" },
        {
          type: "paragraph",
          text:
            "Modern chess is not becoming less interesting because machines are stronger. It is becoming more interesting because humans adapt to the pressure created by strong machine guidance.",
        },
        {
          type: "paragraph",
          text:
            "That adaptation changes preparation, risk tolerance and the kinds of positions players are willing to enter when they know that perfect play is no longer a useful human target.",
        },
        {
          type: "paragraph",
          text:
            "The result is a game that remains deeply strategic while becoming harder to summarize with simple narratives about optimization and perfect knowledge.",
        },
      ],
      selection: "generic",
    },
  });

  assertEquals(selected?.selection, "provider");
});
