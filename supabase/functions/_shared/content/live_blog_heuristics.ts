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

interface LiveBlogSummary {
  title: string | null;
  blocks: ParsedBlock[];
}

interface LiveBlogUpdateContent {
  headingText: string | null;
  titleText: string | null;
  author: string | null;
  blocks: ParsedBlock[];
}

export interface RankedLiveBlogCandidate {
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

export interface LiveBlogSelection {
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  siteName: string | null;
  blocks: ParsedBlock[];
  strategyId: string;
}

const LIVE_BLOG_ROOT_SELECTORS = [
  "#liveblog-body",
  ".liveblog-body",
  "[data-component='liveblog-body']",
  "[data-testid='liveblog-body']",
] as const;

const LIVE_BLOG_UPDATE_SELECTORS = [
  "article.block",
  "article[data-block-id]",
  "[data-testid='liveblog-entry'] article",
  "[data-testid='liveblog-entry']",
  "article",
] as const;

const LIVE_BLOG_UPDATE_NOISE_SELECTORS = [
  "header",
  "footer",
  "aside",
  "button",
  "form",
  "input",
  "label",
  "nav",
  "script",
  "style",
  "noscript",
  "gu-island",
  "iframe",
  "picture",
  "img",
  "video",
  "audio",
  "source",
  "svg",
  ".share",
  ".share-tools",
  ".element-share",
  "[data-component='share']",
].join(",");

const LOW_VALUE_BLOCK_PATTERNS = [
  /^share$/i,
  /^copy link$/i,
  /^(follow|get alerts|sign up|subscribe)\b/i,
  /^related\b/i,
  /^recommended\b/i,
  /^read more\b/i,
] as const;

const MAX_DOM_UPDATES = 6;
const MAX_JSONLD_UPDATES = 6;
const MAX_SUMMARY_BLOCKS = 6;

export function selectBestLiveBlogContent(input: {
  document: Document;
  resolvedUrl: string;
  metadata: ContentMetadata;
}): LiveBlogSelection | null {
  const candidates = rankLiveBlogCandidates(input);
  const selected = candidates[0];
  if (!selected) {
    return null;
  }

  return {
    title: selected.title,
    excerpt: selected.excerpt ?? summarizeBlocks(selected.blocks),
    author: selected.author,
    publishedAt: selected.publishedAt,
    coverImageUrl: selected.coverImageUrl,
    siteName: selected.siteName,
    blocks: selected.blocks,
    strategyId: selected.id,
  };
}

export function rankLiveBlogCandidates(input: {
  document: Document;
  resolvedUrl: string;
  metadata: ContentMetadata;
}): RankedLiveBlogCandidate[] {
  const liveBlog = selectLiveBlogJsonLd(input.document);
  const summary = extractGuardianKeyEventsSummary(
    input.document,
    input.resolvedUrl,
  );
  const title = firstNonEmpty(
    decodeHtmlText(stringValue(liveBlog?.headline)),
    decodeHtmlText(stringValue(liveBlog?.name)),
    input.metadata.title,
  );
  const author = selectLiveBlogAuthor(liveBlog, input.metadata);
  const publishedAt = parseDate(
    firstNonEmpty(
      stringValue(liveBlog?.datePublished),
      stringValue(liveBlog?.dateCreated),
      stringValue(liveBlog?.dateModified),
      input.metadata.publishedAt,
    ),
  ) ?? input.metadata.publishedAt;
  const coverImageUrl = trimUrl(
    selectLiveBlogCoverImage(liveBlog, input.metadata.coverImageUrl),
  );
  const siteName = firstNonEmpty(
    decodeHtmlText(
      stringValue(objectValue(liveBlog?.publisher)?.name) ??
        stringValue(liveBlog?.publisher),
    ),
    input.metadata.siteName,
  );

  return [
    buildLiveBlogDomCandidate({
      document: input.document,
      resolvedUrl: input.resolvedUrl,
      title,
      author,
      publishedAt,
      siteName,
      coverImageUrl,
      summary,
    }),
    buildLiveBlogJsonLdCandidate({
      liveBlog,
      title,
      author,
      publishedAt,
      siteName,
      coverImageUrl,
      summary,
    }),
  ].filter((candidate): candidate is RankedLiveBlogCandidate =>
    candidate !== null
  )
    .sort((left, right) => right.score - left.score);
}

function buildLiveBlogDomCandidate(input: {
  document: Document;
  resolvedUrl: string;
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  siteName: string | null;
  coverImageUrl: string | null;
  summary: LiveBlogSummary | null;
}): RankedLiveBlogCandidate | null {
  const root = selectLiveBlogRoot(input.document);
  if (!root) {
    return null;
  }

  const updates = selectLiveBlogUpdateArticles(root)
    .slice(0, MAX_DOM_UPDATES)
    .map((article) => buildDomLiveBlogUpdate(article, input.resolvedUrl))
    .filter((update): update is LiveBlogUpdateContent => update !== null);
  const blocks = assembleLiveBlogBlocks({
    summary: input.summary,
    updates,
  });
  if (blocks.length === 0) {
    return null;
  }

  return {
    id: "dom-liveblog-root",
    title: input.title,
    excerpt: input.summary?.title ?? summarizeBlocks(blocks),
    author: input.author ?? updates.find((update) => update.author)?.author ??
      null,
    publishedAt: input.publishedAt,
    coverImageUrl: input.coverImageUrl,
    siteName: input.siteName,
    blocks,
    score: scoreLiveBlogCandidate({
      blocks,
      updateCount: updates.length,
      summaryBlockCount: input.summary?.blocks.length ?? 0,
      authoredUpdateCount: updates.filter((update) => !!update.author).length,
      titledUpdateCount: updates.filter((update) => !!update.titleText).length,
      baseScore: 48,
    }),
  };
}

function buildLiveBlogJsonLdCandidate(input: {
  liveBlog: Record<string, unknown> | null;
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  siteName: string | null;
  coverImageUrl: string | null;
  summary: LiveBlogSummary | null;
}): RankedLiveBlogCandidate | null {
  const updates = arrayValue(input.liveBlog?.liveBlogUpdate)
    .slice(0, MAX_JSONLD_UPDATES)
    .map((entry) => buildJsonLdLiveBlogUpdate(objectValue(entry), input.title))
    .filter((update): update is LiveBlogUpdateContent => update !== null);
  const blocks = assembleLiveBlogBlocks({
    summary: input.summary,
    updates,
  });
  if (blocks.length === 0) {
    return null;
  }

  return {
    id: "jsonld-liveblog-updates",
    title: input.title,
    excerpt: input.summary?.title ?? summarizeBlocks(blocks),
    author: input.author,
    publishedAt: input.publishedAt,
    coverImageUrl: input.coverImageUrl,
    siteName: input.siteName,
    blocks,
    score: scoreLiveBlogCandidate({
      blocks,
      updateCount: updates.length,
      summaryBlockCount: input.summary?.blocks.length ?? 0,
      authoredUpdateCount: updates.filter((update) => !!update.author).length,
      titledUpdateCount: updates.filter((update) => !!update.titleText).length,
      baseScore: 28,
    }),
  };
}

function assembleLiveBlogBlocks(input: {
  summary: LiveBlogSummary | null;
  updates: LiveBlogUpdateContent[];
}): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];

  if (input.summary && input.summary.blocks.length > 0) {
    blocks.push({
      type: "heading",
      level: 2,
      text: "Key events",
    });
    if (input.summary.title) {
      blocks.push({
        type: "heading",
        level: 3,
        text: input.summary.title,
      });
    }
    blocks.push(...input.summary.blocks.slice(0, MAX_SUMMARY_BLOCKS));
  }

  if (input.updates.length > 0) {
    blocks.push({
      type: "heading",
      level: 2,
      text: "Latest updates",
    });
  }

  for (const update of input.updates) {
    if (update.headingText) {
      blocks.push({
        type: "heading",
        level: 3,
        text: update.headingText,
      });
    }
    if (update.titleText) {
      blocks.push({
        type: "heading",
        level: 4,
        text: update.titleText,
      });
    }
    blocks.push(...update.blocks);
  }

  return sanitizeLiveBlogBlocks(sanitizeParsedBlocks(blocks));
}

