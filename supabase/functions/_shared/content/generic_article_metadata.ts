import type { ContentMetadata, Document, Element } from "./model.ts";
import { trimUrl } from "./normalize.ts";

interface CoverImageCandidate {
  url: string;
  sourceId: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  proseBlocksBefore: number | null;
  contextHint: string;
  score: number;
}

const MIN_COVER_IMAGE_SCORE = 32;
const ARTICLE_IMAGE_ROOT_SELECTORS = [
  "article",
  "[itemprop='articleBody']",
  ".post-content",
  ".entry-content",
  ".article-content",
  ".article-body",
  ".post-body",
  "main",
] as const;
const ARTICLE_JSON_LD_TYPES = new Set([
  "article",
  "blogposting",
  "newsarticle",
  "reportagearticle",
  "analysisnewsarticle",
  "opinionnewsarticle",
]);
const EXCERPT_BOILERPLATE_PATTERNS = [
  /^(share|follow|subscribe|newsletter|sign up|get alerts)\b/i,
  /^(read more|related|recommended|you may also like|more from)\b/i,
];
const LOW_VALUE_IMAGE_PATTERNS = [
  /\bavatar\b/i,
  /\bprofile(?:[_ -]?photo)?\b/i,
  /\bauthor[-_ ]?avatar\b/i,
  /\bu-photo\b/i,
  /\bheadshot\b/i,
  /\bportrait\b/i,
  /\blogo\b/i,
  /\bfavicon\b/i,
  /\bicon\b/i,
  /\bemoji\b/i,
  /\/avatars?\//i,
  /\/profile_images?\//i,
  /\/gravatar\//i,
];

export function selectGenericArticleExcerpt(input: {
  metadataDescription: string | null;
  candidateExcerpt: string | null;
  title: string | null;
}): string | null {
  const candidates = [
    { source: "metadata", value: trimOrNull(input.metadataDescription) },
    { source: "candidate", value: trimOrNull(input.candidateExcerpt) },
  ].filter(
    (
      candidate,
    ): candidate is { source: "metadata" | "candidate"; value: string } =>
      candidate.value !== null,
  );

  if (candidates.length === 0) {
    return null;
  }

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreExcerptCandidate(
        candidate.value,
        candidate.source,
        input.title,
      ),
    }))
    .sort((left, right) =>
      right.score - left.score || left.value.length - right.value.length
    )[0]?.value ?? null;
}

export function selectGenericArticleCoverImage(input: {
  document: Document;
  resolvedUrl: string;
  metadata: ContentMetadata;
  title: string | null;
  author: string | null;
}): string | null {
  const articleRoot = selectPrimaryArticleImageRoot(input.document);
  const candidates = dedupeCoverImageCandidates([
    ...collectMetaCoverImageCandidates(input.document, input.resolvedUrl),
    ...collectJsonLdCoverImageCandidates(input.document, input.resolvedUrl),
    ...collectDomCoverImageCandidates(articleRoot, input.resolvedUrl),
  ]);
  const articleTokens = new Set([
    ...tokenizeComparable(input.title),
    ...tokenizeComparable(articleSlugFromUrl(input.resolvedUrl)),
  ]);

  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCoverImageCandidate(candidate, {
        articleTokens,
        siteName: input.metadata.siteName,
        author: input.author,
      }),
    }))
    .sort((left, right) =>
      right.score - left.score ||
      compareNullableNumber(right.width, left.width) ||
      compareNullableNumber(right.height, left.height)
    );
  const best = scored[0];

  if (!best || best.score < MIN_COVER_IMAGE_SCORE) {
    return null;
  }

  return best.url;
}

function scoreExcerptCandidate(
  value: string,
  source: "metadata" | "candidate",
  title: string | null,
): number {
  let score = source === "candidate" ? 14 : 10;
  const length = value.length;

  if (length >= 80 && length <= 320) {
    score += 18;
  } else if (length >= 50 && length <= 420) {
    score += 10;
  } else if (length > 420 && length <= 720) {
    score += 2;
  } else {
    score -= 10;
  }

  if (hasTruncationMarkers(value)) {
    score -= 14;
  }

  if (/[.?!]["')\]]?$/.test(value)) {
    score += 4;
  }

  if (
    EXCERPT_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(value)) ||
    comparableText(value) === comparableText(title)
  ) {
    score -= 40;
  }

  return score;
}

