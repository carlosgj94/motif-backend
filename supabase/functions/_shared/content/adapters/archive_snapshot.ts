import {
  MAX_AUTHOR_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_LANGUAGE_CODE_CHARS,
  MAX_SITE_NAME_CHARS,
  MAX_TITLE_CHARS,
  PARSED_DOCUMENT_VERSION,
  PARSER_VERSION,
} from "../config.ts";
import { selectArchiveSourceSpecificContent } from "../archive_source_heuristics.ts";
import { buildParserDiagnostics } from "../diagnostics.ts";
import type {
  FetchDocumentResult,
  ParseFetchedDocumentOptions,
  ProcessedContent,
} from "../model.ts";
import { ProcessingFailure } from "../model.ts";
import {
  buildArticleBlocks,
  buildBaseUpdate,
  collectMetadata,
  deriveParsedDocumentMetrics,
  discoverArticleSourceUrl,
  enforceParsedDocumentSizeLimit,
  extractArchiveSnapshot,
  extractFallbackArticleHtml,
  parseDocument,
  sanitizeParsedBlocks,
  summarizeBlocks,
  trimText,
  trimUrl,
} from "../normalize.ts";

const PARSER_NAME = "archive-snapshot";

export async function processArchiveSnapshot(
  fetched: FetchDocumentResult,
  options: ParseFetchedDocumentOptions = {},
): Promise<ProcessedContent> {
  const sourceDocument = parseDocument(fetched.html);
  const metadata = collectMetadata(sourceDocument);
  const snapshot = extractArchiveSnapshot(
    sourceDocument,
    fetched.resolvedUrl,
    fetched.originalUrl,
  );
  const favicon = await options.faviconFetcher?.(
    sourceDocument,
    snapshot.sourceUrl ?? fetched.resolvedUrl,
  ) ?? null;
  const sourceSpecific = selectArchiveSourceSpecificContent({
    sourceDocument,
    snapshot,
    metadata,
    resolvedUrl: fetched.resolvedUrl,
  });

  let blocks = sourceSpecific?.blocks ?? buildArticleBlocks(
    snapshot.articleHtml ?? "",
    fetched.resolvedUrl,
  );
  if (blocks.length === 0) {
    blocks = buildArticleBlocks(
      extractFallbackArticleHtml(sourceDocument),
      fetched.resolvedUrl,
    );
  }

  const title = trimText(
    sourceSpecific?.title ?? snapshot.title ?? metadata.title ?? null,
    MAX_TITLE_CHARS,
  );
  const author = trimText(
    sourceSpecific?.author ?? snapshot.author ?? metadata.author ?? null,
    MAX_AUTHOR_CHARS,
  );
  const publishedAt = sourceSpecific?.publishedAt ?? snapshot.publishedAt ??
    metadata.publishedAt;
  const excerpt = trimText(
    sourceSpecific?.excerpt ?? snapshot.description ?? metadata.description ??
      summarizeBlocks(blocks),
    MAX_EXCERPT_CHARS,
  );
  const siteName = trimText(
    sourceSpecific?.siteName ?? snapshot.siteName ?? metadata.siteName ??
      snapshot.sourceHost ??
      fetched.host,
    MAX_SITE_NAME_CHARS,
  );
  const languageCode = trimText(metadata.languageCode, MAX_LANGUAGE_CODE_CHARS);
  const coverImageUrl = trimUrl(
    sourceSpecific?.coverImageUrl ?? snapshot.coverImageUrl ??
      metadata.coverImageUrl,
  );
  const baseUpdate = buildBaseUpdate({
    fetched,
    metadata,
    favicon,
    sourceKind: "article",
    siteName,
    title,
    excerpt,
    author,
    publishedAt,
    languageCode,
    coverImageUrl,
  });

  if (blocks.length === 0) {
    throw ProcessingFailure.parse("Readable article body was empty", {
      httpStatus: fetched.status,
      retryable: false,
      partialUpdate: baseUpdate,
    });
  }

  blocks = sanitizeParsedBlocks(blocks);
  if (blocks.length === 0) {
    throw ProcessingFailure.parse(
      "Readable article body was empty after normalization",
      {
        httpStatus: fetched.status,
        retryable: false,
        partialUpdate: baseUpdate,
      },
    );
  }

  const parsedDocument = enforceParsedDocumentSizeLimit({
    version: PARSED_DOCUMENT_VERSION,
    kind: "article",
    title,
    byline: author,
    published_at: publishedAt,
    language_code: languageCode,
    blocks,
  }, baseUpdate);
  const metrics = deriveParsedDocumentMetrics(parsedDocument);
  const discoveryUrl = snapshot.sourceUrl ?? fetched.resolvedUrl;
  const discoveryDocument = snapshot.articleHtml
    ? parseDocument(`<html><body>${snapshot.articleHtml}</body></html>`)
    : sourceDocument;
  const parserDiagnostics = buildParserDiagnostics({
    route: PARSER_NAME,
    parserName: PARSER_NAME,
    selectedStrategyId: sourceSpecific?.strategyId ??
      (snapshot.articleHtml ? "archive-snapshot-html" : "archive-fallback"),
    parsedDocument,
    sourceKind: "article",
    candidates: [{
      id: sourceSpecific?.strategyId ??
        (snapshot.articleHtml ? "archive-snapshot-html" : "archive-fallback"),
      selected: true,
      qualityScore: null,
      totalScore: null,
      blocks,
      sourceKind: "article",
      notes: sourceSpecific ? ["source-specific"] : ["fallback"],
    }],
  });

  return {
    resolvedUrl: fetched.resolvedUrl,
    host: snapshot.sourceHost ?? fetched.host,
    siteName,
    sourceKind: "article",
    title,
    excerpt,
    author,
    publishedAt,
    languageCode,
    coverImageUrl,
    favicon,
    parsedDocument,
    wordCount: metrics.wordCount,
    estimatedReadSeconds: metrics.estimatedReadSeconds,
    blockCount: metrics.blockCount,
    imageCount: metrics.imageCount,
    httpStatus: fetched.status,
    fetchedAt: fetched.fetchedAt,
    sourceDiscoveryUrl: discoverArticleSourceUrl(
      discoveryDocument,
      discoveryUrl,
    ),
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
    parserDiagnostics,
  };
}