function buildDomLiveBlogUpdate(
  article: Element,
  resolvedUrl: string,
): LiveBlogUpdateContent | null {
  const header = article.querySelector("header") as Element | null;
  const titleText = normalizeLiveBlogHeadingText(
    article.querySelector("h2, h3")?.textContent ?? null,
  );
  const headingText = buildUpdateHeadingText(header, titleText);
  const author = extractHeaderAuthor(header);
  const clone = article.cloneNode(true) as Element;

  for (
    const figure of Array.from(clone.querySelectorAll("figure")) as Element[]
  ) {
    figure.remove();
  }

  for (
    const element of Array.from(
      clone.querySelectorAll(LIVE_BLOG_UPDATE_NOISE_SELECTORS),
    ) as Element[]
  ) {
    element.remove();
  }

  const blocks = sanitizeLiveBlogBlocks(
    sanitizeParsedBlocks(buildArticleBlocks(clone.innerHTML, resolvedUrl)),
  );
  if (blocks.length === 0) {
    return null;
  }

  return {
    headingText,
    titleText,
    author,
    blocks,
  };
}

function buildJsonLdLiveBlogUpdate(
  update: Record<string, unknown> | null,
  pageTitle: string | null,
): LiveBlogUpdateContent | null {
  if (!update) {
    return null;
  }

  const articleBody = trimOrNull(
    stringValue(update.articleBody) ?? stringValue(update.description),
  );
  if (!articleBody) {
    return null;
  }

  const blocks = sanitizeLiveBlogBlocks(
    sanitizeParsedBlocks(
      buildArticleBlocks(normalizeJsonLdUpdateHtml(articleBody), ""),
    ),
  );
  if (blocks.length === 0) {
    return null;
  }

  const author = extractLiveBlogAuthors(update.author);
  const titleText = normalizeJsonLdUpdateTitle(
    stringValue(update.headline) ?? stringValue(update.name),
    pageTitle,
  );

  return {
    headingText: buildJsonLdUpdateHeading(update, author, titleText),
    titleText,
    author,
    blocks,
  };
}

