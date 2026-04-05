import {
  buildFetchedDocumentResult,
  buildFixtureParseOptions,
  listContentFixtures,
  loadContentFixture,
} from "../supabase/functions/_shared/content/test_helpers.ts";
import { parseFetchedDocument } from "../supabase/functions/_shared/content_processor.ts";

interface FixtureScoreSummary {
  fixture: string;
  parser: string;
  strategy: string | null;
  sourceKind: string;
  wordCount: number;
  blockCount: number;
  parsedBytes: number | null;
  compactBytes: number | null;
  warnings: string[];
  candidateCount: number;
  selectedCandidateScore: number | null;
}

const fixtures = await listContentFixtures();
const summaries: FixtureScoreSummary[] = [];

for (const fixtureRef of fixtures) {
  const fixture = await loadContentFixture(
    fixtureRef.provider,
    fixtureRef.name,
  );
  const processed = await parseFetchedDocument(
    buildFetchedDocumentResult(fixture),
    buildFixtureParseOptions(fixture),
  );
  const diagnostics = processed.parserDiagnostics;

  summaries.push({
    fixture: fixture.id,
    parser: `${processed.parserName}@${processed.parserVersion}`,
    strategy: diagnostics?.selectedStrategyId ?? null,
    sourceKind: processed.sourceKind,
    wordCount: processed.wordCount,
    blockCount: processed.blockCount,
    parsedBytes: diagnostics?.bytes.parsedDocumentBytes ?? null,
    compactBytes: diagnostics?.bytes.compactBodyBytes ?? null,
    warnings: diagnostics?.warnings ?? [],
    candidateCount: diagnostics?.candidates.length ?? 0,
    selectedCandidateScore: diagnostics?.candidates.find((candidate) =>
      candidate.selected
    )?.totalScore ?? diagnostics?.candidates.find((candidate) =>
      candidate.selected
    )?.qualityScore ?? null,
  });
}

const overCompactBudget = summaries.filter((summary) =>
  summary.warnings.includes("compact-body-over-budget")
).map((summary) => summary.fixture);
const nearCompactBudget = summaries.filter((summary) =>
  summary.warnings.includes("compact-body-near-budget")
).map((summary) => summary.fixture);

console.log(JSON.stringify(
  {
    generatedAt: new Date().toISOString(),
    fixtureCount: summaries.length,
    overCompactBudget,
    nearCompactBudget,
    summaries,
  },
  null,
  2,
));