function collectMetaCoverImageCandidates(
  document: Document,
  resolvedUrl: string,
): CoverImageCandidate[] {
  const candidates: CoverImageCandidate[] = [];
  const meta = metaContentMap(document);
  const definitions = [
    {
      url: meta.get("og:image") ?? meta.get("og:image:url"),
      alt: meta.get("og:image:alt") ?? null,
      width: parseInteger(meta.get("og:image:width")),
      height: parseInteger(meta.get("og:image:height")),
      sourceId: "meta-og",
    },
    {
      url: meta.get("twitter:image"),
      alt: meta.get("twitter:image:alt") ?? null,
      width: null,
      height: null,
      sourceId: "meta-twitter",
    },
  ];

  for (const definition of definitions) {
    const url = normalizeImageUrl(resolvedUrl, definition.url);
    if (!url) {
      continue;
    }

    candidates.push({
      url,
      sourceId: definition.sourceId,
      alt: trimOrNull(definition.alt),
      width: definition.width,
      height: definition.height,
      proseBlocksBefore: null,
      contextHint: definition.sourceId,
      score: 0,
    });
  }

  return candidates;
}

function collectJsonLdCoverImageCandidates(
  document: Document,
  resolvedUrl: string,
): CoverImageCandidate[] {
  const objects = extractJsonLdObjects(document);
  const primaryArticle = selectPrimaryArticleJsonLd(objects);
  if (!primaryArticle) {
    return [];
  }

  const candidates: CoverImageCandidate[] = [];
  for (
    const definition of [
      { sourceId: "jsonld-image", value: primaryArticle.image },
      { sourceId: "jsonld-thumbnail", value: primaryArticle.thumbnailUrl },
    ]
  ) {
    for (const image of arrayValue(definition.value)) {
      const record = objectValue(image);
      const url = normalizeImageUrl(
        resolvedUrl,
        typeof image === "string"
          ? image
          : stringValue(record?.url) ?? stringValue(record?.contentUrl),
      );
      if (!url) {
        continue;
      }

      candidates.push({
        url,
        sourceId: definition.sourceId,
        alt: trimOrNull(
          stringValue(record?.caption) ??
            stringValue(record?.description) ??
            stringValue(record?.name),
        ),
        width: parseInteger(stringValue(record?.width)),
        height: parseInteger(stringValue(record?.height)),
        proseBlocksBefore: null,
        contextHint: definition.sourceId,
        score: 0,
      });
    }
  }

  return candidates;
}

function collectDomCoverImageCandidates(
  articleRoot: Element | null,
  resolvedUrl: string,
): CoverImageCandidate[] {
  if (!articleRoot) {
    return [];
  }

  const nodes = Array.from(
    articleRoot.querySelectorAll("p, blockquote, ul, ol, figure, img"),
  ) as Element[];
  const seenUrls = new Set<string>();
  let proseBlocksBefore = 0;
  const candidates: CoverImageCandidate[] = [];

  for (const node of nodes) {
    const tagName = node.tagName.toLowerCase();
    if (
      tagName === "p" || tagName === "blockquote" || tagName === "ul" ||
      tagName === "ol"
    ) {
      proseBlocksBefore += 1;
      continue;
    }

    if (
      tagName === "img" &&
      node.parentElement?.tagName?.toLowerCase() === "figure"
    ) {
      continue;
    }

    const imageRecord = extractDomImageRecord(node, resolvedUrl);
    if (!imageRecord || seenUrls.has(imageRecord.url)) {
      continue;
    }
    seenUrls.add(imageRecord.url);

    candidates.push({
      url: imageRecord.url,
      sourceId: imageRecord.inHeader ? "article-header" : "article-image",
      alt: imageRecord.alt,
      width: imageRecord.width,
      height: imageRecord.height,
      proseBlocksBefore,
      contextHint: imageRecord.contextHint,
      score: 0,
    });
  }

  return candidates.slice(0, 6);
}

