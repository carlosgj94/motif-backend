import type {
  ContentMetadata,
  Document,
  Element,
  ParsedBlock,
} from "./model.ts";
import {
  buildArticleBlocks,
  deriveParsedDocumentMetrics,
  sanitizeParsedBlocks,
  summarizeBlocks,
  trimUrl,
} from "./normalize.ts";

interface BloombergCleanupResult {
  blocks: ParsedBlock[];
  removedBoilerplateCount: number;
  removedLeadingDuplicateCount: number;
  removedImageCount: number;
}

interface BloombergCandidate {
  id: string;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  blocks: ParsedBlock[];
  score: number;
}

export interface BloombergArticleSelection {
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  siteName: string;
  blocks: ParsedBlock[];
  strategyId: string;
}

const BLOOMBERG_BODY_SELECTORS = [
  "[data-component='article-body']",
  "[data-module='ArticleBody']",
  "[data-testid='story-body']",
  ".story-body",
  ".body-content",
  ".body-copy-v2",
  ".body-copy",
  ".article-body__content",
  "article",
] as const;
const BLOOMBERG_AUTHOR_SELECTORS = [
  "[rel='author']",
  "[itemprop='author']",
  "a[href*='/authors/']",
  "[data-component='byline'] a",
  ".story-byline a",
  ".byline a",
] as const;
const BLOOMBERG_EXCERPT_SELECTORS = [
  "article header h2",
  "article header p",
  ".lede",
  ".story-summary",
  "[data-testid='story-subtitle']",
  "[data-component='story-summary']",
] as const;
const BLOOMBERG_COVER_SELECTORS = [
  "article header figure img",
  "article header picture img",
  "article header img",
  "article figure img",
  "article picture img",
  "article img",
] as const;
const BLOOMBERG_PROMO_PATTERNS = [
  /^gift this article\b/i,
  /^follow all new stories by\b/i,
  /^(following|get alerts|sign up|subscribe)\b/i,
  /^more from bloomberg\b/i,
  /^up next\b/i,
  /^contact us:/i,
  /^confidential tip\?/i,
  /^site feedback:/i,
  /\bnewsletter\b/i,
  /\bprivacy policy\b/i,
  /\bterms of service\b/i,
  /^copy link\b/i,
];
const BLOOMBERG_SECTION_LABEL_PATTERNS = [
  /^weekend essay$/i,
  /^analysis$/i,
  /^opinion$/i,
  /^feature$/i,
];

export function selectBestBloombergArticleContent(input: {
  document: Document;
  resolvedUrl: string;
  metadata: ContentMetadata;
}): BloombergArticleSelection | null {
  const title = extractBloombergTitle(input.document, input.metadata);
  const author = extractBloombergAuthor(input.document, input.metadata);
  const publishedAt = extractBloombergPublishedAt(
    input.document,
    input.metadata,
  );
  const excerpt = extractBloombergExcerpt(
    input.document,
    input.metadata,
    title,
  );
  const coverImageUrl = extractBloombergCoverImage(
    input.document,
    input.resolvedUrl,
    input.metadata,
  );
  const candidates = [
    buildBloombergDomCandidate({
      document: input.document,
      resolvedUrl: input.resolvedUrl,
      title,
      excerpt,
      author,
      publishedAt,
      coverImageUrl,
    }),
    buildBloombergJsonLdCandidate({
      document: input.document,
      title,
      excerpt,
      author,
      publishedAt,
      coverImageUrl,
    }),
  ].filter((candidate): candidate is BloombergCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score);

  const selected = candidates[0];
  if (!selected) {
    return null;
  }

  return {
    title: selected.title ?? title,
    excerpt: selected.excerpt ?? excerpt ?? summarizeBlocks(selected.blocks),
    author: selected.author ?? author,
    publishedAt: selected.publishedAt ?? publishedAt,
    coverImageUrl: selected.coverImageUrl ?? coverImageUrl,
    siteName: "Bloomberg",
    blocks: selected.blocks,
    strategyId: selected.id,
  };
}

