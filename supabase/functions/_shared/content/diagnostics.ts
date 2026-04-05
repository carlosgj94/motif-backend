import {
  maxCompactBodyBytes,
  maxParsedDocumentBytes,
  maxParserDiagnosticsBytes,
  PARSER_VERSION,
} from "./config.ts";
import { measureCompactContentBodyBytes } from "./compact_body.ts";
import type {
  ParsedBlock,
  ParserCandidateDiagnostics,
  ParserDiagnostics,
  SourceKind,
} from "./model.ts";
import { deriveParsedDocumentMetrics } from "./normalize.ts";

const textEncoder = new TextEncoder();
const MAX_STORED_CANDIDATES = 8;
const MAX_STORED_WARNINGS = 12;
const MAX_STORED_NOTES_PER_CANDIDATE = 4;
const MAX_STORED_STRING_CHARS = 160;

export interface CandidateDiagnosticInput {
  id: string;
  selected: boolean;
  blocks: ParsedBlock[];
  sourceKind?: SourceKind | null;
  qualityScore?: number | null;
  totalScore?: number | null;
  notes?: string[];
}

export function buildParserDiagnostics(input: {
  route: string;
  parserName: string;
  parserVersion?: string | null;
  selectedStrategyId: string | null;
  parsedDocument: Record<string, unknown>;
  sourceKind: SourceKind;
  candidates?: CandidateDiagnosticInput[];
}): ParserDiagnostics {
  const parsedDocumentBytes = measureJsonBytes(input.parsedDocument);
  const compactBodyBytes = measureCompactContentBodyBytes(
    input.parsedDocument,
    input.sourceKind,
  );
  const candidates = (input.candidates ?? [])
    .map((candidate) => toParserCandidateDiagnostics(candidate))
    .sort((left, right) =>
      Number(right.selected) - Number(left.selected) ||
      compareNullableNumber(right.totalScore, left.totalScore) ||
      compareNullableNumber(right.qualityScore, left.qualityScore) ||
      left.id.localeCompare(right.id)
    );
  const warnings = buildByteWarnings({
    parsedDocumentBytes,
    compactBodyBytes,
  });

  return {
    route: input.route,
    parserName: input.parserName,
    parserVersion: input.parserVersion ?? PARSER_VERSION,
    selectedStrategyId: input.selectedStrategyId,
    bytes: {
      parsedDocumentBytes,
      parsedDocumentBudgetBytes: maxParsedDocumentBytes,
      parsedDocumentBudgetRatio: parsedDocumentBytes / maxParsedDocumentBytes,
      compactBodyBytes,
      compactBodyBudgetBytes: maxCompactBodyBytes,
      compactBodyBudgetRatio: compactBodyBytes === null
        ? null
        : compactBodyBytes / maxCompactBodyBytes,
    },
    candidates,
    warnings,
  };
}

export function measureJsonBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

export function deriveParserQualityScore(
  diagnostics: ParserDiagnostics | null,
): number | null {
  if (!diagnostics) {
    return null;
  }

  const selectedCandidate =
    diagnostics.candidates.find((candidate) => candidate.selected) ??
      diagnostics.candidates[0] ?? null;
  const rawScore = selectedCandidate?.totalScore ?? selectedCandidate
    ?.qualityScore ??
    null;
  if (rawScore === null || !Number.isFinite(rawScore)) {
    return null;
  }

  return clampSignedInt(Math.round(rawScore));
}