function selectPrimaryArticleImageRoot(document: Document): Element | null {
  let best: Element | null = null;
  let bestScore = -1;

  for (const selector of ARTICLE_IMAGE_ROOT_SELECTORS) {
    for (
      const candidate of Array.from(
        document.querySelectorAll(selector),
      ) as Element[]
    ) {
      const score = measureReadableText(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }

  return best;
}

function extractDomImageRecord(
  element: Element,
  resolvedUrl: string,
): {
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  inHeader: boolean;
  contextHint: string;
} | null {
  const image = element.tagName.toLowerCase() === "img"
    ? element
    : (element.querySelector("img") as Element | null);
  if (!image) {
    return null;
  }

  const picture = image.parentElement?.tagName?.toLowerCase() === "picture"
    ? image.parentElement as Element
    : null;
  const sources = [
    ...collectImageSourceDescriptors(image, resolvedUrl),
    ...(picture ? collectPictureSourceDescriptors(picture, resolvedUrl) : []),
  ].sort((left, right) =>
    compareNullableNumber(right.width, left.width) ||
    compareNullableNumber(right.height, left.height)
  );
  const primary = sources[0];
  if (!primary) {
    return null;
  }

  return {
    url: primary.url,
    alt: trimOrNull(
      image.getAttribute("alt") ??
        element.querySelector("figcaption")?.textContent ??
        null,
    ),
    width: primary.width,
    height: primary.height,
    inHeader: hasAncestorTag(image, "header"),
    contextHint: collectContextHint(image),
  };
}

function collectImageSourceDescriptors(
  image: Element,
  resolvedUrl: string,
): Array<{ url: string; width: number | null; height: number | null }> {
  const candidates: Array<
    { url: string; width: number | null; height: number | null }
  > = [];
  const width = parseInteger(image.getAttribute("width"));
  const height = parseInteger(image.getAttribute("height"));

  const directUrl = normalizeImageUrl(
    resolvedUrl,
    image.getAttribute("currentSourceUrl") ??
      image.getAttribute("data-current-src"),
  );
  if (directUrl) {
    candidates.push({ url: directUrl, width, height });
  }

  const srcset = image.getAttribute("srcset") ??
    image.getAttribute("data-srcset");
  if (srcset) {
    candidates.push(
      ...parseSrcsetCandidates(srcset, resolvedUrl, width, height),
    );
  }

  const src = normalizeImageUrl(
    resolvedUrl,
    image.getAttribute("src") ??
      image.getAttribute("data-src") ??
      image.getAttribute("data-original"),
  );
  if (src) {
    candidates.push({ url: src, width, height });
  }

  return dedupeImageDescriptors(candidates);
}

function collectPictureSourceDescriptors(
  picture: Element,
  resolvedUrl: string,
): Array<{ url: string; width: number | null; height: number | null }> {
  const candidates: Array<
    { url: string; width: number | null; height: number | null }
  > = [];

  for (
    const source of Array.from(picture.querySelectorAll("source")) as Element[]
  ) {
    const width = parseInteger(source.getAttribute("width"));
    const height = parseInteger(source.getAttribute("height"));
    const srcset = source.getAttribute("srcset");
    if (srcset) {
      candidates.push(
        ...parseSrcsetCandidates(srcset, resolvedUrl, width, height),
      );
    }
  }

  return dedupeImageDescriptors(candidates);
}

function parseSrcsetCandidates(
  value: string,
  resolvedUrl: string,
  width: number | null,
  height: number | null,
): Array<{ url: string; width: number | null; height: number | null }> {
  const candidates: Array<
    { url: string; width: number | null; height: number | null }
  > = [];

  for (const entry of value.split(",")) {
    const [rawUrl, descriptor] = entry.trim().split(/\s+/, 2);
    const url = normalizeImageUrl(resolvedUrl, rawUrl);
    if (!url) {
      continue;
    }

    candidates.push({
      url,
      width: parseSrcsetWidth(descriptor) ?? width,
      height,
    });
  }

  return candidates;
}

function dedupeImageDescriptors(
  candidates: Array<
    { url: string; width: number | null; height: number | null }
  >,
): Array<{ url: string; width: number | null; height: number | null }> {
  const deduped = new Map<
    string,
    { url: string; width: number | null; height: number | null }
  >();

  for (const candidate of candidates) {
    const existing = deduped.get(candidate.url);
    if (
      !existing ||
      compareNullableNumber(candidate.width, existing.width) > 0 ||
      compareNullableNumber(candidate.height, existing.height) > 0
    ) {
      deduped.set(candidate.url, candidate);
    }
  }

  return Array.from(deduped.values());
}

function dedupeCoverImageCandidates(
  candidates: CoverImageCandidate[],
): CoverImageCandidate[] {
  const deduped = new Map<string, CoverImageCandidate>();

  for (const candidate of candidates) {
    const existing = deduped.get(candidate.url);
    if (!existing) {
      deduped.set(candidate.url, candidate);
      continue;
    }

    const existingSourceScore = coverImageSourceBaseScore(existing.sourceId);
    const nextSourceScore = coverImageSourceBaseScore(candidate.sourceId);
    if (
      nextSourceScore > existingSourceScore ||
      compareNullableNumber(candidate.width, existing.width) > 0 ||
      compareNullableNumber(candidate.height, existing.height) > 0
    ) {
      deduped.set(candidate.url, candidate);
    }
  }

  return Array.from(deduped.values());
}

function scoreCoverImageCandidate(
  candidate: CoverImageCandidate,
  context: {
    articleTokens: Set<string>;
    siteName: string | null;
    author: string | null;
  },
): number {
  let score = coverImageSourceBaseScore(candidate.sourceId);

  if (candidate.proseBlocksBefore !== null) {
    if (candidate.proseBlocksBefore === 0) {
      score += 12;
    } else if (candidate.proseBlocksBefore <= 2) {
      score += 6;
    } else if (candidate.proseBlocksBefore <= 4) {
      score -= 6;
    } else {
      score -= 18;
    }
  }

  if (candidate.sourceId === "article-header") {
    score += 12;
  }

  const longestSide = Math.max(candidate.width ?? 0, candidate.height ?? 0);
  const shortestSide = Math.min(
    candidate.width ?? Infinity,
    candidate.height ?? Infinity,
  );
  if (shortestSide !== Infinity) {
    if (shortestSide >= 900) {
      score += 18;
    } else if (shortestSide >= 500) {
      score += 12;
    } else if (shortestSide >= 240) {
      score += 4;
    }
  }
  if (longestSide > 0 && longestSide <= 180) {
    score -= 60;
  }
  if (
    candidate.width !== null &&
    candidate.height !== null &&
    Math.max(candidate.width, candidate.height) <= 240 &&
    Math.abs(candidate.width - candidate.height) <= 32
  ) {
    score -= 45;
  }

  if (candidate.alt && candidate.alt.length >= 16) {
    score += 5;
  }

  score += Math.min(
    8,
    scoreArticleTokenOverlap(candidate.url, context.articleTokens) * 2,
  );

  if (isLowValueCoverImageCandidate(candidate, context)) {
    score -= 120;
  }

  return score;
}

function coverImageSourceBaseScore(sourceId: string): number {
  switch (sourceId) {
    case "article-header":
      return 40;
    case "article-image":
      return 26;
    case "jsonld-image":
      return 42;
    case "jsonld-thumbnail":
      return 28;
    case "meta-og":
      return 34;
    case "meta-twitter":
      return 30;
    default:
      return 20;
  }
}

function isLowValueCoverImageCandidate(
  candidate: CoverImageCandidate,
  context: {
    siteName: string | null;
    author: string | null;
  },
): boolean {
  const combined = [
    candidate.url,
    candidate.alt,
    candidate.contextHint,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (LOW_VALUE_IMAGE_PATTERNS.some((pattern) => pattern.test(combined))) {
    return true;
  }

  const comparableAlt = comparableText(candidate.alt);
  const comparableAuthor = comparableText(context.author);
  const comparableSiteName = comparableText(context.siteName);
  if (
    comparableAlt &&
    (comparableAlt === comparableAuthor || comparableAlt === comparableSiteName)
  ) {
    return true;
  }

  return false;
}

function scoreArticleTokenOverlap(url: string, tokens: Set<string>): number {
  if (tokens.size === 0) {
    return 0;
  }

  const comparableUrl = comparableText(url);
  if (!comparableUrl) {
    return 0;
  }

  let matches = 0;
  for (const token of tokens) {
    if (token.length < 4) {
      continue;
    }
    if (comparableUrl.includes(token)) {
      matches += 1;
    }
  }

  return matches;
}

function collectContextHint(element: Element): string {
  const fragments: string[] = [];
  let current: Element | null = element;

  while (current && fragments.length < 4) {
    const tagName = current.tagName?.toLowerCase();
    const className = current.getAttribute("class");
    const id = current.getAttribute("id");
    fragments.push(
      [
        tagName,
        id ? `#${id}` : null,
        className ? `.${collapseWhitespace(className)}` : null,
      ]
        .filter(Boolean)
        .join(""),
    );
    current = current.parentElement as Element | null;
  }

  return fragments.join(" ");
}

function hasAncestorTag(element: Element, tagName: string): boolean {
  let current: Element | null = element.parentElement as Element | null;

  while (current) {
    if (current.tagName?.toLowerCase() === tagName) {
      return true;
    }
    current = current.parentElement as Element | null;
  }

  return false;
}

function metaContentMap(document: Document): Map<string, string> {
  const meta = new Map<string, string>();

  for (
    const tag of Array.from(document.querySelectorAll("meta")) as Element[]
  ) {
    const name = (
      tag.getAttribute("property") ??
        tag.getAttribute("name") ??
        tag.getAttribute("itemprop")
    )?.trim().toLowerCase();
    const content = trimOrNull(tag.getAttribute("content"));
    if (name && content && !meta.has(name)) {
      meta.set(name, content);
    }
  }

  return meta;
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

function selectPrimaryArticleJsonLd(
  objects: Record<string, unknown>[],
): Record<string, unknown> | null {
  const candidates = objects
    .filter((entry) =>
      normalizeJsonLdTypes(entry["@type"]).some((type) =>
        ARTICLE_JSON_LD_TYPES.has(type)
      )
    )
    .map((entry) => ({ entry, score: scoreArticleJsonLd(entry) }))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.entry ?? null;
}

function scoreArticleJsonLd(entry: Record<string, unknown>): number {
  let score = 0;

  if (stringValue(entry.headline) ?? stringValue(entry.name)) {
    score += 8;
  }
  if (stringValue(entry.datePublished) ?? stringValue(entry.dateCreated)) {
    score += 5;
  }
  if (entry.image ?? entry.thumbnailUrl) {
    score += 6;
  }
  if (stringValue(entry.articleBody) ?? stringValue(entry.description)) {
    score += 3;
  }

  return score;
}

function normalizeJsonLdTypes(value: unknown): string[] {
  return arrayValue(value)
    .concat(typeof value === "string" ? [value] : [])
    .map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : "")
    .filter(Boolean);
}

function normalizeImageUrl(
  baseUrl: string,
  value: string | null | undefined,
): string | null {
  const resolved = resolveUrl(baseUrl, value);
  if (!resolved) {
    return null;
  }

  try {
    const url = new URL(resolved);
    if (url.pathname === "/_next/image") {
      const nested = url.searchParams.get("url");
      if (nested) {
        return normalizeImageUrl(baseUrl, nested);
      }
    }

    return trimUrl(url.toString());
  } catch {
    return trimUrl(resolved);
  }
}

function resolveUrl(
  baseUrl: string,
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseSrcsetWidth(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d+)w$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseInteger(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function articleSlugFromUrl(url: string): string {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).join(" ");
  } catch {
    return url;
  }
}

function measureReadableText(element: Element): number {
  return collapseWhitespace(element.textContent ?? "").length;
}

function hasTruncationMarkers(value: string): boolean {
  return /(?:\[\.\.\.\]|\[...\]|\[…\]|\.{3}|…)$/.test(value.trim());
}

function tokenizeComparable(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  return collapseWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 4);
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

function trimOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = collapseWhitespace(value);
  return trimmed || null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
): number {
  return (left ?? -1) - (right ?? -1);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
