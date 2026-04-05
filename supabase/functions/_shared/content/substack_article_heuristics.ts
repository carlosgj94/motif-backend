import type {
  ContentMetadata,
  Document,
  Element,
  ParsedBlock,
} from "./model.ts";
import {
  buildArticleBlocks,
  deriveParsedDocumentMetrics,
  parseDocument,
  sanitizeParsedBlocks,
  summarizeBlocks,
  trimUrl,
} from "./normalize.ts";

interface SubstackPayload {
  canonicalUrl: string | null;
  post: Record<string, unknown> | null;
  pub: Record<string, unknown> | null;
}

interface SubstackCleanupResult {
  blocks: ParsedBlock[];
  removedFrontMatterCount: number;
  removedBoilerplateCount: number;
  removedImageCount: number;
  preservedCaptionCount: number;
}

interface SubstackCandidate {
  id: string;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  siteName: string | null;
  blocks: ParsedBlock[];
  score: number;
}

export interface SubstackArticleSelection {
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  siteName: string | null;
  blocks: ParsedBlock[];
  strategyId: string;
}

const SUBSTACK_BODY_SELECTORS = [
  ".available-content .body.markup",
  ".body.markup",
  "article.newsletter-post .body.markup",
  "article.post .body.markup",
] as const;

const SUBSTACK_NOISE_SELECTORS = [
  "button",
  "form",
  "aside",
  "nav",
  "footer",
  "script",
  "style",
  "noscript",
  ".button-wrapper",
  ".post-footer",
  ".post-ufi",
  ".post-header",
  ".subscription-widget",
  ".subscription-box",
  ".subscribe-widget",
  ".comments",
  ".comment",
  ".native-video-embed",
  ".audio-player",
  ".captioned-audio-container",
  "[data-testid='noncontributor-cta-button']",
  "[role='complementary']",
].join(",");

const SUBSTACK_TRAILING_PATTERNS = [
  /^subscribe(?: now)?$/i,
  /^share$/i,
  /^sign in$/i,
  /^restack$/i,
  /^like$/i,
  /^comment(?:s)?$/i,
  /^discussion$/i,
  /^reply$/i,
  /^download app$/i,
];

export function selectBestSubstackArticleContent(input: {
  document: Document;
  html: string;
  resolvedUrl: string;
  metadata: ContentMetadata;
}): SubstackArticleSelection | null {
  const payload = extractSubstackPayload(input.html);
  const title = trimOrNull(
    stringValue(payload?.post?.title) ?? input.metadata.title,
  );
  const excerpt = trimOrNull(
    stringValue(payload?.post?.subtitle) ?? input.metadata.description,
  );
  const author = firstNonEmpty(
    extractSubstackPayloadAuthor(payload),
    extractSubstackDomAuthor(input.document),
    input.metadata.author,
  );
  const publishedAt = parseDate(
    firstNonEmpty(
      stringValue(payload?.post?.post_date),
      extractSubstackDomDate(input.document),
      input.metadata.publishedAt,
    ),
  ) ?? input.metadata.publishedAt;
  const siteName = firstNonEmpty(
    stringValue(payload?.pub?.name),
    input.metadata.siteName,
  );
  const coverImageUrl = selectSubstackCoverImage(payload, input.metadata);

  const candidates = [
    buildSubstackPayloadCandidate({
      payload,
      resolvedUrl: input.resolvedUrl,
      title,
      excerpt,
      author,
      publishedAt,
      siteName,
      coverImageUrl,
    }),
    buildSubstackDomCandidate({
      document: input.document,
      resolvedUrl: input.resolvedUrl,
      title,
      excerpt,
      author,
      publishedAt,
      siteName,
      coverImageUrl,
    }),
  ].filter((candidate): candidate is SubstackCandidate => candidate !== null)
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
    siteName: selected.siteName ?? siteName,
    blocks: selected.blocks,
    strategyId: selected.id,
  };
}

