import { maxParserDiagnosticsBytes } from "./config.ts";
import {
  deriveParserQualityScore,
  measureJsonBytes,
  prepareParserDiagnosticsForStorage,
} from "./diagnostics.ts";
import type { ParserDiagnostics } from "./model.ts";

Deno.test("prepareParserDiagnosticsForStorage returns null for missing diagnostics", () => {
  if (prepareParserDiagnosticsForStorage(null) !== null) {
    throw new Error("expected null diagnostics to stay null");
  }
});

Deno.test("prepareParserDiagnosticsForStorage bounds stored size", () => {
  const oversized: ParserDiagnostics = {
    route: "generic-article",
    parserName: "generic-article",
    parserVersion: "1",
    selectedStrategyId: "readability",
    bytes: {
      parsedDocumentBytes: 200_000,
      parsedDocumentBudgetBytes: 256 * 1024,
      parsedDocumentBudgetRatio: 0.76,
      compactBodyBytes: 28_000,
      compactBodyBudgetBytes: 32 * 1024,
      compactBodyBudgetRatio: 0.85,
    },
    warnings: Array.from(
      { length: 24 },
      (_, index) => `warning-${index}-${"near-budget-".repeat(10)}`,
    ),
    candidates: Array.from({ length: 20 }, (_, index) => ({
      id: `candidate-${index}-${"selector-".repeat(12)}`,
      selected: index === 0,
      qualityScore: 100 - index,
      totalScore: 150 - index,
      blockCount: 40 + index,
      wordCount: 2_000 + index,
      imageCount: index,
      compactBodyBytes: 10_000 + index,
      parsedDocumentBytes: 20_000 + index,
      notes: Array.from(
        { length: 12 },
        (_, noteIndex) =>
          `candidate-${index}-note-${noteIndex}-${"explanation ".repeat(30)}`,
      ),
    })),
  };

  const stored = prepareParserDiagnosticsForStorage(oversized);

  if (stored === null) {
    throw new Error("expected stored diagnostics");
  }
  if (measureJsonBytes(stored) > maxParserDiagnosticsBytes) {
    throw new Error("stored diagnostics exceeded size budget");
  }
  if (stored.candidates.length > 8) {
    throw new Error("candidate count was not bounded");
  }
  if (!stored.candidates.some((candidate) => candidate.selected)) {
    throw new Error("selected candidate was dropped");
  }
  if (stored.warnings.length > 12) {
    throw new Error("warning count was not bounded");
  }
});

Deno.test("deriveParserQualityScore prefers the selected candidate score", () => {
  const qualityScore = deriveParserQualityScore({
    route: "generic-article",
    parserName: "generic-article",
    parserVersion: "1",
    selectedStrategyId: "readability",
    bytes: {
      parsedDocumentBytes: 1_000,
      parsedDocumentBudgetBytes: 256 * 1024,
      parsedDocumentBudgetRatio: 0.01,
      compactBodyBytes: 800,
      compactBodyBudgetBytes: 32 * 1024,
      compactBodyBudgetRatio: 0.02,
    },
    warnings: [],
    candidates: [
      {
        id: "fallback",
        selected: false,
        qualityScore: 20,
        totalScore: 22.4,
        blockCount: 4,
        wordCount: 200,
        imageCount: 0,
        compactBodyBytes: 500,
        parsedDocumentBytes: 700,
        notes: [],
      },
      {
        id: "readability",
        selected: true,
        qualityScore: 30,
        totalScore: 33.6,
        blockCount: 5,
        wordCount: 260,
        imageCount: 0,
        compactBodyBytes: 600,
        parsedDocumentBytes: 800,
        notes: [],
      },
    ],
  });

  if (qualityScore !== 34) {
    throw new Error(
      `expected selected quality score to round to 34, got ${qualityScore}`,
    );
  }
});
