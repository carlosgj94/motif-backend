import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.12";

import {
  MAX_AUTHOR_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_LANGUAGE_CODE_CHARS,
  MAX_SITE_NAME_CHARS,
  MAX_THREAD_DISPLAY_NAME_CHARS,
  MAX_THREAD_HANDLE_CHARS,
  MAX_THREAD_MEDIA_ITEMS,
  MAX_URL_CHARS,
  maxCodeChars,
  maxListItemChars,
  maxListItems,
  maxParsedBlocks,
  maxParsedDocumentBytes,
  maxTextChars,
  noisyArticleTags,
  nonDiscoverableSourceHosts,
} from "./config.ts";
import { isDisallowedHostname } from "./fetch.ts";
import type {
  ArchiveSnapshot,
  ContentMetadata,
  Document,
  Element,
  FaviconResult,
  FetchDocumentResult,
  ParsedBlock,
  PartialContentUpdate,
  ThreadMediaItem,
  ThreadPostBlock,
} from "./model.ts";
import { ProcessingFailure } from "./model.ts";

export function parseDocument(html: string): Document {
  return (parseHTML(html) as unknown as { document: Document }).document;
}

export function collectFaviconCandidates(
  document: Document,
  resolvedUrl: string,
): string[] {
  const candidates = new Map<string, number>();
  const links = Array.from(
    document.querySelectorAll("link[rel][href]"),
  ) as Element[];

  for (const link of links) {
    const href = link.getAttribute("href");
    const absoluteUrl = resolveUrl(resolvedUrl, href);
    if (!absoluteUrl) {
      continue;
    }

    const rel = normalizeLinkRel(link.getAttribute("rel"));
    if (!isFaviconRel(rel)) {
      continue;
    }

    const priority = faviconCandidatePriority({
      rel,
      sizes: link.getAttribute("sizes"),
      type: link.getAttribute("type"),
      url: absoluteUrl,
    });
    const existing = candidates.get(absoluteUrl);
    if (existing === undefined || priority < existing) {
      candidates.set(absoluteUrl, priority);
    }
  }

  const fallback = resolveUrl(resolvedUrl, "/favicon.ico") ??
    `${resolvedUrl}/favicon.ico`;
  if (!candidates.has(fallback)) {
    candidates.set(fallback, 100);
  }

  return Array.from(candidates.entries())
    .sort(([leftUrl, leftPriority], [rightUrl, rightPriority]) =>
      leftPriority - rightPriority || leftUrl.localeCompare(rightUrl)
    )
    .map(([url]) => url);
}

export function buildArticleBlocks(
  html: string,
  baseUrl: string,
): ParsedBlock[] {
  if (!html.trim()) {
    return [];
  }

  const document = parseDocument(`<html><body>${html}</body></html>`);
  const root = document.body;
  const blocks: ParsedBlock[] = [];
  for (const element of Array.from(root.children) as Element[]) {
    appendBlocksFromElement(element, blocks, baseUrl);
  }

  if (blocks.length > 0) {
    return blocks;
  }

  const fallbackText = collapseWhitespace(root.textContent ?? "");
  return fallbackText ? [{ type: "paragraph", text: fallbackText }] : [];
}

export function extractFallbackArticleHtml(document: Document): string {
  const selectorCandidates = [
    "article",
    "main",
    "[role='main']",
    ".prose",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".content",
  ];

  let bestHtml = "";
  let bestTextLength = 0;
  for (const selector of selectorCandidates) {
    const matches = Array.from(
      document.querySelectorAll(selector),
    ) as Element[];
    for (const match of matches) {
      const textLength = measureReadableText(match);
      if (textLength > bestTextLength) {
        bestTextLength = textLength;
        bestHtml = match.innerHTML;
      }
    }
  }

  if (bestHtml) {
    return bestHtml;
  }

  return document.body?.innerHTML ?? "";
}