function scoreLiveBlogCandidate(input: {
  blocks: ParsedBlock[];
  updateCount: number;
  summaryBlockCount: number;
  authoredUpdateCount: number;
  titledUpdateCount: number;
  baseScore: number;
}): number {
  const metrics = deriveParsedDocumentMetrics({ blocks: input.blocks });
  let score = input.baseScore;
  score += Math.min(120, metrics.wordCount / 14);
  score += Math.min(input.updateCount, MAX_DOM_UPDATES) * 8;
  score += Math.min(input.summaryBlockCount, MAX_SUMMARY_BLOCKS) * 4;
  score += input.summaryBlockCount > 0 ? 12 : 0;
  score += input.authoredUpdateCount * 3;
  score += input.titledUpdateCount * 2;
  score -= metrics.imageCount * 8;

  if (input.updateCount < 2 && metrics.wordCount < 180) {
    score -= 18;
  }
  if (metrics.wordCount < 120) {
    score -= 22;
  }

  return score;
}

function selectLiveBlogRoot(document: Document): Element | null {
  for (const selector of LIVE_BLOG_ROOT_SELECTORS) {
    const match = document.querySelector(selector) as Element | null;
    if (match) {
      return match;
    }
  }

  return null;
}

function selectLiveBlogUpdateArticles(root: Element): Element[] {
  const seen = new Set<Element>();
  const updates: Element[] = [];

  for (const selector of LIVE_BLOG_UPDATE_SELECTORS) {
    for (
      const element of Array.from(root.querySelectorAll(selector)) as Element[]
    ) {
      if (seen.has(element)) {
        continue;
      }

      const text = collapseWhitespace(element.textContent ?? "");
      if (
        text.length < 80 ||
        !element.querySelector("p, blockquote, ul, ol, pre")
      ) {
        continue;
      }

      seen.add(element);
      updates.push(element);
    }

    if (updates.length > 0) {
      return updates;
    }
  }

  return updates;
}

