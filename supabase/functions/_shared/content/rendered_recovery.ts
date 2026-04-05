import { deriveParserQualityScore } from "./diagnostics.ts";
import type {
  FetchDocumentResult,
  ParserRecoveryDecision,
  ProcessedContent,
} from "./model.ts";
import { deriveParserRecoveryDecision } from "./recovery.ts";
import {
  shouldPersistRecoveredContent,
  type StoredRecoverySnapshot,
} from "./recovery_quality.ts";
import { parseFetchedDocumentWithRegistry } from "./registry.ts";

export type RenderedRecoveryResult =
  | {
    kind: "persist";
    recoveryStatus: "succeeded" | "dismissed";
    recoveryDecision: ParserRecoveryDecision | null;
    processed: ProcessedContent;
    reason: string;
  }
  | {
    kind: "dismissed";
    recoveryDecision: ParserRecoveryDecision | null;
    reason: string;
  };

export async function runRenderedRecovery(input: {
  fetched: FetchDocumentResult;
  current: StoredRecoverySnapshot;
}): Promise<RenderedRecoveryResult> {
  if (input.current.sourceKind !== "article") {
    return {
      kind: "dismissed",
      recoveryDecision: input.current.parserRecovery,
      reason: "source-kind-not-supported",
    };
  }

  const processed = await parseFetchedDocumentWithRegistry(input.fetched, {
    faviconFetcher: async () => null,
  });
  const recoveredDecision = deriveParserRecoveryDecision(processed);

  if (
    !shouldPersistRecoveredContent(input.current, processed, recoveredDecision)
  ) {
    return {
      kind: "dismissed",
      recoveryDecision: recoveredDecision,
      reason: "rendered-recovery-not-strong-enough",
    };
  }

  return {
    kind: "persist",
    recoveryStatus: recoveredDecision.shouldRecover ? "dismissed" : "succeeded",
    recoveryDecision: recoveredDecision.shouldRecover
      ? recoveredDecision
      : null,
    processed: {
      ...processed,
      parserDiagnostics: processed.parserDiagnostics
        ? {
          ...processed.parserDiagnostics,
          route: `recovery-rendered:${processed.parserDiagnostics.route}`,
          parserName: `${processed.parserDiagnostics.parserName}-rendered`,
          parserVersion: processed.parserDiagnostics.parserVersion,
          selectedStrategyId: processed.parserDiagnostics.selectedStrategyId,
          candidates: processed.parserDiagnostics.candidates.map((
            candidate,
          ) => ({
            ...candidate,
            notes: ["rendered-recovery", ...candidate.notes],
          })),
        }
        : processed.parserDiagnostics,
      parserName: `${processed.parserName}-rendered`,
    },
    reason: recoveredDecision.shouldRecover
      ? `rendered-recovered-but-still-weak:${
        deriveParserQualityScore(processed.parserDiagnostics) ?? "n/a"
      }`
      : "rendered-recovered-and-cleared",
  };
}