export function extractThreadPosts(
  document: Document,
  resolvedUrl: string,
  metadata: ContentMetadata,
): ThreadPostBlock[] {
  const fromJsonLd = extractJsonLdObjects(document)
    .flatMap((entry) => socialPostFromJsonLd(entry, resolvedUrl))
    .filter((entry): entry is ThreadPostBlock => entry !== null);

  const deduped = dedupeThreadPosts(fromJsonLd);
  if (deduped.length > 0) {
    return deduped;
  }

  const fromMarkup = dedupeThreadPosts(
    extractThreadPostsFromMarkup(document, resolvedUrl),
  );
  if (fromMarkup.length > 0) {
    return fromMarkup;
  }

  const fallbackText = collapseWhitespace(
    metadata.description ?? metadata.title ?? "",
  );
  if (!fallbackText || isLowValueXFallbackText(fallbackText)) {
    return [];
  }

  const resolved = new URL(resolvedUrl);
  const handleMatch = resolved.pathname.match(/^\/([^/]+)\/status\//i);
  const statusMatch = resolved.pathname.match(/status\/(\d+)/i);
  const displayName = metadata.title?.split(" on X")[0]?.trim() ?? null;
  return [{
    type: "thread_post",
    post_id: statusMatch?.[1] ?? null,
    author_handle: handleMatch?.[1] ?? null,
    display_name: displayName && !isLowValueXFallbackText(displayName)
      ? displayName
      : null,
    published_at: metadata.publishedAt,
    text: fallbackText,
    media: metadata.coverImageUrl
      ? [{ kind: "image", url: metadata.coverImageUrl, alt: null }]
      : [],
  }];
}

function isLowValueXFallbackText(value: string): boolean {
  return /^\s*x\s*$/i.test(value) ||
    /^https?:\/\/(?:t\.co|x\.com|twitter\.com)\//i.test(value);
}

export function xPostFromOEmbedPayload(
  payload: unknown,
  resolvedUrl: string,
): ThreadPostBlock | null {
  const record = objectValue(payload);
  if (!record) {
    return null;
  }

  const html = stringValue(record?.html);
  if (!html) {
    return null;
  }

  const document = parseDocument(`<html><body>${html}</body></html>`);
  const blockquote = document.querySelector("blockquote");
  if (!blockquote) {
    return null;
  }

  const text = extractVisibleText(
    (blockquote.querySelector("p") ?? blockquote) as Element,
  );
  if (!text) {
    return null;
  }

  const anchorUrls = Array.from(blockquote.querySelectorAll("a") as Element[])
    .map((element) => resolveUrl(resolvedUrl, element.getAttribute("href")))
    .filter(Boolean) as string[];
  const statusUrl =
    anchorUrls.find((candidate) => /\/status\/\d+/i.test(candidate)) ??
      resolvedUrl;
  const anchors = Array.from(blockquote.querySelectorAll("a")) as Element[];
  const publishedAt = parseHumanDateText(
    collapseWhitespace(anchors[anchors.length - 1]?.textContent ?? "") || null,
  ) ?? parseIsoDate(
    collapseWhitespace(anchors[anchors.length - 1]?.textContent ?? "") || null,
  );
  const authorName = stringValue(record.author_name);
  const authorHandle =
    extractHandleFromProfileUrl(stringValue(record.author_url)) ??
      extractHandleFromUrl(statusUrl);

  return {
    type: "thread_post",
    post_id: extractPostId(statusUrl),
    author_handle: authorHandle,
    display_name: authorName,
    published_at: publishedAt,
    text,
    media: [],
  };
}

export function collectMetadata(document: Document): ContentMetadata {
  const title =
    decodeHtmlEntities(document.querySelector("title")?.textContent ?? "") ||
    null;
  const timeDateTime =
    document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
  const meta = new Map<string, string>();
  const jsonLdObjects = extractJsonLdObjects(document);
  const primaryArticle = selectPrimaryArticleJsonLd(jsonLdObjects);
  const sitePersonName = selectPrimarySitePersonName(jsonLdObjects);

  for (
    const tag of Array.from(document.querySelectorAll("meta")) as Element[]
  ) {
    const name = (
      tag.getAttribute("property") ??
        tag.getAttribute("name") ??
        tag.getAttribute("itemprop")
    )?.trim().toLowerCase();
    const content = decodeHtmlEntities(tag.getAttribute("content"));
    if (name && content && !meta.has(name)) {
      meta.set(name, content);
    }
  }

  const htmlLang = document.documentElement?.getAttribute("lang") ?? null;
  const siteName = firstNonEmpty(
    meta.get("og:site_name"),
    meta.get("application-name"),
    extractJsonLdPublisherName(primaryArticle),
    selectPrimaryWebsiteName(jsonLdObjects),
  );
  const documentAuthor = extractDocumentAuthor(document);
  const documentSiteOwner = filterSiteOwnerCandidate(
    extractDocumentSiteOwner(document),
    siteName,
  );

  return {
    title: firstNonEmpty(
      meta.get("og:title"),
      meta.get("twitter:title"),
      extractJsonLdArticleTitle(primaryArticle),
      title,
    ),
    description: firstNonEmpty(
      meta.get("description"),
      meta.get("og:description"),
      meta.get("twitter:description"),
      extractJsonLdArticleDescription(primaryArticle),
    ),
    author: firstNonEmpty(
      normalizeAuthorText(meta.get("author")),
      normalizeAuthorText(meta.get("article:author")),
      normalizeAuthorText(meta.get("parsely-author")),
      normalizeAuthorHandle(meta.get("twitter:creator")),
      documentAuthor,
      extractJsonLdArticleAuthor(primaryArticle),
      filterSiteOwnerCandidate(sitePersonName, siteName),
      documentSiteOwner,
    ),
    publishedAt: parseIsoDate(
      firstNonEmpty(
        meta.get("article:published_time"),
        meta.get("og:article:published_time"),
        meta.get("parsely-pub-date"),
        meta.get("pubdate"),
        meta.get("date"),
        meta.get("dc.date"),
        decodeHtmlEntities(stringValue(primaryArticle?.datePublished)),
        decodeHtmlEntities(stringValue(primaryArticle?.dateCreated)),
        timeDateTime,
      ),
    ),
    languageCode: normalizeLanguageCode(
      firstNonEmpty(
        meta.get("og:locale"),
        htmlLang,
        decodeHtmlEntities(stringValue(primaryArticle?.inLanguage)),
      ),
    ),
    coverImageUrl: firstNonEmpty(
      meta.get("og:image"),
      meta.get("twitter:image"),
      extractJsonLdImageUrl(primaryArticle?.image),
      extractJsonLdImageUrl(primaryArticle?.thumbnailUrl),
    ),
    siteName,
  };
}

export function extractArchiveSnapshot(
  document: Document,
  resolvedUrl: string,
  sourceUrlHint: string | null = null,
): ArchiveSnapshot {
  const sourceUrl = firstNonEmpty(
    normalizeArchiveSourceUrl(resolvedUrl, sourceUrlHint),
    normalizeArchiveSourceUrl(
      resolvedUrl,
      extractArchiveSourceUrlFromDocument(document),
    ),
  );
  const sourceHost = sourceUrl ? safeHost(sourceUrl) : null;
  const article = selectArchivePrimaryArticle(document);
  const title = firstNonEmpty(
    collapseWhitespace(article?.querySelector("h1")?.textContent ?? "") || null,
    collapseWhitespace(document.querySelector("title")?.textContent ?? "") ||
      null,
  );

  return {
    sourceUrl,
    sourceHost,
    siteName: firstNonEmpty(
      extractSiteNameFromTitle(
        collapseWhitespace(
          document.querySelector("title")?.textContent ?? "",
        ) ||
          null,
      ),
      sourceHost?.replace(/^www\./, "") ?? null,
    ),
    title,
    description: article
      ? extractArchiveHeaderDescription(article, title)
      : null,
    author: firstNonEmpty(
      collapseWhitespace(
        article?.querySelector("[rel='author']")?.textContent ?? "",
      ) || null,
    ),
    publishedAt: parseIsoDate(
      article?.querySelector("time[datetime]")?.getAttribute("datetime") ??
        null,
    ),
    coverImageUrl: article
      ? extractArchiveCoverImageUrl(article, resolvedUrl)
      : null,
    articleHtml: article ? extractArchiveArticleHtml(article) : null,
  };
}

export function extractOriginalUrlFromLinkHeader(
  value: string | null,
): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/<([^>]+)>\s*;\s*rel="original"/i);
  return match?.[1] ?? null;
}

