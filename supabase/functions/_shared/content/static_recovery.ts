import {
  MAX_AUTHOR_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_LANGUAGE_CODE_CHARS,
  MAX_SITE_NAME_CHARS,
  MAX_TITLE_CHARS,
  PARSED_DOCUMENT_VERSION,
  PARSER_VERSION,
} from "./config.ts";
import { detectContentRoute } from "./detect.ts";
import { buildParserDiagnostics } from "./diagnostics.ts";
import { selectAggressiveArticleRecoveryContent } from "./aggressive_article_recovery.ts";
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
import {
  collectMetadata,
  deriveParsedDocumentMetrics,
  discoverArticleSourceUrl,
  parseDocument,
  trimText,
  trimUrl,
} from "./normalize.ts";

const PARSER_NAME = "article-recovery-static";

export type StaticRecoveryResult =
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

export async function runStaticRecovery(input: {
  fetched: FetchDocumentResult;
  current: StoredRecoverySnapshot;
}): Promise<StaticRecoveryResult> {
  if (input.current.sourceKind !== "article") {
    return {
      kind: "dismissed",
      recoveryDecision: input.current.parserRecovery,
      reason: "source-kind-not-supported",
    };
  }

  const document = parseDocument(input.fetched.html);
  const metadata = collectMetadata(document);
  const selection = selectAggressiveArticleRecoveryContent({
    document,
    html: input.fetched.html,
    resolvedUrl: input.fetched.resolvedUrl,
    metadata,
    publishedAt: metadata.publishedAt,
    siteName: metadata.siteName ?? input.fetched.host,
  });
  if (!selection) {
    return {
      kind: "dismissed",
      recoveryDecision: input.current.parserRecovery,
      reason: "no-recovery-candidate",
    };
  }

  const title = trimText(
    selection.title ?? metadata.title ?? null,
    MAX_TITLE_CHARS,
  );
  const author = trimText(
    selection.author ?? metadata.author ?? null,
    MAX_AUTHOR_CHARS,
  );
  const excerpt = trimText(
    selection.excerpt ?? metadata.description ?? null,
    MAX_EXCERPT_CHARS,
  );
  const publishedAt = selection.publishedAt ?? metadata.publishedAt;
  const siteName = trimText(
    selection.siteName ?? metadata.siteName ?? input.fetched.host,
    MAX_SITE_NAME_CHARS,
  );
  const languageCode = trimText(metadata.languageCode, MAX_LANGUAGE_CODE_CHARS);
  const coverImageUrl = trimUrl(
    selection.coverImageUrl ?? metadata.coverImageUrl ?? null,
  );
  const parsedDocument = {
    version: PARSED_DOCUMENT_VERSION,
    kind: "article",
    title,
    byline: author,
    published_at: publishedAt,
    language_code: languageCode,
    blocks: selection.blocks,
  };
  const parserDiagnostics = buildParserDiagnostics({
    route: `recovery-static:${detectContentRoute(input.fetched)}`,
    parserName: PARSER_NAME,
    selectedStrategyId: selection.strategyId,
    parsedDocument,
    sourceKind: "article",
    candidates: [{
      id: selection.strategyId,
      selected: true,
      qualityScore: null,
      totalScore: null,
      blocks: selection.blocks,
      sourceKind: "article",
      notes: selection.notes,
    }],
  });
  const processed: ProcessedContent = {
    resolvedUrl: input.fetched.resolvedUrl,
    host: input.fetched.host,
    siteName,
    sourceKind: "article",
    title,
    excerpt,
    author,
    publishedAt,
    languageCode,
    coverImageUrl,
    favicon: null,
    parsedDocument,
    ...deriveParsedDocumentMetrics(parsedDocument),
    httpStatus: input.fetched.status,
    fetchedAt: input.fetched.fetchedAt,
    sourceDiscoveryUrl: discoverArticleSourceUrl(
      document,
      input.fetched.resolvedUrl,
    ),
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
    parserDiagnostics,
  };

  const recoveredDecision = deriveParserRecoveryDecision(processed);
  if (
    !shouldPersistRecoveredContent(input.current, processed, recoveredDecision)
  ) {
    return {
      kind: "dismissed",
      recoveryDecision: recoveredDecision,
      reason: "recovery-not-strong-enough",
    };
  }

  return {
    kind: "persist",
    recoveryStatus: recoveredDecision.shouldRecover ? "dismissed" : "succeeded",
    recoveryDecision: recoveredDecision.shouldRecover
      ? recoveredDecision
      : null,
    processed,
    reason: recoveredDecision.shouldRecover
      ? "recovered-but-still-weak"
      : "recovered-and-cleared",
  };
}
