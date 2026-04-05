import { deriveParserQualityScore } from "./diagnostics.ts";
import type { ParserRecoveryDecision, ProcessedContent } from "./model.ts";
import { deriveParsedDocumentMetrics } from "./normalize.ts";

export interface StoredRecoverySnapshot {
  sourceKind: string | null;
  parsedDocument: Record<string, unknown> | null;
  parserQualityScore: number | null;
  parserRecovery: ParserRecoveryDecision | null;
}

export function shouldPersistRecoveredContent(
  current: StoredRecoverySnapshot,
  recovered: ProcessedContent,
  recoveredDecision: ParserRecoveryDecision,
): boolean {
  const currentMetrics = current.parsedDocument
    ? deriveParsedDocumentMetrics(current.parsedDocument)
    : { wordCount: 0, estimatedReadSeconds: 1, blockCount: 0, imageCount: 0 };
  const recoveredMetrics = deriveParsedDocumentMetrics(
    recovered.parsedDocument,
  );
  const currentQuality = current.parserQualityScore ?? Number.NEGATIVE_INFINITY;
  const recoveredQuality =
    deriveParserQualityScore(recovered.parserDiagnostics) ??
      Number.NEGATIVE_INFINITY;
  const qualityDelta = recoveredQuality - currentQuality;
  const materiallyLonger = recoveredMetrics.wordCount >=
      currentMetrics.wordCount + 160 ||
    recoveredMetrics.blockCount >= currentMetrics.blockCount + 3;

  if (currentMetrics.blockCount === 0 || currentMetrics.wordCount < 80) {
    return recoveredMetrics.wordCount >= 180 ||
      recoveredMetrics.blockCount >= 3 ||
      qualityDelta >= 12;
  }

  if (!recoveredDecision.shouldRecover) {
    return qualityDelta >= -4 || materiallyLonger;
  }

  return qualityDelta >= 28 && materiallyLonger;
}