export function discoverArticleSourceUrl(
  document: Document,
  articleUrl: string,
): string | null {
  const article = normalizeDiscoveredSourceUrl(articleUrl, articleUrl, null);
  if (!article) {
    return null;
  }
  if (nonDiscoverableSourceHosts.has(article.host)) {
    return null;
  }

  const scored = new Map<string, { score: number; pathDepth: number }>();
  const pushCandidate = (rawUrl: string | null | undefined, score: number) => {
    const normalized = normalizeDiscoveredSourceUrl(
      articleUrl,
      rawUrl,
      article,
    );
    if (!normalized) {
      return;
    }

    const existing = scored.get(normalized.url);
    if (
      !existing ||
      score > existing.score ||
      (score === existing.score && normalized.pathDepth < existing.pathDepth)
    ) {
      scored.set(normalized.url, {
        score,
        pathDepth: normalized.pathDepth,
      });
    }
  };

  for (
    const element of Array.from(
      document.querySelectorAll("link[rel][href], a[rel][href]"),
    ) as Element[]
  ) {
    const rel = normalizeLinkRel(element.getAttribute("rel"));
    if (!rel.includes("home")) {
      continue;
    }

    pushCandidate(element.getAttribute("href"), 100);
  }

  for (const object of extractJsonLdObjects(document)) {
    const types = normalizeJsonLdTypes(object["@type"]);
    if (
      types.includes("website") ||
      types.includes("blog") ||
      types.includes("collectionpage")
    ) {
      pushCandidate(stringValue(object.url), 95);
    }

    pushCandidate(stringValue(objectValue(object.isPartOf)?.url), 90);
    pushCandidate(stringValue(objectValue(object.publisher)?.url), 70);
  }

  pushCandidate(buildRootSourceCandidate(article.url), 10);

  return Array.from(scored.entries())
    .sort((left, right) => {
      if (right[1].score !== left[1].score) {
        return right[1].score - left[1].score;
      }
      if (left[1].pathDepth !== right[1].pathDepth) {
        return left[1].pathDepth - right[1].pathDepth;
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([url]) => url)[0] ?? null;
}

export function buildBaseUpdate(input: {
  fetched: FetchDocumentResult;
  metadata: ContentMetadata;
  favicon: FaviconResult | null;
  sourceKind: "article" | "thread" | "post";
  siteName: string | null;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  languageCode: string | null;
  coverImageUrl: string | null;
}): PartialContentUpdate {
  return {
    resolved_url: input.fetched.resolvedUrl,
    host: input.fetched.host,
    site_name: trimText(input.siteName, MAX_SITE_NAME_CHARS),
    source_kind: input.sourceKind,
    title: input.title,
    excerpt: input.excerpt,
    author: input.author,
    published_at: input.publishedAt,
    language_code: input.languageCode,
    cover_image_url: input.coverImageUrl,
    favicon_bytes: input.favicon?.byteaHex ?? null,
    favicon_mime_type: input.favicon?.mimeType ?? null,
    favicon_source_url: input.favicon?.sourceUrl ?? null,
    favicon_fetched_at: input.favicon?.fetchedAt ?? null,
    fetch_etag: input.fetched.etag,
    fetch_last_modified: input.fetched.lastModified,
    last_http_status: input.fetched.status,
    last_successful_fetch_at: input.fetched.fetchedAt,
  };
}

export function trimText(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxChars);
}

export function trimUrl(value: string | null | undefined): string | null {
  const trimmed = trimText(value, MAX_URL_CHARS);
  return trimmed ? trimmed : null;
}

export function sanitizeParsedBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
  return blocks
    .slice(0, maxParsedBlocks)
    .map((block) => sanitizeParsedBlock(block))
    .filter((block): block is ParsedBlock => block !== null);
}

export function deriveParsedDocumentMetrics(
  parsedDocument: Record<string, unknown>,
): {
  wordCount: number;
  estimatedReadSeconds: number;
  blockCount: number;
  imageCount: number;
} {
  const blocks = Array.isArray(parsedDocument.blocks)
    ? parsedDocument.blocks
    : [];
  let wordCount = 0;
  let imageCount = 0;

  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const blockRecord = block as Record<string, unknown>;
    const blockType = typeof blockRecord.type === "string"
      ? blockRecord.type
      : null;
    if (blockType === "image") {
      imageCount += 1;
    }

    wordCount += countWordsInBlock(blockRecord);
  }

  return {
    wordCount,
    estimatedReadSeconds: Math.max(1, Math.ceil(wordCount / 220 * 60)),
    blockCount: blocks.length,
    imageCount,
  };
}

export function enforceParsedDocumentSizeLimit(
  parsedDocument: Record<string, unknown>,
  partialUpdate: PartialContentUpdate,
): Record<string, unknown> {
  const encoded = new TextEncoder().encode(JSON.stringify(parsedDocument));
  if (encoded.byteLength > maxParsedDocumentBytes) {
    throw ProcessingFailure.parse("Parsed document exceeded the size limit", {
      retryable: false,
      partialUpdate,
    });
  }

  return parsedDocument;
}

export function summarizeBlocks(blocks: ParsedBlock[]): string | null {
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "quote") {
      return summarizeText(block.text, 280);
    }

    if (block.type === "thread_post") {
      return summarizeText(block.text, 280);
    }
  }

  return null;
}

export function toByteaHex(bytes: Uint8Array): string {
  let hex = "\\x";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

function appendBlocksFromElement(
  element: Element,
  blocks: ParsedBlock[],
  baseUrl: string,
): void {
  const tagName = element.tagName.toLowerCase();
  if (noisyArticleTags.has(tagName) || isHiddenElement(element)) {
    return;
  }

  switch (tagName) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = extractHeadingText(element);
      if (text) {
        pushParsedBlock(blocks, {
          type: "heading",
          level: Number.parseInt(tagName.slice(1), 10),
          text,
        });
      }
      return;
    }
    case "p": {
      const text = extractVisibleText(element);
      if (text) {
        pushParsedBlock(blocks, { type: "paragraph", text });
      }
      return;
    }
    case "blockquote": {
      const text = extractVisibleText(element);
      if (text) {
        pushParsedBlock(blocks, { type: "quote", text });
      }
      return;
    }
    case "ul":
    case "ol": {
      const items = (Array.from(element.children) as Element[])
        .filter((child) => child.tagName.toLowerCase() === "li")
        .map((item) => extractListItemText(item))
        .filter(Boolean);
      if (items.length > 0) {
        pushParsedBlock(blocks, {
          type: "list",
          style: tagName === "ol" ? "numbered" : "bulleted",
          items,
        });
      }
      return;
    }
    case "pre":
    case "code": {
      const codeBlock = extractCodeBlock(element);
      if (codeBlock) {
        pushParsedBlock(blocks, codeBlock);
      }
      return;
    }
    case "img": {
      const url = extractImageUrl(element, baseUrl);
      if (url) {
        pushParsedBlock(blocks, {
          type: "image",
          url,
          alt: collapseWhitespace(element.getAttribute("alt") ?? "") || null,
          caption: null,
        });
      }
      return;
    }
    case "figure": {
      const image = element.querySelector("img");
      if (image) {
        const url = extractImageUrl(image, baseUrl);
        if (url) {
          pushParsedBlock(blocks, {
            type: "image",
            url,
            alt: collapseWhitespace(image.getAttribute("alt") ?? "") || null,
            caption: collapseWhitespace(
              element.querySelector("figcaption")?.textContent ?? "",
            ) || null,
          });
          return;
        }
      }
      break;
    }
    default:
      break;
  }

  if (element.children.length === 0) {
    const text = extractVisibleText(element);
    if (text) {
      pushParsedBlock(blocks, { type: "paragraph", text });
    }
    return;
  }

  for (const child of Array.from(element.children) as Element[]) {
    appendBlocksFromElement(child, blocks, baseUrl);
  }
}

