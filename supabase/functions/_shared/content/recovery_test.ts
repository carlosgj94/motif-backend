import {
  deriveParserRecoveryDecision,
  prepareParserRecoveryForStorage,
} from "./recovery.ts";

Deno.test("deriveParserRecoveryDecision flags weak article parses", () => {
  const decision = deriveParserRecoveryDecision({
    sourceKind: "article",
    title: "Example",
    blockCount: 2,
    wordCount: 120,
    parserDiagnostics: {
      route: "generic-article",
      parserName: "generic-article",
      parserVersion: "1",
      selectedStrategyId: "fallback-container",
      bytes: {
        parsedDocumentBytes: 4000,
        parsedDocumentBudgetBytes: 256 * 1024,
        parsedDocumentBudgetRatio: 0.02,
        compactBodyBytes: 3000,
        compactBodyBudgetBytes: 32 * 1024,
        compactBodyBudgetRatio: 0.09,
      },
      warnings: [],
      candidates: [{
        id: "fallback-container",
        selected: true,
        qualityScore: 10,
        totalScore: 12,
        blockCount: 2,
        wordCount: 120,
        imageCount: 0,
        compactBodyBytes: 3000,
        parsedDocumentBytes: 4000,
        notes: [],
      }],
    },
  });

  if (!decision.shouldRecover) {
    throw new Error("expected weak article parse to need recovery");
  }
  if (decision.priority !== "high") {
    throw new Error(
      `expected high priority recovery, got ${decision.priority}`,
    );
  }
  if (!decision.reasons.includes("article-too-few-blocks")) {
    throw new Error("expected article-too-few-blocks reason");
  }
});

Deno.test("deriveParserRecoveryDecision ignores healthy parses", () => {
  const decision = deriveParserRecoveryDecision({
    sourceKind: "article",
    title: "Example",
    blockCount: 8,
    wordCount: 900,
    parserDiagnostics: {
      route: "generic-article",
      parserName: "generic-article",
      parserVersion: "1",
      selectedStrategyId: "readability",
      bytes: {
        parsedDocumentBytes: 18000,
        parsedDocumentBudgetBytes: 256 * 1024,
        parsedDocumentBudgetRatio: 0.07,
        compactBodyBytes: 12000,
        compactBodyBudgetBytes: 32 * 1024,
        compactBodyBudgetRatio: 0.36,
      },
      warnings: [],
      candidates: [{
        id: "readability",
        selected: true,
        qualityScore: 80,
        totalScore: 85,
        blockCount: 8,
        wordCount: 900,
        imageCount: 0,
        compactBodyBytes: 12000,
        parsedDocumentBytes: 18000,
        notes: [],
      }],
    },
  });

  if (decision.shouldRecover) {
    throw new Error("expected healthy parse to skip recovery");
  }
  if (prepareParserRecoveryForStorage(decision) !== null) {
    throw new Error("healthy parse should not persist recovery payload");
  }
});
