import { Readability } from "npm:@mozilla/readability@0.6.0";

import type {
  ContentMetadata,
  Document,
  Element,
  ParsedBlock,
} from "./model.ts";
import {
  buildArticleBlocks,
  deriveParsedDocumentMetrics,
  extractFallbackArticleHtml,
  parseDocument,
  sanitizeParsedBlocks,
  summarizeBlocks,
} from "./normalize.ts";

interface CandidateCleanupResult {
  blocks: ParsedBlock[];
  removedBoilerplateCount: number;
  removedImageCount: number;
  removedLeadingTitleCount: number;
  removedTrailingCount: number;
}

export interface RankedGenericArticleCandidate {
  id: string;
  title: string | null;
  author: string | null;
  excerpt: string | null;
  blocks: ParsedBlock[];
  score: number;
}

export interface GenericArticleSelection {
  title: string | null;
  author: string | null;
  excerpt: string | null;
  blocks: ParsedBlock[];
  strategyId: string;
}

const STRUCTURAL_SELECTOR_STRATEGIES = [
  { id: "article", selector: "article", baseScore: 20 },
  {
    id: "content",
    selector:
      ".post-content, .entry-content, .article-content, .article-body, .post-body, .story-body, .prose, [itemprop='articleBody']",
    baseScore: 24,
  },
  { id: "main-article", selector: "main article", baseScore: 18 },
  { id: "main", selector: "main, [role='main']", baseScore: 12 },
];

const TAIL_BOILERPLATE_PATTERNS = [
  /^this entry is part \d+ of \d+ in the series\b/i,
  /^(series|categories|tags)\b/i,
  /^(share|follow|subscribe|newsletter|sign up|get alerts|copy link|print)\b/i,
  /^(read more|related|recommended|you may also like|more from)\b/i,
  /^im[aá]genes?\s*\|/i,
  /^images?\s*\|/i,
  /^image credits?\s*[:|]/i,
  /^(in|en)\s+[A-Z][^|]{0,80}\s*\|/i,
];

const INLINE_BOILERPLATE_PATTERNS = [
  ...TAIL_BOILERPLATE_PATTERNS,
  /^comments?\b/i,
];

const CANDIDATE_NOISE_SELECTORS = [
  "aside",
  "nav",
  "footer",
  "form",
  "script",
  "style",
  "noscript",
  "dialog",
  "[role='navigation']",
  "[role='complementary']",
  "[role='search']",
  ".pps-series-post-details",
  ".social-share-group",
  ".social-share",
  ".share-buttons",
  ".newsletter",
  ".subscription",
  ".related-posts",
  ".recommended-posts",
  ".post-footer",
  ".entry-footer",
  ".article-footer",
  ".comments",
  ".comment-respond",
];

export function selectBestGenericArticleCandidate(input: {
  html: string;
  resolvedUrl: string;
  metadata: ContentMetadata;
}): GenericArticleSelection | null {
  const candidates = rankGenericArticleCandidates(input);

  return candidates[0]
    ? {
      title: candidates[0].title,
      author: candidates[0].author,
      excerpt: candidates[0].excerpt,
      blocks: candidates[0].blocks,
      strategyId: candidates[0].id,
    }
    : null;
}

export function rankGenericArticleCandidates(input: {
  html: string;
  resolvedUrl: string;
  metadata: ContentMetadata;
}): RankedGenericArticleCandidate[] {
  const sourceDocument = parseDocument(input.html);
  return collectGenericArticleCandidates({
    sourceDocument,
    resolvedUrl: input.resolvedUrl,
    metadata: input.metadata,
    html: input.html,
  });
}