function buildBloombergDomCandidate(input: {
  document: Document;
  resolvedUrl: string;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
}): BloombergCandidate | null {
  const root = selectBloombergBodyRoot(input.document);
  if (!root) {
    return null;
  }

  const rawBlocks = buildArticleBlocks(
    sanitizeBloombergRootToHtml(root),
    input.resolvedUrl,
  );
  const cleanup = cleanBloombergBlocks({
    blocks: sanitizeParsedBlocks(rawBlocks),
    title: input.title,
    excerpt: input.excerpt,
    author: input.author,
    publishedAt: input.publishedAt,
  });
  if (cleanup.blocks.length === 0) {
    return null;
  }

  return {
    id: "dom",
    title: input.title,
    excerpt: input.excerpt ?? summarizeBlocks(cleanup.blocks),
    author: input.author,
    publishedAt: input.publishedAt,
    coverImageUrl: input.coverImageUrl,
    blocks: cleanup.blocks,
    score: scoreBloombergCandidate(cleanup, 44),
  };
}

function buildBloombergJsonLdCandidate(input: {
  document: Document;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
}): BloombergCandidate | null {
  const article = selectBloombergJsonLdArticle(input.document);
  const articleBody = trimOrNull(
    stringValue(article?.articleBody) ?? stringValue(article?.description),
  );
  if (!articleBody) {
    return null;
  }

  const blocks = splitBloombergArticleBody(articleBody)
    .map((text) => ({ type: "paragraph" as const, text }));
  const cleanup = cleanBloombergBlocks({
    blocks: sanitizeParsedBlocks(blocks),
    title: input.title,
    excerpt: input.excerpt,
    author: input.author,
    publishedAt: input.publishedAt,
  });
  if (cleanup.blocks.length === 0) {
    return null;
  }

  return {
    id: "jsonld",
    title: trimOrNull(
      stringValue(article?.headline) ?? stringValue(article?.name),
    ) ?? input.title,
    excerpt: input.excerpt ??
      trimOrNull(stringValue(article?.description)) ??
      summarizeBlocks(cleanup.blocks),
    author: trimOrNull(
      stringValue(objectValue(article?.author)?.name) ??
        stringValue(article?.author),
    ) ?? input.author,
    publishedAt: parseDate(
      stringValue(article?.datePublished) ?? stringValue(article?.dateCreated),
    ) ?? input.publishedAt,
    coverImageUrl: trimUrl(
      stringValue(objectValue(article?.image)?.url) ??
        stringValue(article?.image),
    ) ?? input.coverImageUrl,
    blocks: cleanup.blocks,
    score: scoreBloombergCandidate(cleanup, 32),
  };
}

function scoreBloombergCandidate(
  cleanup: BloombergCleanupResult,
  baseScore: number,
): number {
  const metrics = deriveParsedDocumentMetrics({ blocks: cleanup.blocks });
  const paragraphCount =
    cleanup.blocks.filter((block) =>
      block.type === "paragraph" || block.type === "quote"
    ).length;
  const headingCount =
    cleanup.blocks.filter((block) => block.type === "heading")
      .length;
  const imageCount = cleanup.blocks.filter((block) => block.type === "image")
    .length;

  let score = baseScore;
  score += Math.min(72, metrics.wordCount / 38);
  score += Math.min(paragraphCount, 20) * 2.4;
  score += Math.min(headingCount, 4) * 1.2;
  score -= cleanup.removedBoilerplateCount * 4;
  score -= cleanup.removedLeadingDuplicateCount * 2;
  score -= cleanup.removedImageCount * 2;
  score -= imageCount * 3;

  if (metrics.wordCount < 140) {
    score -= 40;
  }

  return score;
}

