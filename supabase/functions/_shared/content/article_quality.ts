import type { ParsedBlock } from "./model.ts";
import { deriveParsedDocumentMetrics } from "./normalize.ts";

const SUSPICIOUS_BLOCK_PATTERNS = [
  /^(share|copy link|follow|following|get alerts)\b/i,
  /^(subscribe|sign up|sign in|newsletter|restack)\b/i,
  /^(read more|related|recommended|more from|up next)\b/i,
  /^(contact us|confidential tip|site feedback)\b/i,
  /^(discussion|comments?|reply)\b/i,
] as const;

export interface ArticleQualityCandidate<TSelection> {
  id: string;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  siteName: string | null;
  coverImageUrl: string | null;
  blocks: ParsedBlock[];
  selection: TSelection;
  preferenceBias?: number;
}

export interface RankedArticleQualityCandidate<TSelection> {
  id: string;
  qualityScore: number;
  totalScore: number;
  selection: TSelection;
}

export function rankArticleQualityCandidates<TSelection>(
  candidates: readonly ArticleQualityCandidate<TSelection>[],
): RankedArticleQualityCandidate<TSelection>[] {
  return candidates
    .filter((candidate) => candidate.blocks.length > 0)
    .map((candidate) => {
      const qualityScore = scoreArticleQuality(candidate);
      return {
        id: candidate.id,
        qualityScore,
        totalScore: qualityScore + (candidate.preferenceBias ?? 0),
        selection: candidate.selection,
      };
    })
    .sort((left, right) =>
      right.totalScore - left.totalScore ||
      right.qualityScore - left.qualityScore
    );
}

export function selectBestArticleQualityCandidate<TSelection>(
  candidates: readonly ArticleQualityCandidate<TSelection>[],
): RankedArticleQualityCandidate<TSelection> | null {
  return rankArticleQualityCandidates(candidates)[0] ?? null;
}

export function selectPreferredArticleQualityCandidate<TSelection>(input: {
  preferred: ArticleQualityCandidate<TSelection> | null;
  fallback: ArticleQualityCandidate<TSelection> | null;
  minimumPreferredQuality?: number;
  fallbackOverrideMargin?: number;
}): RankedArticleQualityCandidate<TSelection> | null {
  const preferredRanked = input.preferred
    ? rankArticleQualityCandidates([input.preferred])[0] ?? null
    : null;
  const fallbackRanked = input.fallback
    ? rankArticleQualityCandidates([input.fallback])[0] ?? null
    : null;

  if (!preferredRanked) {
    return fallbackRanked;
  }

  if (!fallbackRanked) {
    return preferredRanked;
  }

  const minimumPreferredQuality = input.minimumPreferredQuality ?? 18;
  const fallbackOverrideMargin = input.fallbackOverrideMargin ?? 18;

  if (
    preferredRanked.qualityScore >= minimumPreferredQuality &&
    fallbackRanked.totalScore <
      preferredRanked.totalScore + fallbackOverrideMargin
  ) {
    return preferredRanked;
  }

  return fallbackRanked.totalScore > preferredRanked.totalScore
    ? fallbackRanked
    : preferredRanked;
}

function scoreArticleQuality(input: {
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  siteName: string | null;
  coverImageUrl: string | null;
  blocks: ParsedBlock[];
}): number {
  const metrics = deriveParsedDocumentMetrics({ blocks: input.blocks });
  const paragraphBlocks = input.blocks.filter((block) =>
    block.type === "paragraph" || block.type === "quote"
  );
  const headingCount = input.blocks.filter((block) => block.type === "heading")
    .length;
  const listCount =
    input.blocks.filter((block) => block.type === "list").length;
  const codeCount =
    input.blocks.filter((block) => block.type === "code").length;
  const duplicatePenalty = paragraphBlocks.length - new Set(
    paragraphBlocks.map((block) => normalizeText(block.text)),
  ).size;
  const suspiciousBlockCount = input.blocks.filter((block) => {
    const text = textFromBlock(block);
    return text ? looksSuspiciousBlock(text) : false;
  }).length;
  const firstTextBlock = input.blocks.find((block) => textFromBlock(block));
  const firstText = firstTextBlock ? textFromBlock(firstTextBlock) : null;

  let score = 0;
  score += Math.min(140, metrics.wordCount / 10);
  score += Math.min(paragraphBlocks.length, 24) * 3.1;
  score += Math.min(headingCount, 8) * 1.6;
  score += Math.min(listCount, 4) * 1.4;
  score += Math.min(codeCount, 3) * 1.6;
  score += input.title ? 8 : 0;
  score += input.author ? 5 : 0;
  score += input.publishedAt ? 4 : 0;
  score += input.excerpt ? 4 : 0;
  score += input.siteName ? 2 : 0;
  score += input.coverImageUrl ? 1 : 0;
  score -= metrics.imageCount * 6;
  score -= duplicatePenalty * 8;
  score -= suspiciousBlockCount * 16;

  if (metrics.wordCount < 80) {
    score -= paragraphBlocks.length >= 3 ? 20 : 72;
  } else if (metrics.wordCount < 160) {
    score -= paragraphBlocks.length >= 3 ? 8 : 32;
  } else if (metrics.wordCount < 260) {
    score -= paragraphBlocks.length >= 3 ? 4 : 12;
  }

  if (paragraphBlocks.length === 0 && metrics.wordCount < 120) {
    score -= 36;
  }

  if (input.blocks.length <= 2 && metrics.wordCount < 180) {
    score -= 28;
  }

  if (input.blocks.every((block) => block.type === "image")) {
    score -= 180;
  }

  if (
    input.title &&
    firstText &&
    normalizeText(firstText) === normalizeText(input.title)
  ) {
    score -= 18;
  }

  return score;
}

function textFromBlock(block: ParsedBlock): string | null {
  switch (block.type) {
    case "paragraph":
    case "quote":
    case "code":
      return block.text;
    case "heading":
      return block.text;
    case "list":
      return block.items.join(" ");
    case "thread_post":
      return block.text;
    case "image":
      return block.caption ?? block.alt ?? null;
  }
}

function looksSuspiciousBlock(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length > 180) {
    return false;
  }

  return SUSPICIOUS_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
