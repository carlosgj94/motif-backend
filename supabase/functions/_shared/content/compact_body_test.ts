import { buildCompactContentBody } from "./compact_body.ts";
import { listContentFixtures, loadContentFixture } from "./test_helpers.ts";

function assertEquals<T>(actual: T, expected: T): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEquals failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

const fixtures = await listContentFixtures();
for (const { provider, name } of fixtures) {
  Deno.test(`compact body fixture ${provider}/${name}`, async () => {
    const fixture = await loadContentFixture(provider, name);
    const parsedDocument = fixture.expectedParsed
      .parsedDocument as Record<string, unknown>;
    const fallbackSourceKind =
      typeof fixture.expectedParsed.sourceKind === "string"
        ? fixture.expectedParsed.sourceKind
        : "article";

    const compact = buildCompactContentBody(
      parsedDocument,
      fallbackSourceKind === "thread" || fallbackSourceKind === "post"
        ? fallbackSourceKind
        : "article",
    );

    assertEquals(compact, fixture.expectedCompact as unknown);
  });
}
