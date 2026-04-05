import {
  type ArticleQualityCandidate,
  selectBestArticleQualityCandidate,
} from "./article_quality.ts";
import { rankGenericArticleCandidates } from "./generic_article_heuristics.ts";
import {
  selectGenericArticleCoverImage,
  selectGenericArticleExcerpt,
} from "./generic_article_metadata.ts";
import type {
  ContentMetadata,
  Document,
  Element,
  ParsedBlock,
} from "./model.ts";
import {
  buildArticleBlocks,
  parseDocument,
  sanitizeParsedBlocks,
} from "./normalize.ts";

export interface AggressiveArticleRecoverySelection {
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  siteName: string | null;
  blocks: ParsedBlock[];
  strategyId: string;
  notes: string[];
}

interface RecoveryCandidateSelection
  extends AggressiveArticleRecoverySelection {
  notes: string[];
}

const RECOVERY_CONTAINER_SELECTORS =
  "article, main, [role='main'], section, div";
const MAX_DENSE_CONTAINER_SCAN = 300;
const MAX_DENSE_CONTAINER_CANDIDATES = 6;
const MIN_RECOVERY_TEXT_LENGTH = 500;
const MIN_RECOVERY_PARAGRAPH_LIKE_NODES = 3;
const RECOVERY_NOISE_SELECTORS = [
  "aside",
  "nav",
  "footer",
  "form",
  "script",
  "style",
  "noscript",
  "dialog",
  "button",
  "svg",
  "canvas",
  "iframe",
  "[role='navigation']",
  "[role='complementary']",
  "[role='search']",
  ".newsletter",
  ".subscription",
  ".subscribe",
  ".sign-up",
  ".signup",
  ".social-share",
  ".share-buttons",
  ".comments",
  ".related",
  ".recommended",
  ".read-more",
  ".post-footer",
  ".entry-footer",
  ".article-footer",
  ".button-wrapper",
] as const;
const LOW_VALUE_BLOCK_PATTERNS = [
  /^(share|copy link|follow|get alerts|print|restack)\b/i,
  /^(subscribe|sign up|sign in|newsletter|join now)\b/i,
  /^(read more|related|recommended|more from|up next)\b/i,
  /^(contact us|confidential tip|site feedback)\b/i,
  /^(comments?|discussion|reply)\b/i,
  /^by continuing\b/i,
  /^privacy policy\b/i,
  /^terms of service\b/i,
  /^(images?|im[aá]genes?)\s*\|/i,
  /^(en|in)\s+[A-Z][^|]{0,80}\s*\|/i,
];

export function selectAggressiveArticleRecoveryContent(input: {
  document: Document;
  html: string;
  resolvedUrl: string;
  metadata: ContentMetadata;
  publishedAt?: string | null;
  siteName?: string | null;
}): AggressiveArticleRecoverySelection | null {
  const candidates = collectRecoveryCandidates(input);
  const ranked = selectBestArticleQualityCandidate(candidates);
  if (!ranked) {
    return null;
  }

  return ranked.selection;
}

function collectRecoveryCandidates(input: {
  document: Document;
  html: string;
  resolvedUrl: string;
  metadata: ContentMetadata;
  publishedAt?: string | null;
  siteName?: string | null;
}): ArticleQualityCandidate<RecoveryCandidateSelection>[] {
  const candidates: ArticleQualityCandidate<RecoveryCandidateSelection>[] = [];
  const seenSignatures = new Set<string>();

  for (
    const genericCandidate of rankGenericArticleCandidates({
      html: input.html,
      resolvedUrl: input.resolvedUrl,
      metadata: input.metadata,
    }).slice(0, 4)
  ) {
    const selection = buildRecoverySelection({
      strategyId: `generic:${genericCandidate.id}`,
      blocks: genericCandidate.blocks,
      document: input.document,
      resolvedUrl: input.resolvedUrl,
      metadata: input.metadata,
      title: genericCandidate.title ?? input.metadata.title,
      author: genericCandidate.author ?? input.metadata.author,
      excerpt: genericCandidate.excerpt ?? null,
      publishedAt: input.publishedAt ?? input.metadata.publishedAt,
      siteName: input.siteName ?? input.metadata.siteName,
      notes: ["generic-recovery", genericCandidate.id],
    });
    if (selection && rememberSelection(selection, seenSignatures)) {
      candidates.push(toQualityCandidate(selection, 0));
    }
  }

  for (const element of collectDenseTextContainers(input.document)) {
    const selection = buildRecoverySelection({
      strategyId: `dense:${element.id}`,
      blocks: buildArticleBlocks(
        sanitizeRecoveryContainerHtml(element.node),
        input.resolvedUrl,
      ),
      document: input.document,
      resolvedUrl: input.resolvedUrl,
      metadata: input.metadata,
      title: input.metadata.title,
      author: input.metadata.author,
      excerpt: null,
      publishedAt: input.publishedAt ?? input.metadata.publishedAt,
      siteName: input.siteName ?? input.metadata.siteName,
      notes: ["dense-container", element.id],
    });
    if (selection && rememberSelection(selection, seenSignatures)) {
      candidates.push(toQualityCandidate(selection, 8));
    }
  }

  return candidates;
}