function selectBloombergBodyRoot(document: Document): Element | null {
  for (const selector of BLOOMBERG_BODY_SELECTORS) {
    const candidates = Array.from(
      document.querySelectorAll(selector),
    ) as Element[];
    const best = candidates
      .filter((candidate) => measureReadableText(candidate) >= 220)
      .sort((left, right) =>
        measureReadableText(right) - measureReadableText(left)
      )[0];
    if (best) {
      return best;
    }
  }

  return document.querySelector("article") as Element | null;
}

function sanitizeBloombergRootToHtml(root: Element): string {
  const clone = root.cloneNode(true) as Element;

  for (
    const nestedArticle of Array.from(
      clone.querySelectorAll("article"),
    ) as Element[]
  ) {
    if (nestedArticle === clone) {
      continue;
    }
    nestedArticle.remove();
  }

  for (
    const candidate of Array.from(
      clone.querySelectorAll(
        "aside, nav, footer, form, script, style, noscript, [role='complementary']",
      ),
    ) as Element[]
  ) {
    candidate.remove();
  }

  for (
    const candidate of Array.from(clone.querySelectorAll("*")) as Element[]
  ) {
    if (shouldRemoveBloombergElement(candidate)) {
      candidate.remove();
    }
  }

  return clone.innerHTML;
}

function shouldRemoveBloombergElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "button") {
    return true;
  }

  const text = collapseWhitespace(element.textContent ?? "");
  if (!text) {
    return false;
  }

  if (
    BLOOMBERG_PROMO_PATTERNS.some((pattern) => pattern.test(text)) &&
    text.length <= 240
  ) {
    return true;
  }

  const heading = collapseWhitespace(
    element.querySelector("h1, h2, h3, h4")?.textContent ?? "",
  );
  if (/^(more from bloomberg|up next)\b/i.test(heading)) {
    return true;
  }

  return false;
}

function cleanBloombergBlocks(input: {
  blocks: ParsedBlock[];
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt?: string | null;
}): BloombergCleanupResult {
  const cleaned: ParsedBlock[] = [];
  let removedBoilerplateCount = 0;
  let removedLeadingDuplicateCount = 0;
  let removedImageCount = 0;
  let hasEnteredArticleBody = false;

  for (const block of input.blocks) {
    if (block.type === "image") {
      removedImageCount += 1;
      continue;
    }

    const text = blockText(block);
    if (!text) {
      continue;
    }

    if (
      shouldDropBloombergFrontMatterBlock({
        text,
        author: input.author,
        publishedAt: input.publishedAt ?? null,
        hasEnteredArticleBody,
      })
    ) {
      removedBoilerplateCount += 1;
      continue;
    }

    if (
      BLOOMBERG_PROMO_PATTERNS.some((pattern) => pattern.test(text)) ||
      BLOOMBERG_SECTION_LABEL_PATTERNS.some((pattern) => pattern.test(text))
    ) {
      removedBoilerplateCount += 1;
      continue;
    }

    cleaned.push(block);
    if (!hasEnteredArticleBody && isSubstantiveBloombergBodyBlock(block)) {
      hasEnteredArticleBody = true;
    }
  }

  while (
    cleaned[0] &&
    isDuplicateBloombergLeadBlock(
      cleaned[0],
      input.title,
      input.excerpt,
      input.author,
    )
  ) {
    cleaned.shift();
    removedLeadingDuplicateCount += 1;
  }

  while (
    cleaned[0] &&
    isBloombergFrontMatterLeadBlock(
      cleaned[0],
      input.author,
      input.publishedAt ?? null,
    )
  ) {
    cleaned.shift();
    removedBoilerplateCount += 1;
  }

  while (
    cleaned.length > 0 &&
    shouldDropTrailingBloombergBlock(cleaned[cleaned.length - 1])
  ) {
    cleaned.pop();
    removedBoilerplateCount += 1;
  }

  return {
    blocks: cleaned,
    removedBoilerplateCount,
    removedLeadingDuplicateCount,
    removedImageCount,
  };
}

function shouldDropTrailingBloombergBlock(block: ParsedBlock): boolean {
  const text = blockText(block);
  if (!text) {
    return false;
  }

  return BLOOMBERG_PROMO_PATTERNS.some((pattern) => pattern.test(text));
}

