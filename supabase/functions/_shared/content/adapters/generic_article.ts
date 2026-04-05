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
import {
  rankGenericArticleCandidates,
  selectBestGenericArticleCandidate,
} from "../generic_article_heuristics.ts";
import {
  selectGenericArticleCoverImage,
  selectGenericArticleExcerpt,
} from "../generic_article_metadata.ts";
import type {
  FetchDocumentResult,
  ParseFetchedDocumentOptions,
  ProcessedContent,
} from "../model.ts";
import { ProcessingFailure } from "../model.ts";
import {
  buildBaseUpdate,
  collectMetadata,
  deriveParsedDocumentMetrics,
  discoverArticleSourceUrl,
  enforceParsedDocumentSizeLimit,
  parseDocument,
  trimText,
  trimUrl,
} from "../normalize.ts";

const PARSER_NAME = "generic-article";

export async function processGenericArticle(
  fetched: FetchDocumentResult,
  options: ParseFetchedDocumentOptions = {},
): Promise<ProcessedContent> {
  const sourceDocument = parseDocument(fetched.html);
  const metadata = collectMetadata(sourceDocument);
  const favicon = await options.faviconFetcher?.(
    sourceDocument,
    fetched.resolvedUrl,
  ) ?? null;

  const selectedCandidate = selectBestGenericArticleCandidate({
    html: fetched.html,
    resolvedUrl: fetched.resolvedUrl,
    metadata,
  });
  const rankedCandidates = rankGenericArticleCandidates({
    html: fetched.html,
    resolvedUrl: fetched.resolvedUrl,
    metadata,
  });
  const title = trimText(
    selectedCandidate?.title ?? metadata.title ?? null,
    MAX_TITLE_CHARS,
  );
  const author = trimText(
    selectedCandidate?.author ?? metadata.author ?? null,
    MAX_AUTHOR_CHARS,
  );
  const excerpt = trimText(
    selectGenericArticleExcerpt({
      metadataDescription: metadata.description,
      candidateExcerpt: selectedCandidate?.excerpt ?? null,
      title,
    }),
    MAX_EXCERPT_CHARS,
  );
  const siteName = trimText(
    metadata.siteName ?? fetched.host,
    MAX_SITE_NAME_CHARS,
  );
  const languageCode = trimText(metadata.languageCode, MAX_LANGUAGE_CODE_CHARS);
  const coverImageUrl = trimUrl(
    selectGenericArticleCoverImage({
      document: sourceDocument,
      resolvedUrl: fetched.resolvedUrl,
      metadata,
      title,
      author,
    }),
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
    publishedAt: metadata.publishedAt,
    languageCode,
    coverImageUrl,
  });

  if (!selectedCandidate || selectedCandidate.blocks.length === 0) {
    throw ProcessingFailure.parse("Readable article body was empty", {
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
    published_at: metadata.publishedAt,
    language_code: languageCode,
    blocks: selectedCandidate.blocks,
  }, baseUpdate);
  const metrics = deriveParsedDocumentMetrics(parsedDocument);
  const parserDiagnostics = buildParserDiagnostics({
    route: PARSER_NAME,
    parserName: PARSER_NAME,
    selectedStrategyId: selectedCandidate.strategyId,
    parsedDocument,
    sourceKind: "article",
    candidates: rankedCandidates.map((candidate) => ({
      id: candidate.id,
      selected: candidate.id === selectedCandidate.strategyId,
      qualityScore: candidate.score,
      totalScore: candidate.score,
      blocks: candidate.blocks,
      sourceKind: "article",
    })),
  });

  return {
    resolvedUrl: fetched.resolvedUrl,
    host: fetched.host,
    siteName,
    sourceKind: "article",
    title,
    excerpt,
    author,
    publishedAt: metadata.publishedAt,
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
      sourceDocument,
      fetched.resolvedUrl,
    ),
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
    parserDiagnostics,
  };
}