function buildRecoverySelection(input: {
  strategyId: string;
  blocks: ParsedBlock[];
  document: Document;
  resolvedUrl: string;
  metadata: ContentMetadata;
  title: string | null;
  author: string | null;
  excerpt: string | null;
  publishedAt: string | null;
  siteName: string | null;
  notes: string[];
}): RecoveryCandidateSelection | null {
  const cleanedBlocks = aggressivelyCleanBlocks(input.blocks, {
    title: input.title,
    excerpt: input.excerpt ?? input.metadata.description,
    author: input.author,
  });
  if (cleanedBlocks.length === 0) {
    return null;
  }

  return {
    title: input.title,
    excerpt: selectGenericArticleExcerpt({
      metadataDescription: input.metadata.description,
      candidateExcerpt: input.excerpt,
      title: input.title,
    }),
    author: input.author,
    publishedAt: input.publishedAt,
    coverImageUrl: selectGenericArticleCoverImage({
      document: input.document,
      resolvedUrl: input.resolvedUrl,
      metadata: input.metadata,
      title: input.title,
      author: input.author,
    }),
    siteName: input.siteName,
    blocks: cleanedBlocks,
    strategyId: input.strategyId,
    notes: input.notes,
  };
}

function toQualityCandidate(
  selection: RecoveryCandidateSelection,
  preferenceBias: number,
): ArticleQualityCandidate<RecoveryCandidateSelection> {
  return {
    id: selection.strategyId,
    title: selection.title,
    excerpt: selection.excerpt,
    author: selection.author,
    publishedAt: selection.publishedAt,
    siteName: selection.siteName,
    coverImageUrl: selection.coverImageUrl,
    blocks: selection.blocks,
    selection,
    preferenceBias,
  };
}

function rememberSelection(
  selection: RecoveryCandidateSelection,
  seenSignatures: Set<string>,
): boolean {
  const signature = selection.blocks
    .slice(0, 5)
    .map((block) => normalizeText(textFromBlock(block) ?? ""))
    .filter(Boolean)
    .join(" | ");
  if (!signature || seenSignatures.has(signature)) {
    return false;
  }

  seenSignatures.add(signature);
  return true;
}

function aggressivelyCleanBlocks(
  blocks: ParsedBlock[],
  metadata: {
    title: string | null;
    excerpt: string | null;
    author: string | null;
  },
): ParsedBlock[] {
  const sanitized = sanitizeParsedBlocks(blocks).filter((block) =>
    block.type !== "image"
  );
  if (sanitized.length === 0) {
    return [];
  }

  const deduped: ParsedBlock[] = [];
  const seenText = new Set<string>();

  for (const block of sanitized) {
    const text = textFromBlock(block);
    const normalized = normalizeText(text);
    if (normalized && normalized.length > 24) {
      if (seenText.has(normalized)) {
        continue;
      }
      seenText.add(normalized);
    }

    if (text && looksLikeInlineBoilerplate(text)) {
      continue;
    }

    deduped.push(block);
  }

  let startIndex = 0;
  while (startIndex < deduped.length) {
    const text = textFromBlock(deduped[startIndex]);
    if (!text || !looksLikeLeadNoise(text, metadata)) {
      break;
    }
    startIndex += 1;
  }

  let endIndex = deduped.length;
  while (endIndex > startIndex) {
    const text = textFromBlock(deduped[endIndex - 1]);
    if (!text || !looksLikeTrailingNoise(text, metadata)) {
      break;
    }
    endIndex -= 1;
  }

  return deduped.slice(startIndex, endIndex);
}