function isDuplicateBloombergLeadBlock(
  block: ParsedBlock,
  title: string | null,
  excerpt: string | null,
  author: string | null,
): boolean {
  const text = comparableText(blockText(block));
  if (!text) {
    return false;
  }

  return text === comparableText(title) ||
    text === comparableText(excerpt) ||
    text === comparableText(author);
}

function shouldDropBloombergFrontMatterBlock(input: {
  text: string;
  author: string | null;
  publishedAt: string | null;
  hasEnteredArticleBody: boolean;
}): boolean {
  if (input.hasEnteredArticleBody) {
    return false;
  }

  const normalized = comparableText(input.text);
  if (!normalized) {
    return false;
  }

  if (normalized === comparableText(input.author)) {
    return true;
  }

  if (looksLikeBloombergImageCredit(input.text)) {
    return true;
  }

  if (looksLikeBloombergPublishedAt(input.text, input.publishedAt)) {
    return true;
  }

  return false;
}

function isBloombergFrontMatterLeadBlock(
  block: ParsedBlock,
  author: string | null,
  publishedAt: string | null,
): boolean {
  const text = blockText(block);
  if (!text) {
    return false;
  }

  return comparableText(text) === comparableText(author) ||
    looksLikeBloombergImageCredit(text) ||
    looksLikeBloombergPublishedAt(text, publishedAt);
}

function isSubstantiveBloombergBodyBlock(block: ParsedBlock): boolean {
  const text = blockText(block);
  if (!text) {
    return false;
  }

  return (block.type === "paragraph" || block.type === "quote") &&
    text.length >= 90;
}

function looksLikeBloombergImageCredit(text: string): boolean {
  return /^(photo|illustration|image|source):/i.test(text) ||
    /\bfor bloomberg\b/i.test(text);
}

function looksLikeBloombergPublishedAt(
  text: string,
  publishedAt: string | null,
): boolean {
  const normalized = comparableText(text);
  if (!normalized) {
    return false;
  }

  if (
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(
      text,
    ) &&
    /\b(?:am|pm|utc|gmt|cet|cest|est|edt)\b/i.test(text)
  ) {
    return true;
  }

  if (!publishedAt) {
    return false;
  }

  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const comparableDate = comparableText(
    date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  );
  return comparableDate ? normalized.includes(comparableDate) : false;
}

function extractBloombergTitle(
  document: Document,
  metadata: ContentMetadata,
): string | null {
  const heading = trimOrNull(
    document.querySelector("article h1, h1")?.textContent ?? null,
  );
  if (heading) {
    return heading;
  }

  const metadataTitle = trimOrNull(metadata.title);
  if (!metadataTitle) {
    return null;
  }

  return metadataTitle.replace(/\s*-\s*Bloomberg\s*$/i, "").trim();
}

function extractBloombergAuthor(
  document: Document,
  metadata: ContentMetadata,
): string | null {
  for (const selector of BLOOMBERG_AUTHOR_SELECTORS) {
    const candidate = document.querySelector(selector) as Element | null;
    const author = trimOrNull(candidate?.textContent ?? null)?.replace(
      /^By\s+/i,
      "",
    );
    if (author) {
      return author;
    }
  }

  return trimOrNull(metadata.author)?.replace(/^By\s+/i, "") ?? null;
}

function extractBloombergPublishedAt(
  document: Document,
  metadata: ContentMetadata,
): string | null {
  const datetime = document.querySelector("time[datetime]")?.getAttribute(
    "datetime",
  );
  return parseDate(datetime) ?? metadata.publishedAt;
}

function extractBloombergExcerpt(
  document: Document,
  metadata: ContentMetadata,
  title: string | null,
): string | null {
  for (const selector of BLOOMBERG_EXCERPT_SELECTORS) {
    for (
      const candidate of Array.from(
        document.querySelectorAll(selector),
      ) as Element[]
    ) {
      const text = trimOrNull(candidate.textContent ?? null);
      if (!text || text === title || text.length < 40) {
        continue;
      }

      return text;
    }
  }

  return trimOrNull(metadata.description);
}