function extractGuardianKeyEventsSummary(
  document: Document,
  resolvedUrl: string,
): LiveBlogSummary | null {
  const island = document.querySelector(
    "#liveblog-body gu-island[name='KeyEventsCarousel'], gu-island[name='KeyEventsCarousel']",
  ) as Element | null;
  const rawProps = island?.getAttribute("props") ?? null;
  if (!rawProps) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawProps) as Record<string, unknown>;
    const summaryEvent = arrayValue(parsed.keyEvents)
      .map((entry) => objectValue(entry))
      .find((entry) => objectValue(entry?.attributes)?.summary === true) ??
      arrayValue(parsed.keyEvents)
        .map((entry) => objectValue(entry))
        .find((entry) => objectValue(entry?.attributes)?.keyEvent === true) ??
      null;
    if (!summaryEvent) {
      return null;
    }

    const html = arrayValue(summaryEvent.elements)
      .map((entry) =>
        decodeHtmlFragmentEntities(
          stringValue(objectValue(entry)?.html),
        )
      )
      .filter((entry): entry is string => !!entry)
      .join("");
    const blocks = sanitizeLiveBlogBlocks(
      sanitizeParsedBlocks(buildArticleBlocks(html, resolvedUrl)),
    );
    if (blocks.length === 0) {
      return null;
    }

    return {
      title: decodeHtmlText(stringValue(summaryEvent.title)),
      blocks,
    };
  } catch (error) {
    console.warn("failed to parse live blog key events payload", { error });
    return null;
  }
}

function buildUpdateHeadingText(
  header: Element | null,
  titleText: string | null,
): string | null {
  const timeLabel = extractHeaderTimeLabel(header);
  const author = extractHeaderAuthor(header);
  const parts = [timeLabel, author].filter(
    (value): value is string => !!value,
  );
  if (parts.length > 0) {
    return parts.join(" | ");
  }

  return titleText;
}

function extractHeaderTimeLabel(header: Element | null): string | null {
  if (!header) {
    return null;
  }

  const textCandidates = collectHeaderTextCandidates(header);
  const timeCandidate = textCandidates
    .filter((value) => looksLikeShortTimeLabel(value))
    .sort((left, right) => left.length - right.length)[0] ??
    textCandidates
      .filter((value) => looksLikeTimeLabel(value))
      .sort((left, right) => left.length - right.length)[0] ??
    null;
  if (timeCandidate) {
    return timeCandidate;
  }

  const isoDate = header.querySelector("time")?.getAttribute("datetime") ??
    null;
  if (isoDate) {
    return formatUtcTimeLabel(isoDate);
  }

  return null;
}

function extractHeaderAuthor(header: Element | null): string | null {
  if (!header) {
    return null;
  }

  const directSelectors = [
    "[rel='author']",
    "[itemprop='author']",
    "[data-testid='byline']",
    ".byline",
    "a[href*='/profile/']",
    "img[alt]",
  ] as const;
  for (const selector of directSelectors) {
    const candidate = normalizePersonName(
      selector === "img[alt]"
        ? header.querySelector(selector)?.getAttribute("alt") ?? null
        : header.querySelector(selector)?.textContent ?? null,
    );
    if (candidate) {
      return candidate;
    }
  }

  const textCandidates = collectHeaderTextCandidates(header);
  return textCandidates
    .map((value) => normalizePersonName(value))
    .find((value): value is string => !!value) ?? null;
}