function buildSubstackPayloadCandidate(input: {
  payload: SubstackPayload | null;
  resolvedUrl: string;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  siteName: string | null;
  coverImageUrl: string | null;
}): SubstackCandidate | null {
  const bodyHtml = trimOrNull(stringValue(input.payload?.post?.body_html));
  if (!bodyHtml) {
    return null;
  }

  const rawBlocks = buildArticleBlocks(
    sanitizeSubstackHtmlFragment(bodyHtml),
    input.resolvedUrl,
  );
  const cleanup = cleanSubstackBlocks({
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
    id: "payload-body-html",
    title: input.title,
    excerpt: input.excerpt ?? summarizeBlocks(cleanup.blocks),
    author: input.author,
    publishedAt: input.publishedAt,
    coverImageUrl: input.coverImageUrl,
    siteName: input.siteName,
    blocks: cleanup.blocks,
    score: scoreSubstackCandidate(cleanup, 40),
  };
}

function buildSubstackDomCandidate(input: {
  document: Document;
  resolvedUrl: string;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  siteName: string | null;
  coverImageUrl: string | null;
}): SubstackCandidate | null {
  const root = selectSubstackBodyRoot(input.document);
  if (!root) {
    return null;
  }

  const rawBlocks = buildArticleBlocks(
    sanitizeSubstackRootToHtml(root),
    input.resolvedUrl,
  );
  const cleanup = cleanSubstackBlocks({
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
    id: "dom-body-root",
    title: input.title,
    excerpt: input.excerpt ?? summarizeBlocks(cleanup.blocks),
    author: input.author,
    publishedAt: input.publishedAt,
    coverImageUrl: input.coverImageUrl,
    siteName: input.siteName,
    blocks: cleanup.blocks,
    score: scoreSubstackCandidate(cleanup, 32),
  };
}

function scoreSubstackCandidate(
  cleanup: SubstackCleanupResult,
  baseScore: number,
): number {
  const metrics = deriveParsedDocumentMetrics({ blocks: cleanup.blocks });
  const paragraphCount =
    cleanup.blocks.filter((block) =>
      block.type === "paragraph" || block.type === "quote"
    ).length;
  const headingCount =
    cleanup.blocks.filter((block) => block.type === "heading").length;

  let score = baseScore;
  score += Math.min(84, metrics.wordCount / 35);
  score += Math.min(headingCount, 10) * 1.5;
  score += Math.min(paragraphCount, 40) * 1.5;
  score += cleanup.preservedCaptionCount * 2;
  score -= cleanup.removedBoilerplateCount * 1.5;
  score -= cleanup.removedFrontMatterCount * 2;
  score -= cleanup.removedImageCount * 1.25;

  if (metrics.wordCount < 250) {
    score -= 40;
  }

  return score;
}

function cleanSubstackBlocks(input: {
  blocks: ParsedBlock[];
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
}): SubstackCleanupResult {
  const cleaned: ParsedBlock[] = [];
  let removedFrontMatterCount = 0;
  let removedBoilerplateCount = 0;
  let removedImageCount = 0;
  let preservedCaptionCount = 0;

  for (const block of input.blocks) {
    if (block.type === "image") {
      removedImageCount += 1;
      const caption = trimOrNull(block.caption);
      if (caption && shouldPreserveSubstackImageCaption(caption, input)) {
        cleaned.push({ type: "paragraph", text: caption });
        preservedCaptionCount += 1;
      }
      continue;
    }

    const text = blockText(block);
    if (!text) {
      continue;
    }

    if (looksLikeSubstackFrontMatter(text, input)) {
      removedFrontMatterCount += 1;
      continue;
    }

    if (SUBSTACK_TRAILING_PATTERNS.some((pattern) => pattern.test(text))) {
      removedBoilerplateCount += 1;
      continue;
    }

    cleaned.push(block);
  }

  while (
    cleaned[0] && looksLikeSubstackFrontMatter(blockText(cleaned[0]), input)
  ) {
    cleaned.shift();
    removedFrontMatterCount += 1;
  }

  while (
    cleaned.length > 0 &&
    shouldDropTrailingSubstackBlock(cleaned[cleaned.length - 1])
  ) {
    cleaned.pop();
    removedBoilerplateCount += 1;
  }

  return {
    blocks: cleaned,
    removedFrontMatterCount,
    removedBoilerplateCount,
    removedImageCount,
    preservedCaptionCount,
  };
}

function shouldPreserveSubstackImageCaption(
  caption: string,
  input: {
    title: string | null;
    excerpt: string | null;
    author: string | null;
  },
): boolean {
  if (caption.length < 40) {
    return false;
  }

  const comparableCaption = comparableText(caption);
  return comparableCaption !== comparableText(input.title) &&
    comparableCaption !== comparableText(input.excerpt) &&
    comparableCaption !== comparableText(input.author);
}

function shouldDropTrailingSubstackBlock(block: ParsedBlock): boolean {
  const text = blockText(block);
  if (!text) {
    return false;
  }

  return SUBSTACK_TRAILING_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeSubstackFrontMatter(
  text: string | null,
  input: {
    title: string | null;
    excerpt: string | null;
    author: string | null;
    publishedAt: string | null;
  },
): boolean {
  const comparable = comparableText(text);
  if (!comparable) {
    return false;
  }

  return comparable === comparableText(input.title) ||
    comparable === comparableText(input.excerpt) ||
    comparable === comparableText(input.author) ||
    looksLikeSubstackPublishedAt(text, input.publishedAt);
}

function looksLikeSubstackPublishedAt(
  text: string | null,
  publishedAt: string | null,
): boolean {
  if (!text) {
    return false;
  }

  const normalized = comparableText(text);
  if (!normalized) {
    return false;
  }

  if (
    text.length <= 48 &&
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(
      text,
    ) &&
    /\b20\d{2}\b/.test(text)
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

  const comparableLong = comparableText(
    date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  );
  const comparableShort = comparableText(
    date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  );

  return comparableLong ? normalized.includes(comparableLong) : false ||
    (comparableShort ? normalized.includes(comparableShort) : false);
}

function selectSubstackBodyRoot(document: Document): Element | null {
  for (const selector of SUBSTACK_BODY_SELECTORS) {
    const candidate = document.querySelector(selector) as Element | null;
    if (candidate && measureReadableText(candidate) >= 200) {
      return candidate;
    }
  }

  return document.querySelector("article.newsletter-post .body.markup") as
    | Element
    | null;
}

function sanitizeSubstackRootToHtml(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  for (
    const candidate of Array.from(
      clone.querySelectorAll(SUBSTACK_NOISE_SELECTORS),
    ) as Element[]
  ) {
    candidate.remove();
  }
  return clone.innerHTML;
}

function sanitizeSubstackHtmlFragment(html: string): string {
  const document = parseDocument(`<html><body>${html}</body></html>`);
  const body = document.body as Element | null;
  if (!body) {
    return html;
  }

  for (
    const candidate of Array.from(
      body.querySelectorAll(SUBSTACK_NOISE_SELECTORS),
    ) as Element[]
  ) {
    candidate.remove();
  }

  return body.innerHTML;
}

function extractSubstackPayload(html: string): SubstackPayload | null {
  const match = html.match(
    /window\._preloads\s*=\s*JSON\.parse\((\"(?:[^"\\]|\\.)*\")\)/s,
  );
  if (!match) {
    return null;
  }

  try {
    const encoded = JSON.parse(match[1]) as string;
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    return {
      canonicalUrl: stringValue(parsed.canonicalUrl),
      post: objectValue(parsed.post),
      pub: objectValue(parsed.pub),
    };
  } catch {
    return null;
  }
}

function extractSubstackPayloadAuthor(
  payload: SubstackPayload | null,
): string | null {
  const publishedBylines = arrayValue(payload?.post?.publishedBylines);
  const names = publishedBylines
    .map((entry) => trimOrNull(stringValue(objectValue(entry)?.name)))
    .filter((entry): entry is string => Boolean(entry));
  return names.length > 0 ? names.join(", ") : null;
}

function extractSubstackDomAuthor(document: Document): string | null {
  const candidate = trimOrNull(
    document.querySelector(".byline-wrapper a[href*='substack.com/@']")
      ?.textContent ??
      document.querySelector(".byline-wrapper .meta-EgzBVA a")?.textContent ??
      document.querySelector("[rel='author']")?.textContent ??
      null,
  );
  return candidate;
}

function extractSubstackDomDate(document: Document): string | null {
  return trimOrNull(
    document.querySelector(".byline-wrapper time")?.getAttribute("datetime") ??
      document.querySelector(".byline-wrapper .meta-EgzBVA:last-child")
        ?.textContent ??
      null,
  );
}

function selectSubstackCoverImage(
  payload: SubstackPayload | null,
  metadata: ContentMetadata,
): string | null {
  const publicationLogo = trimUrl(stringValue(payload?.pub?.logo_url));
  const authorPhoto = trimUrl(
    stringValue(
      objectValue(arrayValue(payload?.post?.publishedBylines)[0])?.photo_url,
    ),
  );
  const candidates = [
    trimUrl(stringValue(payload?.post?.cover_image)),
    trimUrl(metadata.coverImageUrl),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate === publicationLogo || candidate === authorPhoto) {
      continue;
    }
    if (/\/favicon/i.test(candidate)) {
      continue;
    }
    return candidate;
  }

  return null;
}

function measureReadableText(element: Element): number {
  return collapseWhitespace(element.textContent ?? "").length;
}

function blockText(block: ParsedBlock | undefined): string | null {
  if (!block) {
    return null;
  }

  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "code":
      return trimOrNull(block.text);
    case "list":
      return trimOrNull(block.items.join(" "));
    case "thread_post":
      return trimOrNull(block.text);
    case "image":
      return trimOrNull(block.caption ?? block.alt);
  }
}

function comparableText(value: string | null | undefined): string | null {
  const trimmed = trimOrNull(value);
  return trimmed
    ? collapseWhitespace(trimmed).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
    : null;
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = collapseWhitespace(value ?? "");
  return trimmed.length > 0 ? trimmed : null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const trimmed = trimOrNull(value);
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function parseDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