function socialPostFromJsonLd(
  entry: Record<string, unknown>,
  resolvedUrl: string,
): ThreadPostBlock | null {
  const types = normalizeJsonLdTypes(entry["@type"]);
  if (!types.includes("socialmediaposting")) {
    return null;
  }

  const text = collapseWhitespace(
    stringValue(entry.articleBody) ??
      stringValue(entry.description) ??
      stringValue(entry.headline) ??
      "",
  );
  if (!text) {
    return null;
  }

  const url = stringValue(entry.url) ?? resolvedUrl;
  const author = objectValue(entry.author);
  const authorHandle = stringValue(author?.additionalName) ??
    stringValue(author?.alternateName) ??
    null;
  const displayName = stringValue(author?.name) ?? null;

  return {
    type: "thread_post",
    post_id: extractPostId(url),
    author_handle: authorHandle?.replace(/^@/, "") ?? null,
    display_name: displayName,
    published_at: parseIsoDate(
      stringValue(entry.dateCreated) ?? stringValue(entry.datePublished),
    ),
    text,
    media: normalizeMediaItems(entry),
  };
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

function selectPrimaryArticleJsonLd(
  objects: Record<string, unknown>[],
): Record<string, unknown> | null {
  const articleObjects = objects
    .filter((entry) => {
      const types = normalizeJsonLdTypes(entry["@type"]);
      return types.includes("article") ||
        types.includes("blogposting") ||
        types.includes("newsarticle") ||
        types.includes("reportagearticle") ||
        types.includes("liveblogposting");
    });

  return articleObjects
    .sort((left, right) =>
      scoreArticleJsonLd(right) - scoreArticleJsonLd(left)
    )[0] ??
    null;
}

function scoreArticleJsonLd(entry: Record<string, unknown>): number {
  const types = normalizeJsonLdTypes(entry["@type"]);
  let score = 0;

  if (types.includes("newsarticle")) {
    score += 20;
  }
  if (types.includes("article") || types.includes("blogposting")) {
    score += 16;
  }
  if (stringValue(entry.headline) || stringValue(entry.name)) {
    score += 20;
  }
  if (extractJsonLdArticleAuthor(entry)) {
    score += 18;
  }
  if (stringValue(entry.datePublished) || stringValue(entry.dateCreated)) {
    score += 12;
  }
  if (
    extractJsonLdImageUrl(entry.image) ||
    extractJsonLdImageUrl(entry.thumbnailUrl)
  ) {
    score += 8;
  }

  const articleBody = decodeHtmlEntities(
    stringValue(entry.articleBody) ?? stringValue(entry.description),
  ) ?? "";
  score += Math.min(120, Math.floor(articleBody.length / 60));

  return score;
}

function extractJsonLdArticleTitle(
  entry: Record<string, unknown> | null,
): string | null {
  if (!entry) {
    return null;
  }

  return firstNonEmpty(
    decodeHtmlEntities(stringValue(entry.headline)),
    decodeHtmlEntities(stringValue(entry.name)),
  );
}

function extractJsonLdArticleDescription(
  entry: Record<string, unknown> | null,
): string | null {
  if (!entry) {
    return null;
  }

  return firstNonEmpty(
    decodeHtmlEntities(stringValue(entry.description)),
    decodeHtmlEntities(stringValue(entry.articleBody)),
  );
}

function extractJsonLdPublisherName(
  entry: Record<string, unknown> | null,
): string | null {
  if (!entry) {
    return null;
  }

  return decodeHtmlEntities(
    stringValue(objectValue(entry.publisher)?.name) ??
      stringValue(entry.publisher),
  );
}

function extractJsonLdArticleAuthor(
  entry: Record<string, unknown> | null,
): string | null {
  if (!entry) {
    return null;
  }

  for (const candidate of arrayValue(entry.author)) {
    if (typeof candidate === "string") {
      const decoded = decodeHtmlEntities(candidate);
      if (decoded) {
        return decoded;
      }
      continue;
    }

    const record = objectValue(candidate);
    const name = decodeHtmlEntities(stringValue(record?.name));
    if (name) {
      return name;
    }
  }

  const creator = decodeHtmlEntities(stringValue(entry.creator));
  return creator ?? null;
}

function extractJsonLdImageUrl(value: unknown): string | null {
  for (const candidate of arrayValue(value)) {
    if (typeof candidate === "string") {
      return trimUrl(candidate);
    }

    const record = objectValue(candidate);
    const url = trimUrl(
      stringValue(record?.url) ?? stringValue(record?.contentUrl),
    );
    if (url) {
      return url;
    }
  }

  return null;
}

function selectPrimaryWebsiteName(
  objects: Record<string, unknown>[],
): string | null {
  for (const entry of objects) {
    const types = normalizeJsonLdTypes(entry["@type"]);
    if (!types.includes("website") && !types.includes("blog")) {
      continue;
    }

    const name = decodeHtmlEntities(stringValue(entry.name));
    if (name) {
      return name;
    }
  }

  return null;
}

function selectPrimarySitePersonName(
  objects: Record<string, unknown>[],
): string | null {
  const people = objects
    .filter((entry) => normalizeJsonLdTypes(entry["@type"]).includes("person"))
    .map((entry) => decodeHtmlEntities(stringValue(entry.name)))
    .filter((name): name is string => name !== null);

  if (people.length !== 1) {
    return null;
  }

  return people[0];
}

function extractDocumentAuthor(document: Document): string | null {
  const selectors = [
    "article [rel='author']",
    "main [rel='author']",
    "article [itemprop='author']",
    "main [itemprop='author']",
    "article .author-name",
    "main .author-name",
    "article .byline",
    "main .byline",
    "article .author",
    "main .author",
  ];

  for (const selector of selectors) {
    for (
      const candidate of Array.from(
        document.querySelectorAll(selector),
      ) as Element[]
    ) {
      const normalized = normalizeAuthorText(candidate.textContent);
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}

function extractDocumentSiteOwner(document: Document): string | null {
  const profileAlt = normalizeAuthorText(
    document.querySelector("img.profile_photo[alt], img.u-photo[alt]")
      ?.getAttribute("alt")
      ?.replace(/\bprofile photo\b/i, ""),
  );
  if (profileAlt) {
    return profileAlt;
  }

  const selectors = [
    ".h-card .p-name",
    ".site-title.p-name",
    ".site-title .p-name",
    "header .p-name.u-url",
  ];
  for (const selector of selectors) {
    const candidate = document.querySelector(selector) as Element | null;
    const normalized = normalizeAuthorText(candidate?.textContent ?? null);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeAuthorText(value: string | null | undefined): string | null {
  const normalized = decodeHtmlEntities(value) ??
    collapseWhitespace(value ?? "");
  if (!normalized) {
    return null;
  }

  const urlList = normalized.split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (
    urlList.length > 0 &&
    urlList.every((candidate) => /^https?:\/\//i.test(candidate))
  ) {
    return null;
  }

  const stripped = normalized
    .replace(/^by\s+/i, "")
    .replace(/\s*\|\s*.*$/, "")
    .trim();
  if (!stripped || stripped.length > MAX_AUTHOR_CHARS) {
    return null;
  }
  if (/^https?:\/\//i.test(stripped)) {
    return null;
  }

  return stripped;
}

function normalizeAuthorHandle(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeAuthorText(value);
  return normalized?.replace(/^@/, "") ?? null;
}

function filterSiteOwnerCandidate(
  candidate: string | null | undefined,
  siteName: string | null,
): string | null {
  const normalized = normalizeAuthorText(candidate);
  if (!normalized) {
    return null;
  }

  const comparableCandidate = comparableIdentity(normalized);
  const comparableSite = comparableIdentity(siteName);
  if (comparableSite && comparableCandidate === comparableSite) {
    return null;
  }

  const siteCore = comparableHostCore(siteName);
  if (siteCore && comparableCandidate === siteCore) {
    return null;
  }

  return normalized;
}

function comparableIdentity(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function comparableHostCore(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const raw = value.trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const hostname = raw
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "");
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length === 0) {
    return null;
  }

  const core = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  return comparableIdentity(core);
}

function decodeHtmlEntities(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!/[&<>]/.test(trimmed)) {
    return collapseWhitespace(trimmed);
  }

  const decoded = collapseWhitespace(
    parseDocument(`<html><body>${trimmed}</body></html>`).body?.textContent ??
      trimmed,
  );
  return decoded || collapseWhitespace(trimmed);
}

function extractArchiveSourceUrlFromDocument(
  document: Document,
): string | null {
  const input = document.querySelector(
    "input[name='q'][value]",
  ) as Element | null;
  return input?.getAttribute("value")?.trim() ?? null;
}

function normalizeArchiveSourceUrl(
  baseUrl: string,
  candidate: string | null | undefined,
): string | null {
  const resolved = resolveUrl(baseUrl, candidate);
  if (!resolved) {
    return null;
  }

  try {
    const parsed = new URL(resolved);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function selectArchivePrimaryArticle(
  document: Document,
): Element | null {
  const jumpTarget = document.querySelector("#that-jump-content--default");
  const scopedMain = jumpTarget?.parentElement?.querySelector("main");
  const candidates = Array.from(
    (scopedMain ?? document).querySelectorAll("article"),
  ) as Element[];

  for (const candidate of candidates) {
    const title = collapseWhitespace(
      candidate.querySelector("h1")?.textContent ?? "",
    );
    const textLength = collapseWhitespace(candidate.textContent ?? "").length;
    if (
      title &&
      !/^(more from|up next)\b/i.test(title) &&
      textLength >= 500 &&
      (
        candidate.querySelector("[rel='author']") ||
        candidate.querySelector("time[datetime]")
      )
    ) {
      return candidate;
    }
  }

  return candidates
    .filter((candidate) =>
      collapseWhitespace(candidate.querySelector("h1")?.textContent ?? "")
        .length >
        0
    )
    .sort((left, right) =>
      collapseWhitespace(right.textContent ?? "").length -
      collapseWhitespace(left.textContent ?? "").length
    )[0] ?? null;
}

export function extractArchiveSourceRootHtml(article: Element): string | null {
  const root = article.cloneNode(true) as Element;
  sanitizeArchiveArticleRoot(root);
  return root.outerHTML || null;
}

function extractArchiveArticleHtml(article: Element): string | null {
  const root = article.cloneNode(true) as Element;
  sanitizeArchiveArticleRoot(root);
  const children = Array.from(root.children) as Element[];
  const headerIndex = children.findIndex((child) => child.querySelector("h1"));
  const bodyIndex = children.findIndex((child) =>
    child.querySelector("[rel='author']") ||
    child.querySelector("time[datetime]") ||
    looksLikeArchiveBodyChild(child)
  );

  const selected: string[] = [];
  if (headerIndex >= 0) {
    selected.push(children[headerIndex].outerHTML);
  }

  const start = headerIndex >= 0 ? headerIndex + 1 : 0;
  const end = bodyIndex >= 0 ? bodyIndex : children.length;
  for (let index = start; index < end; index += 1) {
    const child = children[index];
    if (child.querySelector("img, picture, figure, video")) {
      selected.push(child.outerHTML);
    }
  }

  if (bodyIndex >= 0) {
    const bodyClone = children[bodyIndex].cloneNode(true) as Element;
    sanitizeArchiveBody(bodyClone);
    if (
      collapseWhitespace(bodyClone.textContent ?? "") ||
      bodyClone.querySelector("img")
    ) {
      selected.push(bodyClone.outerHTML);
    }
  }

  const fragment = selected.join("");
  if (!fragment) {
    return null;
  }

  const fragmentDocument = parseDocument(
    `<html><body>${fragment}</body></html>`,
  );
  const fragmentTextLength = collapseWhitespace(
    fragmentDocument.body?.textContent ?? "",
  ).length;
  const readable = new Readability(
    parseDocument(`<html><body>${fragment}</body></html>`),
  ).parse();
  const readableTextLength = collapseWhitespace(readable?.textContent ?? "")
    .length;

  if (
    !readable?.content ||
    (fragmentTextLength > 0 && readableTextLength < fragmentTextLength * 0.55)
  ) {
    return fragment;
  }

  return readable.content;
}

function looksLikeArchiveBodyChild(element: Element): boolean {
  const textLength = collapseWhitespace(element.textContent ?? "").length;
  const substantialChildCount = (Array.from(element.children) as Element[])
    .filter((child) => {
      if (child.querySelector("h1, h2, h3, h4, h5, h6")) {
        return false;
      }

      if (
        looksLikeArchiveMetadataRow(child) ||
        looksLikeArchiveSignupModule(child) ||
        isArchivePromotionalText(child)
      ) {
        return false;
      }

      const childTextLength =
        collapseWhitespace(child.textContent ?? "").length;
      if (childTextLength >= 120) {
        return true;
      }

      return child.querySelectorAll("p, blockquote, ul, ol, pre").length > 0;
    })
    .length;

  return textLength >= 1200 ||
    (textLength >= 400 && !!element.querySelector("img, figure")) ||
    element.querySelectorAll("p").length >= 2 ||
    substantialChildCount >= 2 ||
    (substantialChildCount >= 1 && textLength >= 500);
}

function sanitizeArchiveArticleRoot(root: Element): void {
  for (
    const nestedArticle of Array.from(
      root.querySelectorAll("article article"),
    ) as Element[]
  ) {
    nestedArticle.remove();
  }

  for (const section of Array.from(root.querySelectorAll("*")) as Element[]) {
    if (looksLikeArchiveRelatedSection(section)) {
      section.remove();
    }
  }

  sanitizeArchiveBody(root);
}

function sanitizeArchiveBody(root: Element): void {
  for (
    const element of Array.from(root.querySelectorAll("*")) as Element[]
  ) {
    if (looksLikeArchiveMetadataRow(element)) {
      element.remove();
      continue;
    }

    if (looksLikeArchiveSignupModule(element)) {
      element.remove();
      continue;
    }

    if (isArchivePromotionalText(element)) {
      element.remove();
      continue;
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") {
      if (element.querySelector("img, picture, figure, video, source")) {
        unwrapElement(element);
      } else {
        element.remove();
      }
      continue;
    }

    if (
      tagName === "form" ||
      tagName === "input" ||
      tagName === "label" ||
      tagName === "option"
    ) {
      element.remove();
      continue;
    }

    const style = (element.getAttribute("style") ?? "").toLowerCase();
    if (style.includes("display:none") || style.includes("visibility:hidden")) {
      element.remove();
    }
  }
}

function looksLikeArchiveMetadataRow(element: Element): boolean {
  const text = collapseWhitespace(element.textContent ?? "");
  if (!text) {
    return false;
  }

  const hasRichContent = !!element.querySelector(
    "p, figure, img, video, article, form, blockquote, ul, ol",
  );
  if (hasRichContent) {
    return false;
  }

  if (element.querySelector("[rel='author']")) {
    return true;
  }

  if (element.matches("time[datetime]")) {
    return text.length <= 80;
  }

  return !!element.querySelector("time[datetime]") && text.length <= 80;
}

function looksLikeArchiveSignupModule(element: Element): boolean {
  const text = collapseWhitespace(element.textContent ?? "");
  if (!text) {
    return false;
  }

  const hasSignupControls = !!element.querySelector(
    "form, input[type='email'], button[type='submit']",
  );
  if (!hasSignupControls) {
    return false;
  }

  const contentBlockCount = element.querySelectorAll(
    "p, h1, h2, h3, h4, blockquote, ul, ol, pre",
  ).length;
  if (contentBlockCount >= 3 || text.length > 360) {
    return false;
  }

  return /\b(newsletter|sign up|subscribe|enter your email)\b/i.test(text) ||
    /\b(privacy policy|terms of service)\b/i.test(text);
}

function looksLikeArchiveRelatedSection(element: Element): boolean {
  if (!element.querySelector("article, li, a[href], h2, h3, h4")) {
    return false;
  }

  const heading = collapseWhitespace(
    element.querySelector("h1, h2, h3, h4")?.textContent ?? "",
  );
  if (!heading) {
    return false;
  }

  return /^(more from|up next|related|recommended|you may also like|read more|relacionad[oa]s?|m[aá]s de|tambi[eé]n te puede gustar)\b/i
    .test(heading);
}

function unwrapElement(element: Element): void {
  const parent = element.parentNode;
  if (!parent) {
    return;
  }

  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }
  element.remove();
}

function isArchivePromotionalText(element: Element): boolean {
  const text = collapseWhitespace(element.textContent ?? "");
  if (!text) {
    return false;
  }

  return /^follow all new stories by\b/i.test(text) ||
    /^(following|get alerts|sign up)\b/i.test(text) ||
    /^up next\b/i.test(text) ||
    /^more from\b/i.test(text) ||
    /^related\b/i.test(text) ||
    /^recommended\b/i.test(text) ||
    /^you may also like\b/i.test(text) ||
    /^read more\b/i.test(text) ||
    /^share\b/i.test(text) ||
    /^contact us:/i.test(text) ||
    /^confidential tip\?/i.test(text) ||
    /^site feedback:/i.test(text) ||
    /^gift this article\b/i.test(text);
}

function extractArchiveHeaderDescription(
  article: Element,
  title: string | null,
): string | null {
  const header = article.querySelector("header") as Element | null;
  if (!header) {
    return null;
  }

  for (
    const candidate of Array.from(
      header.querySelectorAll("p, div"),
    ) as Element[]
  ) {
    if (candidate.querySelector("h1, h2, h3, h4, h5, h6")) {
      continue;
    }

    const text = collapseWhitespace(candidate.textContent ?? "");
    if (!text || text === title || text.length < 40) {
      continue;
    }

    return text;
  }

  return null;
}

function extractArchiveCoverImageUrl(
  article: Element,
  baseUrl: string,
): string | null {
  const image = article.querySelector("img") as Element | null;
  return image ? extractImageUrl(image, baseUrl) : null;
}

function extractSiteNameFromTitle(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parts = value
    .split(/\s[-|–—]\s/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const candidate = parts[parts.length - 1];
  return candidate.length <= 64 ? candidate : null;
}

function normalizeDiscoveredSourceUrl(
  baseUrl: string,
  maybeUrl: string | null | undefined,
  article: { url: string; host: string } | null,
): { url: string; host: string; pathDepth: number } | null {
  const resolved = resolveUrl(baseUrl, maybeUrl);
  if (!resolved) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }

  const defaultPort = parsed.protocol === "http:" ? "80" : "443";
  if (parsed.port && parsed.port !== defaultPort) {
    return null;
  }

  parsed.hash = "";
  if (parsed.port === defaultPort) {
    parsed.port = "";
  }
  parsed.search = "";

  const host = normalizeHostValue(parsed.hostname);
  if (!host || isDisallowedHostname(host)) {
    return null;
  }
  if (nonDiscoverableSourceHosts.has(host)) {
    return null;
  }

  if (article && !areRelatedHosts(host, article.host)) {
    return null;
  }

  const url = parsed.toString();
  if (article && url === article.url && parsed.pathname !== "/") {
    return null;
  }

  return {
    url,
    host,
    pathDepth: pathnameDepth(parsed.pathname),
  };
}

function buildRootSourceCandidate(articleUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(articleUrl);
  } catch {
    return null;
  }

  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  const defaultPort = parsed.protocol === "http:" ? "80" : "443";
  if (parsed.port === defaultPort) {
    parsed.port = "";
  }

  return parsed.toString();
}

function areRelatedHosts(left: string, right: string): boolean {
  const normalizedLeft = normalizeHostValue(left);
  const normalizedRight = normalizeHostValue(right);
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`.${normalizedRight}`) ||
    normalizedRight.endsWith(`.${normalizedLeft}`);
}

function pathnameDepth(pathname: string): number {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean).length;
}

function countWordsInBlock(block: Record<string, unknown>): number {
  const texts: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      texts.push(value);
    }
  };

  pushText(block.text);
  pushText(block.caption);
  pushText(block.alt);
  if (Array.isArray(block.items)) {
    for (const item of block.items) {
      pushText(item);
    }
  }

  if (Array.isArray(block.media)) {
    for (const media of block.media) {
      if (media && typeof media === "object") {
        pushText((media as Record<string, unknown>).alt);
      }
    }
  }

  return texts
    .flatMap((text) => text.trim().split(/\s+/))
    .filter((word) => word.length > 0).length;
}

