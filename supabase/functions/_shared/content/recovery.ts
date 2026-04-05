import type {
  ParserDiagnostics,
  ParserRecoveryDecision,
  ProcessedContent,
} from "./model.ts";
import { deriveParserQualityScore } from "./diagnostics.ts";

const MAX_STORED_RECOVERY_REASONS = 8;
const ARTICLE_HIGH_PRIORITY_QUALITY_SCORE = 10;
const ARTICLE_LOW_PRIORITY_QUALITY_SCORE = 24;
const POST_LOW_PRIORITY_QUALITY_SCORE = 8;

export function deriveParserRecoveryDecision(
  processed: Pick<
    ProcessedContent,
    "sourceKind" | "title" | "blockCount" | "wordCount" | "parserDiagnostics"
  >,
): ParserRecoveryDecision {
  const diagnostics = processed.parserDiagnostics;
  const qualityScore = deriveParserQualityScore(diagnostics);
  const reasons = new Set<string>();
  let highPriority = false;

  if (!diagnostics) {
    reasons.add("missing-parser-diagnostics");
    highPriority = true;
  }

  if (!processed.title) {
    reasons.add("missing-title");
  }

  if (diagnostics && !hasSelectedCandidate(diagnostics)) {
    reasons.add("missing-selected-candidate");
    highPriority = true;
  }

  if (diagnostics?.warnings.includes("parsed-document-over-budget")) {
    reasons.add("parsed-document-over-budget");
  }
  if (diagnostics?.warnings.includes("compact-body-over-budget")) {
    reasons.add("compact-body-over-budget");
  }

  if (processed.sourceKind === "article") {
    if (processed.wordCount < 80 || processed.blockCount === 0) {
      reasons.add("article-empty-or-too-short");
      highPriority = true;
    } else if (processed.wordCount < 220 && processed.blockCount < 3) {
      reasons.add("article-too-few-blocks");
      highPriority = true;
    }

    if (
      qualityScore !== null &&
      qualityScore <= ARTICLE_HIGH_PRIORITY_QUALITY_SCORE
    ) {
      reasons.add("article-low-quality-score");
      highPriority = true;
    } else if (
      qualityScore !== null &&
      qualityScore <= ARTICLE_LOW_PRIORITY_QUALITY_SCORE
    ) {
      reasons.add("article-borderline-quality-score");
    }
  } else {
    if (processed.wordCount < 20 || processed.blockCount === 0) {
      reasons.add("post-empty-or-too-short");
      highPriority = true;
    }

    if (
      qualityScore !== null &&
      qualityScore <= POST_LOW_PRIORITY_QUALITY_SCORE
    ) {
      reasons.add("post-low-quality-score");
    }
  }

  const boundedReasons = Array.from(reasons).slice(
    0,
    MAX_STORED_RECOVERY_REASONS,
  );
  const shouldRecover = boundedReasons.length > 0;

  return {
    shouldRecover,
    priority: shouldRecover ? (highPriority ? "high" : "low") : null,
    qualityScore,
    route: diagnostics?.route ?? null,
    selectedStrategyId: diagnostics?.selectedStrategyId ?? null,
    reasons: boundedReasons,
  };
}

export function prepareParserRecoveryForStorage(
  decision: ParserRecoveryDecision,
): ParserRecoveryDecision | null {
  if (!decision.shouldRecover) {
    return null;
  }

  return {
    shouldRecover: true,
    priority: decision.priority,
    qualityScore: decision.qualityScore,
    route: trimOptional(decision.route),
    selectedStrategyId: trimOptional(decision.selectedStrategyId),
    reasons: decision.reasons
      .slice(0, MAX_STORED_RECOVERY_REASONS)
      .map((reason) => reason.trim())
      .filter(Boolean),
  };
}

function hasSelectedCandidate(diagnostics: ParserDiagnostics): boolean {
  return diagnostics.candidates.some((candidate) => candidate.selected);
}

function trimOptional(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