function extractBloombergCoverImage(
  document: Document,
  resolvedUrl: string,
  metadata: ContentMetadata,
): string | null {
  for (const selector of BLOOMBERG_COVER_SELECTORS) {
    const image = document.querySelector(selector) as Element | null;
    const url = image ? extractImageUrl(image, resolvedUrl) : null;
    if (url) {
      return url;
    }
  }

  return trimUrl(metadata.coverImageUrl);
}

function selectBloombergJsonLdArticle(
  document: Document,
): Record<string, unknown> | null {
  return extractJsonLdObjects(document)
    .filter((entry) => {
      const types = normalizeJsonLdTypes(entry["@type"]);
      return types.includes("newsarticle") || types.includes("article") ||
        types.includes("reportagearticle");
    })
    .sort((left, right) =>
      (trimOrNull(stringValue(right.articleBody))?.length ?? 0) -
      (trimOrNull(stringValue(left.articleBody))?.length ?? 0)
    )[0] ?? null;
}

function splitBloombergArticleBody(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const explicitParagraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => collapseWhitespace(paragraph))
    .filter(Boolean);
  if (explicitParagraphs.length > 1) {
    return explicitParagraphs;
  }

  const sentences = normalized
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => collapseWhitespace(sentence))
    .filter(Boolean);
  if (sentences.length === 0) {
    return [collapseWhitespace(normalized)];
  }

  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > 420 && current) {
      paragraphs.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) {
    paragraphs.push(current);
  }

  return paragraphs;
}

function extractImageUrl(element: Element, baseUrl: string): string | null {
  const currentSource = resolveUrl(
    baseUrl,
    element.getAttribute("currentSourceUrl") ??
      element.getAttribute("data-current-src"),
  );
  if (currentSource) {
    return trimUrl(currentSource);
  }

  const srcset = element.getAttribute("srcset") ??
    element.getAttribute("data-srcset");
  if (srcset) {
    const candidates = srcset.split(",")
      .map((entry: string) => entry.trim().split(/\s+/, 1)[0])
      .filter(Boolean);
    const resolved = resolveUrl(baseUrl, candidates[candidates.length - 1]);
    if (resolved) {
      return trimUrl(resolved);
    }
  }

  return trimUrl(
    resolveUrl(
      baseUrl,
      element.getAttribute("src") ??
        element.getAttribute("data-src") ??
        element.getAttribute("data-original"),
    ),
  );
}

function extractJsonLdObjects(document: Document): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];

  for (
    const script of Array.from(
      document.querySelectorAll("script[type='application/ld+json']"),
    ) as Element[]
  ) {
    const raw = script.textContent?.trim();
    if (!raw) {
      continue;
    }

    try {
      pushJsonLdObject(JSON.parse(raw), objects);
    } catch {
      continue;
    }
  }

  return objects;
}

function pushJsonLdObject(
  value: unknown,
  objects: Record<string, unknown>[],
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      pushJsonLdObject(entry, objects);
    }
    return;
  }

  const record = objectValue(value);
  if (!record) {
    return;
  }

  const graph = arrayValue(record["@graph"]);
  if (graph.length > 0) {
    for (const entry of graph) {
      pushJsonLdObject(entry, objects);
    }
  }

  objects.push(record);
}

function measureReadableText(element: Element): number {
  return collapseWhitespace(element.textContent ?? "").length;
}

function parseDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

function comparableText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const comparable = collapseWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return comparable || null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = collapseWhitespace(value);
  return trimmed || null;
}

function resolveUrl(
  baseUrl: string,
  maybeUrl: string | null | undefined,
): string | null {
  if (!maybeUrl) {
    return null;
  }

  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeJsonLdTypes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).toLowerCase())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return [value.toLowerCase()];
  }

  return [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
