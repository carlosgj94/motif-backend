import {
  isBloombergHost,
  isSubstackHost,
  looksLikeSubstackHtml,
} from "./detect.ts";
import { selectBestArticleQualityCandidate } from "./article_quality.ts";
import {
  selectGenericArticleFallbackContent,
} from "./generic_article_fallback.ts";
import type {
  ArchiveSnapshot,
  ContentMetadata,
  Document,
  ParsedBlock,
} from "./model.ts";
import {
  extractArchiveSourceRootHtml,
  parseDocument,
  selectArchivePrimaryArticle,
} from "./normalize.ts";
import {
  type BloombergArticleSelection,
  selectBestBloombergArticleContent,
} from "./bloomberg_article_heuristics.ts";
import {
  selectBestSubstackArticleContent,
  type SubstackArticleSelection,
} from "./substack_article_heuristics.ts";

export interface ArchiveSourceSelection {
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  siteName: string | null;
  blocks: ParsedBlock[];
  strategyId: string;
}

interface ArchiveSourceContext {
  sourceDocument: Document;
  snapshot: ArchiveSnapshot;
  metadata: ContentMetadata;
  resolvedUrl: string;
  sourceHtml: string;
  sourceRootHtml: string;
  sourceRootDocument: Document;
  mergedMetadata: ContentMetadata;
  normalizedSourceHost: string | null;
}

interface ArchiveSourceExtractor {
  id: string;
  matches: (input: ArchiveSourceContext) => boolean;
  select: (input: ArchiveSourceContext) => ArchiveSourceSelection | null;
}

const ARCHIVE_SOURCE_EXTRACTORS: readonly ArchiveSourceExtractor[] = [
  {
    id: "bloomberg",
    matches: (input) =>
      !!input.normalizedSourceHost &&
      isBloombergHost(input.normalizedSourceHost),
    select: (input) =>
      mapProviderSelection(
        selectBestBloombergArticleContent({
          document: input.sourceRootDocument,
          resolvedUrl: input.resolvedUrl,
          metadata: input.mergedMetadata,
        }),
        "bloomberg-archive-source",
      ),
  },
  {
    id: "substack",
    matches: (input) =>
      (!!input.normalizedSourceHost &&
        isSubstackHost(input.normalizedSourceHost)) ||
      looksLikeSubstackHtml(input.sourceRootHtml) ||
      looksLikeArchivedSubstackSource(input.sourceRootHtml),
    select: (input) =>
      mapProviderSelection(
        selectBestSubstackArticleContent({
          document: input.sourceRootDocument,
          html: input.sourceRootHtml,
          resolvedUrl: input.resolvedUrl,
          metadata: input.mergedMetadata,
        }),
        "substack-archive-source",
      ),
  },
  {
    id: "generic",
    matches: () => true,
    select: selectGenericArchiveSourceContent,
  },
] as const;