function collectHeaderTextCandidates(header: Element): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  const nodes = Array.from(
    header.querySelectorAll("time, span, a, div, p"),
  ) as Element[];
  for (const node of nodes) {
    const normalized = collapseWhitespace(node.textContent ?? "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    texts.push(normalized);
  }

  const ownText = collapseWhitespace(header.textContent ?? "");
  if (ownText && !seen.has(ownText)) {
    texts.push(ownText);
  }

  return texts;
}

function normalizePersonName(value: string | null | undefined): string | null {
  const normalized = trimOrNull(value);
  if (!normalized) {
    return null;
  }
  if (
    looksLikeTimeLabel(normalized) ||
    looksLikeDateLine(normalized) ||
    /^[0-9.\s:]+(?:UTC|CET|CEST|BST|GMT)?$/i.test(normalized) ||
    /^(share|copy link)$/i.test(normalized)
  ) {
    return null;
  }
  if (!/[A-Za-z]/.test(normalized)) {
    return null;
  }
  if (!/^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function looksLikeShortTimeLabel(value: string): boolean {
  return /^\d{1,2}[.:]\d{2}(?:\s?(?:UTC|GMT|BST|CET|CEST|EST|EDT|PST|PDT))?$/i
    .test(value);
}

function looksLikeTimeLabel(value: string): boolean {
  return looksLikeShortTimeLabel(value) ||
    /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}[.:]\d{2}(?:\s?[A-Z]{2,5})?$/i
      .test(value);
}

function looksLikeDateLine(value: string): boolean {
  return /^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(value) ||
    /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/i.test(value);
}

function normalizeLiveBlogHeadingText(
  value: string | null | undefined,
): string | null {
  const normalized = trimOrNull(value);
  if (!normalized) {
    return null;
  }

  return LOW_VALUE_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))
    ? null
    : normalized;
}

function sanitizeLiveBlogBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
  return blocks.filter((block) => {
    if (block.type === "image") {
      return false;
    }

    const text = textFromBlock(block);
    if (!text) {
      return true;
    }

    return !LOW_VALUE_BLOCK_PATTERNS.some((pattern) => pattern.test(text));
  });
}