function collectGenericArticleCandidates(input: {
  sourceDocument: Document;
  resolvedUrl: string;
  metadata: ContentMetadata;
  html: string;
}): RankedGenericArticleCandidate[] {
  const candidates: RankedGenericArticleCandidate[] = [];

  const readabilityDocument = parseDocument(input.html);
  let readable: ReturnType<Readability["parse"]> | null = null;
  try {
    readable = new Readability(readabilityDocument).parse();
  } catch {
    readable = null;
  }
  const readabilityCandidate = createCandidate({
    id: "readability",
    html: readable?.content ?? "",
    title: trimOrNull(readable?.title),
    author: trimOrNull(readable?.byline),
    resolvedUrl: input.resolvedUrl,
    metadata: input.metadata,
    baseScore: 28,
  });
  if (readabilityCandidate) {
    candidates.push(readabilityCandidate);
  }

  const seenElements = new Set<Element>();
  for (const strategy of STRUCTURAL_SELECTOR_STRATEGIES) {
    const elements = Array.from(
      input.sourceDocument.querySelectorAll(strategy.selector),
    ) as Element[];
    for (const element of elements) {
      if (seenElements.has(element)) {
        continue;
      }
      seenElements.add(element);

      const candidate = createCandidate({
        id: strategy.id,
        html: sanitizeCandidateHtml(element),
        title: extractCandidateTitle(element) ?? input.metadata.title,
        author: extractCandidateAuthor(element),
        resolvedUrl: input.resolvedUrl,
        metadata: input.metadata,
        baseScore: strategy.baseScore,
        scoreContextElement: element,
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  const fallbackCandidate = createCandidate({
    id: "fallback-container",
    html: extractFallbackArticleHtml(input.sourceDocument),
    title: input.metadata.title,
    author: input.metadata.author,
    resolvedUrl: input.resolvedUrl,
    metadata: input.metadata,
    baseScore: 10,
    scoreContextElement: input.sourceDocument.body as Element | null,
  });
  if (fallbackCandidate) {
    candidates.push(fallbackCandidate);
  }

  return dedupeAndSortCandidates(candidates);
}

function createCandidate(input: {
  id: string;
  html: string;
  title: string | null;
  author: string | null;
  resolvedUrl: string;
  metadata: ContentMetadata;
  baseScore: number;
  scoreContextElement?: Element | null;
}): RankedGenericArticleCandidate | null {
  const rawBlocks = buildArticleBlocks(input.html, input.resolvedUrl);
  if (rawBlocks.length === 0) {
    return null;
  }

  const cleanup = cleanGenericArticleBlocks(
    sanitizeParsedBlocks(rawBlocks),
    input.title ?? input.metadata.title,
  );
  if (cleanup.blocks.length === 0) {
    return null;
  }

  const score = scoreCandidate({
    blocks: cleanup.blocks,
    baseScore: input.baseScore,
    cleanup,
    metadata: input.metadata,
    title: input.title ?? input.metadata.title,
    author: input.author ?? input.metadata.author,
    scoreContextElement: input.scoreContextElement ?? null,
  });

  return {
    id: input.id,
    title: input.title ?? input.metadata.title,
    author: input.author ?? input.metadata.author,
    excerpt: summarizeBlocks(cleanup.blocks),
    blocks: cleanup.blocks,
    score,
  };
}

function sanitizeCandidateHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (
    const candidate of Array.from(
      clone.querySelectorAll(CANDIDATE_NOISE_SELECTORS.join(",")),
    ) as Element[]
  ) {
    candidate.remove();
  }

  for (
    const candidate of Array.from(clone.querySelectorAll("*")) as Element[]
  ) {
    const text = collapseWhitespace(candidate.textContent ?? "");
    if (
      text.length > 0 &&
      text.length <= 220 &&
      isBoilerplateText(text) &&
      candidate.querySelectorAll(
          "p, blockquote, pre, code, ul, ol, h1, h2, h3, h4, h5, h6",
        )
          .length === 0
    ) {
      candidate.remove();
    }
  }

  return clone.innerHTML;
}

function extractCandidateTitle(element: Element): string | null {
  const title = collapseWhitespace(
    element.querySelector("h1, h2")?.textContent ?? "",
  );
  return title || null;
}

function extractCandidateAuthor(element: Element): string | null {
  const selectors = [
    "[rel='author']",
    "[itemprop='author']",
    ".author-name",
    ".byline",
    ".author",
  ];

  for (const selector of selectors) {
    const candidate = element.querySelector(selector) as Element | null;
    const normalized = normalizeAuthorText(candidate?.textContent ?? null);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function cleanGenericArticleBlocks(
  blocks: ParsedBlock[],
  title: string | null,
): CandidateCleanupResult {
  const cleaned: ParsedBlock[] = [];
  let removedBoilerplateCount = 0;
  let removedImageCount = 0;
  let removedLeadingTitleCount = 0;

  for (const block of blocks) {
    if (block.type === "image" && !isMeaningfulImageBlock(block)) {
      removedImageCount += 1;
      continue;
    }

    const text = blockText(block);
    if (text && isBoilerplateText(text)) {
      removedBoilerplateCount += 1;
      continue;
    }

    cleaned.push(block);
  }

  while (cleaned[0] && isTitleDuplicateBlock(cleaned[0], title)) {
    cleaned.shift();
    removedLeadingTitleCount += 1;
  }

  while (cleaned[0]?.type === "image") {
    cleaned.shift();
    removedImageCount += 1;
  }

  let removedTrailingCount = 0;
  while (
    cleaned.length > 0 && shouldDropTrailingBlock(cleaned[cleaned.length - 1])
  ) {
    cleaned.pop();
    removedTrailingCount += 1;
  }

  return {
    blocks: cleaned,
    removedBoilerplateCount,
    removedImageCount,
    removedLeadingTitleCount,
    removedTrailingCount,
  };
}

function shouldDropTrailingBlock(block: ParsedBlock): boolean {
  if (block.type === "image") {
    return true;
  }

  const text = blockText(block);
  return text ? isTailBoilerplateText(text) : false;
}

function isMeaningfulImageBlock(
  block: Extract<ParsedBlock, { type: "image" }>,
): boolean {
  const caption = trimOrNull(block.caption);
  const alt = trimOrNull(block.alt);
  const informativeAlt =
    alt && !/\b(profile photo|avatar|hero image|cover image)\b/i.test(alt)
      ? alt
      : null;

  return !!caption || !!(informativeAlt && informativeAlt.length >= 24);
}

function isTitleDuplicateBlock(
  block: ParsedBlock,
  title: string | null,
): boolean {
  const comparableTitle = comparableText(title);
  const comparableBlock = comparableText(blockText(block));
  if (!comparableTitle || !comparableBlock) {
    return false;
  }

  return comparableTitle === comparableBlock;
}

function scoreCandidate(input: {
  blocks: ParsedBlock[];
  baseScore: number;
  cleanup: CandidateCleanupResult;
  metadata: ContentMetadata;
  title: string | null;
  author: string | null;
  scoreContextElement: Element | null;
}): number {
  const metrics = deriveParsedDocumentMetrics({ blocks: input.blocks });
  const paragraphCount =
    input.blocks.filter((block) =>
      block.type === "paragraph" || block.type === "quote"
    ).length;
  const headingCount = input.blocks.filter((block) => block.type === "heading")
    .length;
  const listCount =
    input.blocks.filter((block) => block.type === "list").length;
  const codeCount =
    input.blocks.filter((block) => block.type === "code").length;
  const imageCount =
    input.blocks.filter((block) => block.type === "image").length;
  const duplicatePenalty = input.blocks.length - new Set(
    input.blocks.map((block) => JSON.stringify(block)),
  ).size;
  const linkDensity = input.scoreContextElement
    ? measureLinkDensity(input.scoreContextElement)
    : 0;

  let score = input.baseScore;
  score += Math.min(65, metrics.wordCount / 45);
  score += Math.min(paragraphCount, 24) * 2.6;
  score += Math.min(headingCount, 6) * 1.8;
  score += Math.min(listCount, 4) * 1.4;
  score += Math.min(codeCount, 2) * 1.8;
  score -= imageCount * 4;
  score -= input.cleanup.removedBoilerplateCount * 6;
  score -= input.cleanup.removedImageCount * 1.5;
  score -= input.cleanup.removedTrailingCount * 9;
  score -= input.cleanup.removedLeadingTitleCount * 3;
  score -= duplicatePenalty * 5;
  score -= Math.round(linkDensity * 45);

  if (metrics.wordCount < 120) {
    score -= 40;
  } else if (metrics.wordCount < 260) {
    score -= 16;
  }

  if (paragraphCount === 0) {
    score -= 25;
  }

  if (
    comparableText(input.title) &&
    comparableText(input.metadata.title) === comparableText(input.title)
  ) {
    score += 4;
  }

  if (
    comparableText(input.author) &&
    comparableText(input.metadata.author) === comparableText(input.author)
  ) {
    score += 3;
  }

  return score;
}

function dedupeAndSortCandidates(
  candidates: RankedGenericArticleCandidate[],
): RankedGenericArticleCandidate[] {
  const deduped = new Map<string, RankedGenericArticleCandidate>();

  for (const candidate of candidates) {
    const signature = JSON.stringify(candidate.blocks);
    const existing = deduped.get(signature);
    if (!existing || candidate.score > existing.score) {
      deduped.set(signature, candidate);
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.score - left.score);
}

function measureLinkDensity(element: Element): number {
  const textLength = collapseWhitespace(element.textContent ?? "").length;
  if (textLength === 0) {
    return 0;
  }

  const linkTextLength = Array.from(element.querySelectorAll("a"))
    .map((anchor) =>
      collapseWhitespace((anchor as Element).textContent ?? "").length
    )
    .reduce((total, length) => total + length, 0);

  return linkTextLength / textLength;
}

function isBoilerplateText(text: string): boolean {
  return INLINE_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

function isTailBoilerplateText(text: string): boolean {
  return TAIL_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

function blockText(block: ParsedBlock): string | null {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
    case "code":
      return trimOrNull(block.text);
    case "list":
      return trimOrNull(block.items.join(" "));
    case "image":
      return trimOrNull(block.caption ?? block.alt);
    case "thread_post":
      return trimOrNull(block.text);
  }
}

function normalizeAuthorText(value: string | null | undefined): string | null {
  const normalized = trimOrNull(value)?.replace(/^by\s+/i, "").trim() ?? null;
  if (!normalized || normalized.length > 256) {
    return null;
  }

  return normalized;
}

function trimOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = collapseWhitespace(value);
  return trimmed || null;
}

function comparableText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const collapsed = collapseWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return collapsed || null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
