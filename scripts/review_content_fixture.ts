import { buildCompactContentBody } from "../supabase/functions/_shared/content/compact_body.ts";
import {
  buildFetchedDocumentResult,
  buildFixtureParseOptions,
  loadContentFixture,
} from "../supabase/functions/_shared/content/test_helpers.ts";
import { parseFetchedDocument } from "../supabase/functions/_shared/content_processor.ts";

function usage(): never {
  console.error(
    "usage: deno run --config supabase/functions/deno.json --allow-read=tests/fixtures/content scripts/review_content_fixture.ts <provider/name>",
  );
  Deno.exit(1);
}

const fixtureId = Deno.args[0]?.trim() ?? "";
if (!fixtureId.includes("/")) {
  usage();
}

const [provider, name] = fixtureId.split("/", 2);
const fixture = await loadContentFixture(provider, name);
const fetched = buildFetchedDocumentResult(fixture);
const processed = await parseFetchedDocument(
  fetched,
  buildFixtureParseOptions(fixture),
);
const diagnostics = processed.parserDiagnostics;
const compact = buildCompactContentBody(
  processed.parsedDocument,
  processed.sourceKind,
);

console.log(`Fixture: ${fixture.id}`);
console.log(`Route: ${diagnostics?.route ?? processed.parserName}`);
console.log(`Parser: ${processed.parserName}@${processed.parserVersion}`);
console.log(`Strategy: ${diagnostics?.selectedStrategyId ?? "n/a"}`);
console.log(`Title: ${processed.title ?? "n/a"}`);
console.log(`Author: ${processed.author ?? "n/a"}`);
console.log(`Excerpt: ${processed.excerpt ?? "n/a"}`);
console.log(
  `Metrics: words=${processed.wordCount} blocks=${processed.blockCount} images=${processed.imageCount} read_seconds=${processed.estimatedReadSeconds}`,
);

if (diagnostics) {
  const compactBytes = diagnostics.bytes.compactBodyBytes ?? 0;
  const compactBudget = diagnostics.bytes.compactBodyBudgetBytes ?? 0;
  console.log(
    `Bytes: parsed=${diagnostics.bytes.parsedDocumentBytes}/${diagnostics.bytes.parsedDocumentBudgetBytes} (${
      formatRatio(diagnostics.bytes.parsedDocumentBudgetRatio)
    }) compact=${compactBytes}/${compactBudget} (${
      formatRatio(diagnostics.bytes.compactBodyBudgetRatio)
    })`,
  );
  console.log(
    `Warnings: ${
      diagnostics.warnings.length > 0 ? diagnostics.warnings.join(", ") : "none"
    }`,
  );

  if (diagnostics.candidates.length > 0) {
    console.log("\nCandidates:");
    for (const candidate of diagnostics.candidates) {
      const marker = candidate.selected ? "*" : "-";
      const score = candidate.totalScore ?? candidate.qualityScore;
      console.log(
        `${marker} ${candidate.id} score=${
          score ?? "n/a"
        } blocks=${candidate.blockCount} words=${candidate.wordCount} compact_bytes=${
          candidate.compactBodyBytes ?? "n/a"
        } notes=${candidate.notes.join("|") || "none"}`,
      );
    }
  }
}

console.log("\nFirst blocks:");
for (const [index, block] of (compact?.blocks ?? []).slice(0, 12).entries()) {
  console.log(
    `${String(index + 1).padStart(2, " ")}. ${summarizeCompactBlock(block)}`,
  );
}

function summarizeCompactBlock(
  block: NonNullable<typeof compact>["blocks"][number],
): string {
  switch (block.t) {
    case "h":
      return `[h${block.l}] ${block.x}`;
    case "p":
      return `[p] ${block.x}`;
    case "q":
      return `[q] ${block.x}`;
    case "l":
      return `[list] ${block.i.join(" | ")}`;
    case "c":
      return `[code${block.lang ? `:${block.lang}` : ""}] ${block.x}`;
  }
}

function formatRatio(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}