export function selectArchiveSourceSpecificContent(input: {
  sourceDocument: Document;
  snapshot: ArchiveSnapshot;
  metadata: ContentMetadata;
  resolvedUrl: string;
}): ArchiveSourceSelection | null {
  const sourceHtml = trimOrNull(input.snapshot.articleHtml);
  const sourceRootHtml = trimOrNull(
    (() => {
      const primaryArticle = selectArchivePrimaryArticle(input.sourceDocument);
      return primaryArticle
        ? extractArchiveSourceRootHtml(primaryArticle)
        : null;
    })(),
  );
  if (!sourceHtml && !sourceRootHtml) {
    return null;
  }
  const normalizedSourceRootHtml = sourceRootHtml ?? sourceHtml ?? "";
  const normalizedSourceHtml = sourceHtml ?? normalizedSourceRootHtml;

  const context: ArchiveSourceContext = {
    ...input,
    sourceHtml: normalizedSourceHtml,
    sourceRootHtml: normalizedSourceRootHtml,
    sourceRootDocument: parseDocument(
      `<html><body>${normalizedSourceRootHtml}</body></html>`,
    ),
    mergedMetadata: mergeArchiveMetadata(input.snapshot, input.metadata),
    normalizedSourceHost: normalizeHost(input.snapshot.sourceHost),
  };
  const selections: Array<{
    id: string;
    title: string | null;
    excerpt: string | null;
    author: string | null;
    publishedAt: string | null;
    siteName: string | null;
    coverImageUrl: string | null;
    blocks: ParsedBlock[];
    selection: ArchiveSourceSelection;
    preferenceBias: number;
  }> = [];

  for (const extractor of ARCHIVE_SOURCE_EXTRACTORS) {
    if (!extractor.matches(context)) {
      continue;
    }

    const selection = extractor.select(context);
    if (selection) {
      selections.push({
        id: selection.strategyId,
        title: selection.title,
        excerpt: selection.excerpt,
        author: selection.author,
        publishedAt: selection.publishedAt,
        siteName: selection.siteName,
        coverImageUrl: selection.coverImageUrl,
        blocks: selection.blocks,
        selection,
        preferenceBias: selection.strategyId.startsWith("generic-") ? 0 : 16,
      });
    }
  }

  return selectBestArticleQualityCandidate(selections)?.selection ?? null;
}

function selectGenericArchiveSourceContent(
  input: ArchiveSourceContext,
): ArchiveSourceSelection | null {
  const genericFallback = selectGenericArticleFallbackContent({
    document: input.sourceRootDocument,
    html: `<html><body>${input.sourceRootHtml}</body></html>`,
    resolvedUrl: input.resolvedUrl,
    metadata: input.mergedMetadata,
    publishedAt: input.mergedMetadata.publishedAt,
    siteName: input.mergedMetadata.siteName ??
      input.snapshot.sourceHost?.replace(/^www\./, "") ??
      null,
  });
  if (!genericFallback || genericFallback.blocks.length === 0) {
    return null;
  }

  return {
    title: genericFallback.title,
    excerpt: genericFallback.excerpt,
    author: genericFallback.author,
    publishedAt: genericFallback.publishedAt,
    coverImageUrl: genericFallback.coverImageUrl,
    siteName: genericFallback.siteName,
    blocks: genericFallback.blocks,
    strategyId: `generic-archive-source:${genericFallback.strategyId}`,
  };
}

function mergeArchiveMetadata(
  snapshot: ArchiveSnapshot,
  metadata: ContentMetadata,
): ContentMetadata {
  return {
    title: snapshot.title ?? metadata.title,
    description: snapshot.description ?? metadata.description,
    author: snapshot.author ?? metadata.author,
    publishedAt: snapshot.publishedAt ?? metadata.publishedAt,
    languageCode: metadata.languageCode,
    coverImageUrl: snapshot.coverImageUrl ?? metadata.coverImageUrl,
    siteName: snapshot.siteName ?? metadata.siteName ?? snapshot.sourceHost ??
      null,
  };
}

function mapProviderSelection(
  selection: BloombergArticleSelection | SubstackArticleSelection | null,
  strategyId: string,
): ArchiveSourceSelection | null {
  if (!selection) {
    return null;
  }

  return {
    title: selection.title,
    excerpt: selection.excerpt,
    author: selection.author,
    publishedAt: selection.publishedAt,
    coverImageUrl: selection.coverImageUrl,
    siteName: selection.siteName,
    blocks: selection.blocks,
    strategyId: `${strategyId}:${selection.strategyId}`,
  };
}

function looksLikeArchivedSubstackSource(html: string): boolean {
  return /newsletter-post|available-content|class=["'][^"']*\bbody\s+markup\b/i
    .test(html);
}

function normalizeHost(host: string | null | undefined): string | null {
  const normalized = trimOrNull(host)?.toLowerCase().replace(/^www\./, "") ??
    null;
  return normalized || null;
}

function trimOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}
