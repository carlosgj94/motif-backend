import {
  buildFetchedDocumentResult,
  buildFixtureParseOptions,
  loadContentFixture,
  toComparableProcessedContent,
} from "./content/test_helpers.ts";
import { parseFetchedDocument } from "./content_processor.ts";

function assertEqualsJson(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEqualsJson failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

const CASES = [
  ["generic", "simple_post"],
  ["generic", "xataka_descartes"],
  ["generic", "juar_motif_crafted_for_motion"],
  ["generic", "jazzsequence_cms_is_dead"],
  ["text", "karpathy_llm_wiki_gist"],
  ["live_blog", "guardian_cop30"],
  ["substack", "one_useful_thing_shape_of_the_thing"],
  ["bloomberg", "ai_perfected_chess"],
  ["archive", "bloomberg_snapshot"],
  ["archive", "xataka_snapshot"],
  ["x", "karpathy_note_tweet_real_capture"],
  ["x", "kevingu_article_real_capture"],
  ["x", "long_post"],
  ["x", "single_post"],
] as const;

for (const [provider, name] of CASES) {
  Deno.test(`content fixture ${provider}/${name}`, async () => {
    const fixture = await loadContentFixture(provider, name);
    const fetched = buildFetchedDocumentResult(fixture);
    const processed = await parseFetchedDocument(
      fetched,
      buildFixtureParseOptions(fixture),
    );

    assertEqualsJson(
      toComparableProcessedContent(processed),
      fixture.expectedParsed,
    );
  });
}