function sanitizeParsedBlock(block: ParsedBlock): ParsedBlock | null {
  switch (block.type) {
    case "heading": {
      const text = trimText(block.text, maxTextChars);
      if (!text) {
        return null;
      }

      return {
        type: "heading",
        level: Math.min(Math.max(block.level, 1), 6),
        text,
      };
    }
    case "paragraph":
    case "quote": {
      const text = trimText(block.text, maxTextChars);
      return text ? { type: block.type, text } : null;
    }
    case "list": {
      const items = block.items
        .slice(0, maxListItems)
        .map((item) => trimText(item, maxListItemChars))
        .filter((item): item is string => item !== null);
      if (items.length === 0) {
        return null;
      }

      return {
        type: "list",
        style: block.style,
        items,
      };
    }
    case "code": {
      const text = trimText(block.text, maxCodeChars);
      if (!text) {
        return null;
      }

      return {
        type: "code",
        language: trimText(block.language, 64),
        text,
      };
    }
    case "image": {
      const url = trimUrl(block.url);
      if (!url) {
        return null;
      }

      return {
        type: "image",
        url,
        alt: trimText(block.alt, maxTextChars),
        caption: trimText(block.caption, maxTextChars),
      };
    }
    case "thread_post": {
      const text = trimText(block.text, maxTextChars);
      if (!text) {
        return null;
      }

      return {
        type: "thread_post",
        post_id: trimText(block.post_id, 64),
        author_handle: trimText(block.author_handle, MAX_THREAD_HANDLE_CHARS),
        display_name: trimText(
          block.display_name,
          MAX_THREAD_DISPLAY_NAME_CHARS,
        ),
        published_at: block.published_at,
        text,
        media: block.media
          .slice(0, MAX_THREAD_MEDIA_ITEMS)
          .map((item) => {
            const url = trimUrl(item.url);
            if (!url) {
              return null;
            }

            return {
              kind: item.kind,
              url,
              alt: trimText(item.alt, maxTextChars),
            };
          })
          .filter((item): item is ThreadMediaItem => item !== null),
      };
    }
  }
}