function textFromBlock(block: ParsedBlock): string | null {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
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

function selectLiveBlogJsonLd(
  document: Document,
): Record<string, unknown> | null {
  const objects = extractJsonLdObjects(document)
    .filter((entry) =>
      normalizeJsonLdTypes(entry["@type"]).includes("liveblogposting")
    );

  return objects
    .sort((left, right) =>
      scoreLiveBlogJsonLd(right) - scoreLiveBlogJsonLd(left)
    )[0] ??
    null;
}

function scoreLiveBlogJsonLd(entry: Record<string, unknown>): number {
  let score = 0;
  if (stringValue(entry.headline) || stringValue(entry.name)) {
    score += 20;
  }
  if (arrayValue(entry.liveBlogUpdate).length > 0) {
    score += 24;
  }
  if (extractLiveBlogAuthors(entry.author)) {
    score += 12;
  }
  if (stringValue(entry.datePublished) || stringValue(entry.dateModified)) {
    score += 8;
  }

  return score;
}

function selectLiveBlogAuthor(
  liveBlog: Record<string, unknown> | null,
  metadata: ContentMetadata,
): string | null {
  return firstNonEmpty(
    extractLiveBlogAuthors(liveBlog?.author),
    normalizeAuthorCandidate(metadata.author),
  );
}

function extractLiveBlogAuthors(value: unknown): string | null {
  const names = arrayValue(value)
    .map((entry) => {
      if (typeof entry === "string") {
        return normalizeAuthorCandidate(entry);
      }

      const record = objectValue(entry);
      return normalizeAuthorCandidate(
        stringValue(record?.name) ??
          stringValue(record?.headline) ??
          stringValue(record?.url),
      );
    })
    .filter((entry): entry is string => !!entry);
  if (names.length === 0) {
    return null;
  }
  if (names.length === 1) {
    return names[0];
  }

  return `${names[0]} and others`;
}

function normalizeAuthorCandidate(
  value: string | null | undefined,
): string | null {
  const normalized = trimOrNull(value);
  if (!normalized) {
    return null;
  }
  const parts = normalized.split(",").map((part) => part.trim()).filter(
    Boolean,
  );
  if (
    parts.length > 0 &&
    parts.every((part) => /^https?:\/\//i.test(part))
  ) {
    return null;
  }
  if (/^https?:\/\//i.test(normalized)) {
    return null;
  }

  return normalized;
}

function selectLiveBlogCoverImage(
  liveBlog: Record<string, unknown> | null,
  fallback: string | null,
): string | null {
  const fromJsonLd = arrayValue(liveBlog?.image)
    .map((entry) => {
      if (typeof entry === "string") {
        return trimUrl(entry);
      }

      const record = objectValue(entry);
      return trimUrl(
        stringValue(record?.url) ?? stringValue(record?.contentUrl),
      );
    })
    .find((entry): entry is string => !!entry);

  return fromJsonLd ?? fallback;
}

function buildJsonLdUpdateHeading(
  update: Record<string, unknown>,
  author: string | null,
  titleText: string | null,
): string | null {
  const timeLabel = formatUtcTimeLabel(
    stringValue(update.datePublished) ?? stringValue(update.dateCreated) ??
      stringValue(update.dateModified),
  );
  const parts = [timeLabel, author].filter((value): value is string => !!value);
  if (parts.length > 0) {
    return parts.join(" | ");
  }

  return titleText;
}

function normalizeJsonLdUpdateTitle(
  value: string | null,
  pageTitle: string | null,
): string | null {
  const title = decodeHtmlText(value);
  if (!title) {
    return null;
  }
  if (
    pageTitle &&
    normalizeComparableText(title) === normalizeComparableText(pageTitle)
  ) {
    return null;
  }

  return title;
}

function normalizeJsonLdUpdateHtml(value: string): string {
  if (/<[a-z][\s\S]*>/i.test(value)) {
    return decodeHtmlFragmentEntities(value) ?? "";
  }

  const paragraphs = value
    .split(/\n{2,}/)
    .map((paragraph) => trimOrNull(paragraph))
    .filter((paragraph): paragraph is string => !!paragraph)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`);
  return paragraphs.length > 0
    ? paragraphs.join("")
    : `<p>${escapeHtml(value)}</p>`;
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
      const parsed = JSON.parse(raw);
      flattenJsonLd(parsed, objects);
    } catch (error) {
      console.warn("failed to parse json-ld", { error });
    }
  }

  return objects;
}

function flattenJsonLd(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => flattenJsonLd(entry, out));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record["@graph"])) {
    flattenJsonLd(record["@graph"], out);
  }

  out.push(record);
}

function normalizeJsonLdTypes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).toLowerCase()).filter(Boolean);
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
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatUtcTimeLabel(value: string | null): string | null {
  const parsed = parseDate(value);
  if (!parsed) {
    return null;
  }

  const date = new Date(parsed);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes} UTC`;
}

function decodeHtmlText(value: string | null | undefined): string | null {
  const normalized = trimOrNull(value);
  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function decodeHtmlFragmentEntities(
  value: string | null | undefined,
): string | null {
  const normalized = trimOrNull(value);
  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeComparableText(
  value: string | null | undefined,
): string | null {
  const normalized = trimOrNull(value);
  if (!normalized) {
    return null;
  }

  return normalized.toLowerCase()
    .replace(/[“”"'.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const normalized = trimOrNull(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function trimOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
