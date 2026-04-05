import {
  MAX_AUTHOR_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_LANGUAGE_CODE_CHARS,
  MAX_SITE_NAME_CHARS,
  MAX_TITLE_CHARS,
  PARSED_DOCUMENT_VERSION,
  PARSER_VERSION,
} from "../config.ts";
import { buildParserDiagnostics } from "../diagnostics.ts";
import type {
  ContentMetadata,
  FetchDocumentResult,
  ParseFetchedDocumentOptions,
  ProcessedContent,
} from "../model.ts";
import { ProcessingFailure } from "../model.ts";
import {
  buildBaseUpdate,
  deriveParsedDocumentMetrics,
  enforceParsedDocumentSizeLimit,
  trimText,
} from "../normalize.ts";
import {
  deriveTextDocumentCandidateScore,
  parseTextDocumentContent,
} from "../text_document_heuristics.ts";

const PARSER_NAME = "text-document";

export async function processTextDocument(
  fetched: FetchDocumentResult,
  _options: ParseFetchedDocumentOptions = {},
): Promise<ProcessedContent> {
  const parsedText = parseTextDocumentContent({
    raw: fetched.html,
    resolvedUrl: fetched.resolvedUrl,
    host: fetched.host,
  });
  const title = trimText(parsedText.title, MAX_TITLE_CHARS);
  const author = trimText(parsedText.author, MAX_AUTHOR_CHARS);
  const excerpt = trimText(parsedText.excerpt, MAX_EXCERPT_CHARS);
  const siteName = trimText(
    parsedText.siteName ?? fetched.host,
    MAX_SITE_NAME_CHARS,
  );
  const languageCode = trimText(
    parsedText.languageCode,
    MAX_LANGUAGE_CODE_CHARS,
  );
  const metadata: ContentMetadata = {
    title,
    description: excerpt,
    author,
    publishedAt: parsedText.publishedAt,
    languageCode,
    coverImageUrl: null,
    siteName,
  };
  const baseUpdate = buildBaseUpdate({
    fetched,
    metadata,
    favicon: null,
    sourceKind: "article",
    siteName,
    title,
    excerpt,
    author,
    publishedAt: parsedText.publishedAt,
    languageCode,
    coverImageUrl: null,
  });

  if (!title || parsedText.blocks.length === 0) {
    throw ProcessingFailure.parse("Text document body was empty", {
      httpStatus: fetched.status,
      retryable: false,
      partialUpdate: baseUpdate,
    });
  }

  const parsedDocument = enforceParsedDocumentSizeLimit({
    version: PARSED_DOCUMENT_VERSION,
    kind: "article",
    title,
    byline: author,
    published_at: parsedText.publishedAt,
    language_code: languageCode,
    blocks: parsedText.blocks,
  }, baseUpdate);
  const metrics = deriveParsedDocumentMetrics(parsedDocument);
  const candidateScore = deriveTextDocumentCandidateScore({
    wordCount: metrics.wordCount,
    blockCount: metrics.blockCount,
    title,
    excerpt,
    blocks: parsedText.blocks,
  });
  const parserDiagnostics = buildParserDiagnostics({
    route: PARSER_NAME,
    parserName: PARSER_NAME,
    selectedStrategyId: parsedText.strategyId,
    parsedDocument,
    sourceKind: "article",
    candidates: [{
      id: parsedText.strategyId,
      selected: true,
      qualityScore: candidateScore,
      totalScore: candidateScore,
      blocks: parsedText.blocks,
      sourceKind: "article",
      notes: [fetched.contentType ?? "text/plain"],
    }],
  });

  return {
    resolvedUrl: fetched.resolvedUrl,
    host: fetched.host,
    siteName,
    sourceKind: "article",
    title,
    excerpt,
    author,
    publishedAt: parsedText.publishedAt,
    languageCode,
    coverImageUrl: null,
    favicon: null,
    parsedDocument,
    wordCount: metrics.wordCount,
    estimatedReadSeconds: metrics.estimatedReadSeconds,
    blockCount: metrics.blockCount,
    imageCount: metrics.imageCount,
    httpStatus: fetched.status,
    fetchedAt: fetched.fetchedAt,
    sourceDiscoveryUrl: parsedText.sourceDiscoveryUrl,
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
    parserDiagnostics,
  };
}