function normalizeLinkRel(value: string | null): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isFaviconRel(rel: string[]): boolean {
  return rel.includes("icon") || rel.includes("apple-touch-icon") ||
    rel.includes("mask-icon");
}

function faviconCandidatePriority(input: {
  rel: string[];
  sizes: string | null;
  type: string | null;
  url: string;
}): number {
  let priority = input.rel.includes("icon") ? 0 : 20;
  const type = (input.type ?? "").toLowerCase();
  const url = input.url.toLowerCase();
  const sizes = (input.sizes ?? "").toLowerCase();

  if (sizes === "any" || type.includes("svg") || url.endsWith(".svg")) {
    priority -= 3;
  } else if (type.includes("png") || url.endsWith(".png")) {
    priority -= 2;
  } else if (type.includes("ico") || url.endsWith(".ico")) {
    priority -= 1;
  }

  if (input.rel.includes("mask-icon")) {
    priority += 5;
  }

  return priority;
}

function measureReadableText(element: Element): number {
  const clone = element.cloneNode(true) as Element;
  removeNoisyDescendants(clone);
  return collapseWhitespace(clone.textContent ?? "").length;
}

function removeNoisyDescendants(element: Element): void {
  for (
    const descendant of Array.from(element.querySelectorAll("*")) as Element[]
  ) {
    if (
      noisyArticleTags.has(descendant.tagName.toLowerCase()) ||
      isHiddenElement(descendant)
    ) {
      descendant.remove();
    }
  }
}