function collectDenseTextContainers(
  document: Document,
): Array<{ id: string; node: Element }> {
  const elements = Array.from(
    document.querySelectorAll(RECOVERY_CONTAINER_SELECTORS),
  ).slice(0, MAX_DENSE_CONTAINER_SCAN) as Element[];

  return elements
    .map((element, index) => ({
      id: `container-${index + 1}`,
      node: element,
      score: scoreDenseContainer(element),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_DENSE_CONTAINER_CANDIDATES)
    .map(({ id, node }) => ({ id, node }));
}

function scoreDenseContainer(element: Element): number {
  const text = normalizeWhitespace(element.textContent ?? "");
  if (text.length < MIN_RECOVERY_TEXT_LENGTH) {
    return 0;
  }

  const paragraphLikeCount = element.querySelectorAll(
    "p, blockquote, li, pre, code",
  ).length;
  if (paragraphLikeCount < MIN_RECOVERY_PARAGRAPH_LIKE_NODES) {
    return 0;
  }

  const linkTextLength = Array.from(element.querySelectorAll("a"))
    .map((anchor) =>
      normalizeWhitespace((anchor as Element).textContent ?? "").length
    )
    .reduce((total, value) => total + value, 0);

  return text.length +
    paragraphLikeCount * 180 -
    linkTextLength * 2 -
    element.querySelectorAll("form, button, input").length * 400;
}

function sanitizeRecoveryContainerHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (
    const noisyNode of Array.from(
      clone.querySelectorAll(RECOVERY_NOISE_SELECTORS.join(",")),
    ) as Element[]
  ) {
    noisyNode.remove();
  }

  for (
    const candidate of Array.from(clone.querySelectorAll("*")) as Element[]
  ) {
    const className = candidate.getAttribute("class")?.toLowerCase() ?? "";
    const id = candidate.getAttribute("id")?.toLowerCase() ?? "";
    if (
      /(comment|newsletter|subscribe|share|related|recommended|footer)/i.test(
        `${className} ${id}`,
      )
    ) {
      candidate.remove();
    }
  }

  return clone.innerHTML;
}

function looksLikeLeadNoise(
  text: string,
  metadata: {
    title: string | null;
    excerpt: string | null;
    author: string | null;
  },
): boolean {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return false;
  }

  const normalizedTitle = normalizeText(metadata.title);
  const normalizedExcerpt = normalizeText(metadata.excerpt);
  const normalizedAuthor = normalizeText(metadata.author);

  return normalizedText === normalizedTitle ||
    normalizedText === normalizedExcerpt ||
    normalizedText === normalizedAuthor ||
    /^by\s+/.test(normalizedText) ||
    looksLikeDateLine(text) ||
    looksLikeTrailingNoise(text, metadata);
}

function looksLikeTrailingNoise(
  text: string,
  metadata: {
    title: string | null;
    excerpt: string | null;
    author: string | null;
  },
): boolean {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return false;
  }

  const normalizedTitle = normalizeText(metadata.title);
  const normalizedExcerpt = normalizeText(metadata.excerpt);
  return normalizedText === normalizedTitle ||
    normalizedText === normalizedExcerpt ||
    looksLikeInlineBoilerplate(text);
}

function looksLikeInlineBoilerplate(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized || normalized.length > 220) {
    return false;
  }

  return LOW_VALUE_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function looksLikeDateLine(value: string): boolean {
  const trimmed = normalizeWhitespace(value);
  if (!trimmed || trimmed.length > 80) {
    return false;
  }

  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp);
}

function textFromBlock(block: ParsedBlock): string | null {
  switch (block.type) {
    case "paragraph":
    case "quote":
    case "heading":
    case "code":
      return block.text;
    case "list":
      return block.items.join(" ");
    case "thread_post":
      return block.text;
    case "image":
      return block.caption ?? block.alt ?? null;
  }
}

function normalizeText(value: string | null | undefined): string {
  return normalizeWhitespace(value ?? "")
    .toLowerCase()
    .replace(/[“”"'.!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWhitespace(value: string): string {
  return parseDocument(`<html><body>${value}</body></html>`).body?.textContent
    ?.replace(/\s+/g, " ")
    .trim() ?? "";
}