export function prepareParserDiagnosticsForStorage(
  diagnostics: ParserDiagnostics | null,
): ParserDiagnostics | null {
  if (!diagnostics) {
    return null;
  }

  const normalized = normalizeParserDiagnosticsForStorage(diagnostics);
  if (measureJsonBytes(normalized) <= maxParserDiagnosticsBytes) {
    return normalized;
  }

  const withoutCandidateNotes: ParserDiagnostics = {
    ...normalized,
    candidates: normalized.candidates.map((candidate) => ({
      ...candidate,
      notes: [],
    })),
  };
  if (measureJsonBytes(withoutCandidateNotes) <= maxParserDiagnosticsBytes) {
    return withoutCandidateNotes;
  }

  let boundedCandidates = withoutCandidateNotes.candidates.slice();
  while (
    boundedCandidates.length > 1 &&
    measureJsonBytes({
        ...withoutCandidateNotes,
        candidates: boundedCandidates,
      }) > maxParserDiagnosticsBytes
  ) {
    boundedCandidates = boundedCandidates.slice(0, -1);
  }

  const reducedCandidates: ParserDiagnostics = {
    ...withoutCandidateNotes,
    candidates: boundedCandidates,
  };
  if (measureJsonBytes(reducedCandidates) <= maxParserDiagnosticsBytes) {
    return reducedCandidates;
  }

  return {
    ...reducedCandidates,
    warnings: reducedCandidates.warnings.slice(0, 4),
    candidates: reducedCandidates.candidates.filter((candidate) =>
      candidate.selected
    ).slice(0, 1),
  };
}

export function toParserCandidateDiagnostics(
  input: CandidateDiagnosticInput,
): ParserCandidateDiagnostics {
  const parsedDocument = {
    kind: input.sourceKind ?? "article",
    blocks: input.blocks,
  };
  const metrics = deriveParsedDocumentMetrics(parsedDocument);

  return {
    id: input.id,
    selected: input.selected,
    qualityScore: input.qualityScore ?? null,
    totalScore: input.totalScore ?? null,
    blockCount: metrics.blockCount,
    wordCount: metrics.wordCount,
    imageCount: metrics.imageCount,
    compactBodyBytes: measureCompactContentBodyBytes(
      parsedDocument,
      input.sourceKind ?? "article",
    ),
    parsedDocumentBytes: measureJsonBytes(parsedDocument),
    notes: input.notes ?? [],
  };
}

function buildByteWarnings(input: {
  parsedDocumentBytes: number;
  compactBodyBytes: number | null;
}): string[] {
  const warnings: string[] = [];

  if (input.parsedDocumentBytes > maxParsedDocumentBytes) {
    warnings.push("parsed-document-over-budget");
  } else if (input.parsedDocumentBytes > maxParsedDocumentBytes * 0.9) {
    warnings.push("parsed-document-near-budget");
  }

  if (input.compactBodyBytes !== null) {
    if (input.compactBodyBytes > maxCompactBodyBytes) {
      warnings.push("compact-body-over-budget");
    } else if (input.compactBodyBytes > maxCompactBodyBytes * 0.9) {
      warnings.push("compact-body-near-budget");
    }
  }

  return warnings;
}

function normalizeParserDiagnosticsForStorage(
  diagnostics: ParserDiagnostics,
): ParserDiagnostics {
  return {
    route: trimRequiredDiagnosticString(diagnostics.route),
    parserName: trimRequiredDiagnosticString(diagnostics.parserName),
    parserVersion: trimRequiredDiagnosticString(diagnostics.parserVersion),
    selectedStrategyId: trimOptionalDiagnosticString(
      diagnostics.selectedStrategyId,
    ),
    bytes: diagnostics.bytes,
    candidates: diagnostics.candidates
      .slice(0, MAX_STORED_CANDIDATES)
      .map((candidate) => ({
        ...candidate,
        id: trimRequiredDiagnosticString(candidate.id),
        notes: candidate.notes
          .slice(0, MAX_STORED_NOTES_PER_CANDIDATE)
          .map((note) => trimRequiredDiagnosticString(note)),
      })),
    warnings: diagnostics.warnings
      .slice(0, MAX_STORED_WARNINGS)
      .map((warning) => trimRequiredDiagnosticString(warning)),
  };
}

function trimRequiredDiagnosticString(value: string): string {
  return trimOptionalDiagnosticString(value) ?? "";
}

function clampSignedInt(value: number): number {
  return Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, value));
}

function trimOptionalDiagnosticString(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > MAX_STORED_STRING_CHARS
    ? `${trimmed.slice(0, MAX_STORED_STRING_CHARS - 1)}…`
    : trimmed;
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }

  return left - right;
}
