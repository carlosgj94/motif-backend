import {
  deriveParserRecoveryDecision,
  prepareParserRecoveryForStorage,
} from "./recovery.ts";

Deno.test("deriveParserRecoveryDecision flags weak article parses", () => {
  const decision = deriveParserRecoveryDecision({
    host: "example.com",
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
    host: "example.com",
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

Deno.test("deriveParserRecoveryDecision skips disabled recovery hosts", () => {
  const decision = deriveParserRecoveryDecision({
    host: "thinkingbasketball.net",
    sourceKind: "article",
    title: "Example",
    blockCount: 0,
    wordCount: 0,
    parserDiagnostics: {
      route: "generic-article",
      parserName: "generic-article",
      parserVersion: "1",
      selectedStrategyId: "readability",
      bytes: {
        parsedDocumentBytes: 256,
        parsedDocumentBudgetBytes: 256 * 1024,
        parsedDocumentBudgetRatio: 0.001,
        compactBodyBytes: 128,
        compactBodyBudgetBytes: 32 * 1024,
        compactBodyBudgetRatio: 0.004,
      },
      warnings: [],
      candidates: [{
        id: "readability",
        selected: true,
        qualityScore: 0,
        totalScore: 0,
        blockCount: 0,
        wordCount: 0,
        imageCount: 0,
        compactBodyBytes: 128,
        parsedDocumentBytes: 256,
        notes: [],
      }],
    },
  });

  if (decision.shouldRecover) {
    throw new Error("disabled recovery host should skip recovery");
  }
  if (decision.reasons.length !== 0) {
    throw new Error("disabled recovery host should not keep recovery reasons");
  }
});

Deno.test("deriveParserRecoveryDecision treats healthy text documents as complete", () => {
  const decision = deriveParserRecoveryDecision({
    host: "gist.githubusercontent.com",
    sourceKind: "article",
    title: "Short note",
    blockCount: 2,
    wordCount: 34,
    parserDiagnostics: {
      route: "text-document",
      parserName: "text-document",
      parserVersion: "1",
      selectedStrategyId: "markdown-text",
      bytes: {
        parsedDocumentBytes: 900,
        parsedDocumentBudgetBytes: 256 * 1024,
        parsedDocumentBudgetRatio: 0.01,
        compactBodyBytes: 600,
        compactBodyBudgetBytes: 32 * 1024,
        compactBodyBudgetRatio: 0.02,
      },
      warnings: [],
      candidates: [{
        id: "markdown-text",
        selected: true,
        qualityScore: 62,
        totalScore: 62,
        blockCount: 2,
        wordCount: 34,
        imageCount: 0,
        compactBodyBytes: 600,
        parsedDocumentBytes: 900,
        notes: [],
      }],
    },
  });

  if (decision.shouldRecover) {
    throw new Error("healthy text document should skip recovery");
  }
});
