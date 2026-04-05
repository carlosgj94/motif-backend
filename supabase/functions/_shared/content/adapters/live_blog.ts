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
import {
  rankLiveBlogCandidates,
  selectBestLiveBlogContent,
} from "../live_blog_heuristics.ts";
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
  sanitizeParsedBlocks,
  summarizeBlocks,
  trimText,
  trimUrl,
} from "../normalize.ts";

const PARSER_NAME = "live-blog";

export async function processLiveBlog(
  fetched: FetchDocumentResult,
  options: ParseFetchedDocumentOptions = {},
): Promise<ProcessedContent> {
  const document = parseDocument(fetched.html);
  const metadata = collectMetadata(document);
  const favicon =
    await options.faviconFetcher?.(document, fetched.resolvedUrl) ?? null;
  const selected = selectBestLiveBlogContent({
    document,
    resolvedUrl: fetched.resolvedUrl,
    metadata,
  });
  const rankedLiveBlogCandidates = rankLiveBlogCandidates({
    document,
    resolvedUrl: fetched.resolvedUrl,
    metadata,
  });
  const genericFallback = selectGenericArticleFallbackContent({
    document,
    html: fetched.html,
    resolvedUrl: fetched.resolvedUrl,
    metadata,
    publishedAt: metadata.publishedAt,
    siteName: metadata.siteName ?? fetched.host,
  });
  const ranked = selectPreferredArticleQualityCandidate({
    preferred: selected
      ? {
        id: `live-blog:${selected.strategyId}`,
        title: selected.title,
        excerpt: selected.excerpt,
        author: selected.author,
        publishedAt: selected.publishedAt,
        siteName: selected.siteName,
        coverImageUrl: selected.coverImageUrl,
        blocks: selected.blocks,
        selection: selected,
        preferenceBias: 24,
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
    fallbackOverrideMargin: 36,
  });
  const resolvedSelection = ranked?.selection ?? selected ?? genericFallback;
  const qualityCandidates = rankArticleQualityCandidates([
    ...(selected
      ? [{
        id: `live-blog:${selected.strategyId}`,
        title: selected.title,
        excerpt: selected.excerpt,
        author: selected.author,
        publishedAt: selected.publishedAt,
        siteName: selected.siteName,
        coverImageUrl: selected.coverImageUrl,
        blocks: selected.blocks,
        selection: selected,
        preferenceBias: 24,
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
  const blocks = sanitizeParsedBlocks(resolvedSelection?.blocks ?? []);
  const excerpt = trimText(
    selected?.excerpt ?? resolvedSelection?.excerpt ??
      summarizeBlocks(blocks) ??
      metadata.description ?? null,
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

  if (blocks.length === 0) {
    throw ProcessingFailure.parse(
      "Could not recover readable live blog content",
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
  const parserDiagnostics = buildParserDiagnostics({
    route: PARSER_NAME,
    parserName: PARSER_NAME,
    selectedStrategyId: resolvedSelection?.strategyId ?? null,
    parsedDocument,
    sourceKind: "article",
    candidates: [
      ...rankedLiveBlogCandidates.map((candidate) => ({
        id: `live-blog-internal:${candidate.id}`,
        selected: candidate.id === selected?.strategyId,
        qualityScore: candidate.score,
        totalScore: candidate.score,
        blocks: candidate.blocks,
        sourceKind: "article" as const,
        notes: ["provider-internal"],
      })),
      ...qualityCandidates.map((candidate) => ({
        id: candidate.id,
        selected:
          candidate.selection.strategyId === resolvedSelection?.strategyId,
        qualityScore: candidate.qualityScore,
        totalScore: candidate.totalScore,
        blocks: candidate.selection.blocks,
        sourceKind: "article" as const,
        notes: candidate.id.startsWith("live-blog:")
          ? ["provider-specific"]
          : ["generic-fallback"],
      })),
    ],
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
    sourceDiscoveryUrl: discoverArticleSourceUrl(document, fetched.resolvedUrl),
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
    parserDiagnostics,
  };
}