function isHiddenElement(element: Element): boolean {
  return element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true" ||
    /\b(sr-only|visually-hidden|screen-reader-text)\b/i.test(
      element.getAttribute("class") ?? "",
    );
}

function extractHeadingText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (
    const descendant of Array.from(clone.querySelectorAll("*")) as Element[]
  ) {
    const className = descendant.getAttribute("class") ?? "";
    if (
      isHiddenElement(descendant) ||
      /\b(anchor|anchor-link|header-anchor|hash-link)\b/i.test(className) ||
      (
        descendant.tagName.toLowerCase() === "a" &&
        ["#", "¶", "§"].includes(
          collapseWhitespace(descendant.textContent ?? ""),
        )
      )
    ) {
      descendant.remove();
    }
  }

  return normalizeHeadingText(clone.textContent ?? "") ||
    normalizeHeadingText(element.textContent ?? "");
}

function normalizeHeadingText(value: string): string {
  return collapseWhitespace(value)
    .replace(/^[#§¶]+\s*(?=\S)/, "")
    .replace(/\s*[#§¶]+$/, "")
    .trim();
}

function extractVisibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  removeNoisyDescendants(clone);
  return collapseWhitespace(clone.textContent ?? "");
}

function extractListItemText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (
    const nestedList of Array.from(
      clone.querySelectorAll("ul, ol"),
    ) as Element[]
  ) {
    nestedList.remove();
  }
  removeNoisyDescendants(clone);
  return collapseWhitespace(clone.textContent ?? "");
}

function extractCodeBlock(element: Element): ParsedBlock | null {
  const tagName = element.tagName.toLowerCase();
  const source = tagName === "pre"
    ? (element.querySelector("code") as Element | null) ?? element
    : element;
  const text = (source.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) {
    return null;
  }

  const language = source.getAttribute("data-language") ??
    source.getAttribute("data-lang") ??
    source.getAttribute("class")?.match(/language-([a-z0-9_-]+)/i)?.[1] ??
    element.getAttribute("data-language") ??
    element.getAttribute("data-lang") ??
    element.getAttribute("class")?.match(/language-([a-z0-9_-]+)/i)?.[1] ??
    null;

  return { type: "code", language, text };
}

function extractImageUrl(element: Element, baseUrl: string): string | null {
  const directUrl = resolveUrl(
    baseUrl,
    element.getAttribute("currentSourceUrl") ??
      element.getAttribute("data-current-src"),
  );
  if (directUrl) {
    return directUrl;
  }

  const srcset = element.getAttribute("srcset") ??
    element.getAttribute("data-srcset");
  if (srcset) {
    const candidate = srcset.split(",")
      .map((entry: string) => entry.trim().split(/\s+/, 1)[0])
      .find(Boolean);
    const resolved = resolveUrl(baseUrl, candidate);
    if (resolved) {
      return resolved;
    }
  }

  return resolveUrl(
    baseUrl,
    element.getAttribute("src") ??
      element.getAttribute("data-src") ??
      element.getAttribute("data-original"),
  );
}

function pushParsedBlock(blocks: ParsedBlock[], block: ParsedBlock): void {
  const previous = blocks[blocks.length - 1];
  if (previous && JSON.stringify(previous) === JSON.stringify(block)) {
    return;
  }

  blocks.push(block);
}

function extractThreadPostsFromMarkup(
  document: Document,
  resolvedUrl: string,
): ThreadPostBlock[] {
  const articles = Array.from(
    document.querySelectorAll("article"),
  ) as Element[];
  return articles
    .map((article) => socialPostFromMarkup(article, resolvedUrl))
    .filter((post): post is ThreadPostBlock => post !== null);
}

function socialPostFromMarkup(
  article: Element,
  resolvedUrl: string,
): ThreadPostBlock | null {
  const textSource = (
    article.querySelector("[data-testid='tweetText']") ??
      article.querySelector("div[lang]") ??
      article
  ) as Element;
  const text = extractVisibleText(textSource);
  if (!text) {
    return null;
  }

  const statusLink = Array.from(
    article.querySelectorAll("a[href*='/status/']") as Element[],
  )
    .map((element) => resolveUrl(resolvedUrl, element.getAttribute("href")))
    .find(Boolean) ?? resolvedUrl;
  const handle = extractHandleFromUrl(statusLink ?? resolvedUrl);
  const userNameContainer = article.querySelector(
    "[data-testid='User-Name']",
  ) as Element | null;
  const nameFragments = Array.from(
    (userNameContainer?.querySelectorAll("span") ?? []) as Element[],
  )
    .map((element) => collapseWhitespace(element.textContent ?? ""))
    .filter(Boolean);
  const displayName = nameFragments.find((entry) => !entry.startsWith("@")) ??
    null;
  const authorHandle = nameFragments
    .find((entry) => entry.startsWith("@"))
    ?.replace(/^@/, "") ?? handle;
  const media = extractThreadMediaFromMarkup(article, resolvedUrl);

  return {
    type: "thread_post",
    post_id: extractPostId(statusLink ?? resolvedUrl),
    author_handle: authorHandle,
    display_name: displayName,
    published_at: parseIsoDate(
      article.querySelector("time")?.getAttribute("datetime") ?? null,
    ),
    text,
    media,
  };
}

function extractThreadMediaFromMarkup(
  article: Element,
  resolvedUrl: string,
): ThreadMediaItem[] {
  const media: ThreadMediaItem[] = [];

  for (
    const image of Array.from(article.querySelectorAll("img")) as Element[]
  ) {
    const url = extractImageUrl(image, resolvedUrl);
    if (!url || /profile_images|emoji|abs-0\.twimg\.com/i.test(url)) {
      continue;
    }

    media.push({
      kind: "image",
      url,
      alt: collapseWhitespace(image.getAttribute("alt") ?? "") || null,
    });
  }

  for (
    const video of Array.from(
      article.querySelectorAll("video, video source"),
    ) as Element[]
  ) {
    const url = resolveUrl(
      resolvedUrl,
      video.getAttribute("src") ?? video.getAttribute("data-src"),
    );
    if (!url) {
      continue;
    }

    media.push({ kind: "video", url, alt: null });
  }

  return media;
}

function extractHandleFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/^\/([^/]+)\/status\//i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractHandleFromProfileUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }

  try {
    const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
    return pathname ? pathname.split("/")[0] : null;
  } catch {
    return null;
  }
}

function dedupeThreadPosts(posts: ThreadPostBlock[]): ThreadPostBlock[] {
  const seen = new Set<string>();
  const deduped: ThreadPostBlock[] = [];
  for (const post of posts) {
    const key = `${post.post_id ?? ""}:${post.text}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(post);
  }

  return deduped;
}

function normalizeMediaItems(
  entry: Record<string, unknown>,
): ThreadMediaItem[] {
  const candidates = [
    ...arrayValue(entry.image),
    ...arrayValue(entry.associatedMedia),
  ];

  return candidates
    .map((item) => {
      if (typeof item === "string") {
        return { kind: "image" as const, url: item, alt: null };
      }

      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const url = stringValue(record.url) ?? stringValue(record.contentUrl);
      if (!url) {
        return null;
      }

      const type = normalizeJsonLdTypes(record["@type"]);
      const kind = type.includes("videoobject") ? "video" : "image";
      return {
        kind,
        url,
        alt: stringValue(record.description) ?? null,
      };
    })
    .filter((item): item is ThreadMediaItem => item !== null);
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
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function extractPostId(url: string): string | null {
  const match = url.match(/status\/(\d+)/i);
  return match?.[1] ?? null;
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (value && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function parseIsoDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeLanguageCode(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().replace("_", "-").toLowerCase();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_LANGUAGE_CODE_CHARS);
}

function parseHumanDateText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) {
    return null;
  }

  const month = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].indexOf(match[1].toLowerCase());
  if (month < 0) {
    return null;
  }

  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const parsed = new Date(Date.UTC(year, month, day));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summarizeText(value: string, maxChars: number): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) {
    return collapsed;
  }

  const truncated = collapsed.slice(0, maxChars).trimEnd();
  const sentenceBoundary = findSentenceBoundary(truncated);
  if (sentenceBoundary >= Math.floor(maxChars * 0.55)) {
    return truncated.slice(0, sentenceBoundary).trimEnd();
  }

  const lastBoundary = truncated.search(/\s+\S*$/);
  if (lastBoundary >= Math.floor(maxChars * 0.65)) {
    return truncated.slice(0, lastBoundary).trimEnd();
  }

  return truncated;
}

function findSentenceBoundary(value: string): number {
  const matches = Array.from(value.matchAll(/[.?!]["')\]]?(?:\s|$)/g));
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch || lastMatch.index === undefined) {
    return -1;
  }

  return lastMatch.index + lastMatch[0].trimEnd().length;
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

function normalizeHostValue(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function safeHost(url: string): string | null {
  try {
    return normalizeHostValue(new URL(url).hostname);
  } catch {
    return null;
  }
}
