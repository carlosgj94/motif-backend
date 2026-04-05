import {
  MAX_AUTHOR_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_LANGUAGE_CODE_CHARS,
  MAX_SITE_NAME_CHARS,
  MAX_TITLE_CHARS,
  PARSED_DOCUMENT_VERSION,
  PARSER_VERSION,
} from "../config.ts";
import {
  rankArticleQualityCandidates,
  selectPreferredArticleQualityCandidate,
} from "../article_quality.ts";
import { buildParserDiagnostics } from "../diagnostics.ts";
import { selectGenericArticleFallbackContent } from "../generic_article_fallback.ts";
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
import { selectBestSubstackArticleContent } from "../substack_article_heuristics.ts";

const PARSER_NAME = "substack-article";

export async function processSubstackArticle(
  fetched: FetchDocumentResult,
  options: ParseFetchedDocumentOptions = {},
): Promise<ProcessedContent> {
  const sourceDocument = parseDocument(fetched.html);
  const metadata = collectMetadata(sourceDocument);
  const favicon = await options.faviconFetcher?.(
    sourceDocument,
    fetched.resolvedUrl,
  ) ?? null;
  const selected = selectBestSubstackArticleContent({
    document: sourceDocument,
    html: fetched.html,
    resolvedUrl: fetched.resolvedUrl,
    metadata,
  });
  const genericFallback = selectGenericArticleFallbackContent({
    document: sourceDocument,
    html: fetched.html,
    resolvedUrl: fetched.resolvedUrl,
    metadata,
    publishedAt: metadata.publishedAt,
    siteName: metadata.siteName ?? fetched.host,
  });
  const ranked = selectPreferredArticleQualityCandidate({
    preferred: selected
      ? {
        id: `substack:${selected.strategyId}`,
        title: selected.title,
        excerpt: selected.excerpt,
        author: selected.author,
        publishedAt: selected.publishedAt,
        siteName: selected.siteName,
        coverImageUrl: selected.coverImageUrl,
        blocks: selected.blocks,
        selection: selected,
        preferenceBias: 20,
      }
      : null,
    fallback: genericFallback
      ? {
        id: `generic:${genericFallback.strategyId}`,
        title: genericFallback.title,
        excerpt: genericFallback.excerpt,
        author: genericFallback.author,
        publishedAt: genericFallback.publishedAt,
        siteName: genericFallback.siteName,
        coverImageUrl: genericFallback.coverImageUrl,
        blocks: genericFallback.blocks,
        selection: genericFallback,
      }
      : null,
  });
  const resolvedSelection = ranked?.selection ?? selected ?? genericFallback;
  const qualityCandidates = rankArticleQualityCandidates([
    ...(selected
      ? [{
        id: `substack:${selected.strategyId}`,
        title: selected.title,
        excerpt: selected.excerpt,
        author: selected.author,
        publishedAt: selected.publishedAt,
        siteName: selected.siteName,
        coverImageUrl: selected.coverImageUrl,
        blocks: selected.blocks,
        selection: selected,
        preferenceBias: 20,
      }]
      : []),
    ...(genericFallback
      ? [{
        id: `generic:${genericFallback.strategyId}`,
        title: genericFallback.title,
        excerpt: genericFallback.excerpt,
        author: genericFallback.author,
        publishedAt: genericFallback.publishedAt,
        siteName: genericFallback.siteName,
        coverImageUrl: genericFallback.coverImageUrl,
        blocks: genericFallback.blocks,
        selection: genericFallback,
      }]
      : []),
  ]);

  const title = trimText(
    selected?.title ?? resolvedSelection?.title ?? metadata.title ?? null,
    MAX_TITLE_CHARS,
  );
  const author = trimText(
    selected?.author ?? resolvedSelection?.author ?? metadata.author ?? null,
    MAX_AUTHOR_CHARS,
  );
  const excerpt = trimText(
    selected?.excerpt ?? resolvedSelection?.excerpt ?? metadata.description ??
      null,
    MAX_EXCERPT_CHARS,
  );
  const publishedAt = selected?.publishedAt ?? resolvedSelection?.publishedAt ??
    metadata.publishedAt;
  const siteName = trimText(
    selected?.siteName ?? resolvedSelection?.siteName ?? metadata.siteName ??
      fetched.host,
    MAX_SITE_NAME_CHARS,
  );
  const languageCode = trimText(metadata.languageCode, MAX_LANGUAGE_CODE_CHARS);
  const coverImageUrl = trimUrl(
    selected?.coverImageUrl ?? resolvedSelection?.coverImageUrl ??
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

  if (!resolvedSelection || resolvedSelection.blocks.length === 0) {
    throw ProcessingFailure.parse(
      "Could not recover readable Substack article content",
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
    blocks: resolvedSelection.blocks,
  }, baseUpdate);
  const metrics = deriveParsedDocumentMetrics(parsedDocument);
  const parserDiagnostics = buildParserDiagnostics({
    route: PARSER_NAME,
    parserName: PARSER_NAME,
    selectedStrategyId: resolvedSelection?.strategyId ?? null,
    parsedDocument,
    sourceKind: "article",
    candidates: qualityCandidates.map((candidate) => ({
      id: candidate.id,
      selected:
        candidate.selection.strategyId === resolvedSelection?.strategyId,
      qualityScore: candidate.qualityScore,
      totalScore: candidate.totalScore,
      blocks: candidate.selection.blocks,
      sourceKind: "article",
      notes: candidate.id.startsWith("substack:")
        ? ["provider-specific"]
        : ["generic-fallback"],
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
      sourceDocument,
      fetched.resolvedUrl,
    ),
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
    parserDiagnostics,
  };
}
