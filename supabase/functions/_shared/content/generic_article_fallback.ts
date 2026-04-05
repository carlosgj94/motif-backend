import {
  selectBestGenericArticleCandidate,
} from "./generic_article_heuristics.ts";
import {
  selectGenericArticleCoverImage,
  selectGenericArticleExcerpt,
} from "./generic_article_metadata.ts";
import type { ContentMetadata, Document, ParsedBlock } from "./model.ts";

export interface GenericArticleFallbackSelection {
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  siteName: string | null;
  blocks: ParsedBlock[];
  strategyId: string;
}

const LOW_VALUE_LEAD_PATTERNS = [
  /^(gift this article|share|copy link)\b/i,
  /^(subscribe|sign up|newsletter|follow|get alerts)\b/i,
  /^(related|recommended|more from|up next)\b/i,
] as const;

export function selectGenericArticleFallbackContent(input: {
  document: Document;
  html: string;
  resolvedUrl: string;
  metadata: ContentMetadata;
  publishedAt?: string | null;
  siteName?: string | null;
}): GenericArticleFallbackSelection | null {
  const candidate = selectBestGenericArticleCandidate({
    html: input.html,
    resolvedUrl: input.resolvedUrl,
    metadata: input.metadata,
  });
  if (!candidate || candidate.blocks.length === 0) {
    return null;
  }

  const title = candidate.title ?? input.metadata.title;
  const author = candidate.author ?? input.metadata.author;
  const excerpt = selectGenericArticleExcerpt({
    metadataDescription: input.metadata.description,
    candidateExcerpt: candidate.excerpt,
    title,
  });
  const blocks = stripLeadingMetadataEchoBlocks(candidate.blocks, {
    title,
    excerpt,
  });
  if (blocks.length === 0) {
    return null;
  }

  return {
    title,
    excerpt,
    author,
    publishedAt: input.publishedAt ?? input.metadata.publishedAt,
    coverImageUrl: selectGenericArticleCoverImage({
      document: input.document,
      resolvedUrl: input.resolvedUrl,
      metadata: input.metadata,
      title,
      author,
    }),
    siteName: input.siteName ?? input.metadata.siteName,
    blocks,
    strategyId: candidate.strategyId,
  };
}

function stripLeadingMetadataEchoBlocks(
  blocks: ParsedBlock[],
  metadata: {
    title: string | null;
    excerpt: string | null;
  },
): ParsedBlock[] {
  const normalizedTitle = normalizeComparableText(metadata.title);
  const normalizedExcerpt = normalizeComparableText(metadata.excerpt);
  let startIndex = 0;

  while (startIndex < blocks.length) {
    const text = textFromLeadingBlock(blocks[startIndex]);
    if (!text) {
      break;
    }

    const normalizedText = normalizeComparableText(text);
    if (
      normalizedText &&
      (
        (normalizedTitle && normalizedText === normalizedTitle) ||
        (normalizedExcerpt && normalizedText === normalizedExcerpt) ||
        looksLikeLowValueLeadText(text)
      )
    ) {
      startIndex += 1;
      continue;
    }

    break;
  }

  return blocks.slice(startIndex);
}

function textFromLeadingBlock(block: ParsedBlock): string | null {
  switch (block.type) {
    case "paragraph":
    case "quote":
    case "heading":
      return block.text;
    default:
      return null;
  }
}

function normalizeComparableText(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase()
    .replace(/[“”"'.!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function looksLikeLowValueLeadText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.length > 180) {
    return false;
  }

  return LOW_VALUE_LEAD_PATTERNS.some((pattern) => pattern.test(normalized));
}
