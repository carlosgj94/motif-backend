import type {
  ContentMetadata,
  Document,
  Element,
  ParsedBlock,
  ThreadMediaItem,
  ThreadPostBlock,
  XSyndicatedArticle,
  XSyndicatedPost,
} from "./model.ts";
import { extractThreadPosts, trimText, trimUrl } from "./normalize.ts";

export interface XContentSelection {
  sourceKind: "article" | "thread" | "post";
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  blocks: ParsedBlock[];
}

const X_TITLE_PATTERNS = [
  /^(.*?)\s+on\s+X:\s+"([\s\S]+)"$/i,
  /^(.*?)\s+on\s+Twitter:\s+"([\s\S]+)"$/i,
];
const LONG_FORM_POST_CHAR_THRESHOLD = 420;
const LONG_FORM_POST_PARAGRAPH_THRESHOLD = 2;

export function selectBestXContent(input: {
  document: Document;
  resolvedUrl: string;
  metadata: ContentMetadata;
  oEmbedPost?: ThreadPostBlock | null;
  syndicatedPost?: XSyndicatedPost | null;
}): XContentSelection | null {
  const markupPosts = extractThreadPosts(
    input.document,
    input.resolvedUrl,
    input.metadata,
  );
  const payloadPosts = extractXPostsFromPayloadScripts(
    input.document,
    input.resolvedUrl,
  );
  const remotePosts = buildRemoteXPosts({
    syndicatedPost: input.syndicatedPost ?? null,
    oEmbedPost: input.oEmbedPost ?? null,
  });
  const posts = mergeAndNormalizeXPosts({
    markupPosts,
    payloadPosts,
    remotePosts,
    resolvedUrl: input.resolvedUrl,
  });
  const hasStructuredLongFormPost = [...markupPosts, ...payloadPosts].some(
    isLongFormXPost,
  );

  if (posts.length === 0 && !input.syndicatedPost?.article) {
    return null;
  }

  const primaryPost = posts[0] ?? null;
  const syndicatedArticle = input.syndicatedPost?.article ?? null;
  const sourceKind = determineXSourceKind(
    posts,
    input.syndicatedPost ?? null,
    hasStructuredLongFormPost,
  );
  const articleBlocks = sourceKind === "article"
    ? buildXArticleBlocks({
      primaryPost,
      syndicatedArticle,
    })
    : null;
  const author = trimOrNull(
    primaryPost?.display_name ??
      input.syndicatedPost?.displayName ??
      formatHandle(primaryPost?.author_handle ?? input.syndicatedPost?.authorHandle),
  );
  const publishedAt = primaryPost?.published_at ??
    input.syndicatedPost?.publishedAt ??
    input.metadata.publishedAt;

  return {
    sourceKind,
    title: selectXTitle({
      syndicatedArticle,
      metadataTitle: input.metadata.title,
      primaryPost,
      sourceKind,
    }),
    excerpt: selectXExcerpt({
      syndicatedArticle,
      metadataDescription: input.metadata.description,
      primaryPost,
    }),
    author,
    publishedAt,
    coverImageUrl: selectXCoverImageUrl({
      syndicatedArticle,
      posts,
      metadataCoverImageUrl: input.metadata.coverImageUrl,
    }),
    blocks: articleBlocks ?? posts,
  };
}

function buildRemoteXPosts(input: {
  syndicatedPost: XSyndicatedPost | null;
  oEmbedPost: ThreadPostBlock | null;
}): ThreadPostBlock[] {
  const remotePosts: ThreadPostBlock[] = [];

  const fromSyndication = syndicatedPostToThreadPost(input.syndicatedPost);
  if (fromSyndication) {
    remotePosts.push(fromSyndication);
  }

  if (input.oEmbedPost && hasMeaningfulXText(input.oEmbedPost.text)) {
    remotePosts.push(input.oEmbedPost);
  }

  return remotePosts;
}

function extractXPostsFromPayloadScripts(
  document: Document,
  resolvedUrl: string,
): ThreadPostBlock[] {
  const posts: ThreadPostBlock[] = [];

  for (
    const script of Array.from(document.querySelectorAll("script")) as Element[]
  ) {
    const raw = script.textContent?.trim() ?? "";
    if (!raw || !looksLikeJsonPayload(raw)) {
      continue;
    }

    try {
      walkPayloadForPosts(JSON.parse(raw), posts, resolvedUrl, 0);
    } catch {
      continue;
    }
  }

  return dedupeThreadPosts(posts);
}

function walkPayloadForPosts(
  value: unknown,
  posts: ThreadPostBlock[],
  resolvedUrl: string,
  depth: number,
): void {
  if (depth > 24) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkPayloadForPosts(item, posts, resolvedUrl, depth + 1);
    }
    return;
  }

  const record = objectValue(value);
  if (!record) {
    return;
  }

  const post = xPostFromPayloadRecord(record, resolvedUrl);
  if (post) {
    posts.push(post);
  }

  for (const child of Object.values(record)) {
    walkPayloadForPosts(child, posts, resolvedUrl, depth + 1);
  }
}

function xPostFromPayloadRecord(
  record: Record<string, unknown>,
  resolvedUrl: string,
): ThreadPostBlock | null {
  const legacy = objectValue(record.legacy);
  const postId = trimOrNull(
    stringValue(record.rest_id) ??
      stringValue(record.id_str) ??
      stringValue(legacy?.id_str) ??
      extractPostId(resolvedUrl),
  );
  const noteTweetResult = objectValue(
    objectValue(objectValue(record.note_tweet)?.note_tweet_results)?.result,
  ) ??
    objectValue(
      objectValue(objectValue(record.noteTweet)?.noteTweetResults)?.result,
    );
  const noteText = stringValue(noteTweetResult?.text) ??
    stringValue(noteTweetResult?.richText) ??
    null;
  const fullText = stringValue(legacy?.full_text) ??
    stringValue(legacy?.fullText) ??
    stringValue(record.full_text) ??
    stringValue(record.fullText) ??
    null;
  const text = normalizeXPostText(noteText ?? fullText);
  if (!text || !postId) {
    return null;
  }

  const user = selectPayloadUser(record);
  const authorHandle = normalizeHandle(
    stringValue(user?.screen_name) ??
      stringValue(user?.screenName) ??
      stringValue(record.screen_name) ??
      null,
  ) ?? extractHandleFromUrl(resolvedUrl);
  const displayName = trimOrNull(
    stringValue(user?.name) ?? stringValue(record.name),
  );
  const publishedAt = parseDate(
    stringValue(legacy?.created_at) ??
      stringValue(legacy?.createdAt) ??
      stringValue(record.created_at) ??
      stringValue(record.createdAt) ??
      null,
  );

  return {
    type: "thread_post",
    post_id: postId,
    author_handle: authorHandle,
    display_name: displayName,
    published_at: publishedAt,
    text,
    media: extractPayloadMedia(record),
  };
}

function selectPayloadUser(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const candidates = [
    objectValue(objectValue(objectValue(record.core)?.user_results)?.result),
    objectValue(objectValue(objectValue(record.user_results)?.result)),
    objectValue(record.user),
    objectValue(record.author),
  ].filter((candidate): candidate is Record<string, unknown> =>
    candidate !== null
  );

  for (const candidate of candidates) {
    const legacy = objectValue(candidate.legacy);
    if (
      stringValue(legacy?.screen_name) || stringValue(legacy?.name) ||
      stringValue(candidate.screen_name) || stringValue(candidate.name)
    ) {
      return legacy ?? candidate;
    }
  }

  return null;
}

function extractPayloadMedia(
  record: Record<string, unknown>,
): ThreadMediaItem[] {
  const legacy = objectValue(record.legacy);
  const noteTweetResult = objectValue(
    objectValue(objectValue(record.note_tweet)?.note_tweet_results)?.result,
  );
  const mediaCandidates = [
    ...arrayValue(objectValue(legacy?.extended_entities)?.media),
    ...arrayValue(objectValue(legacy?.entities)?.media),
    ...arrayValue(objectValue(noteTweetResult?.entity_set)?.media),
  ];

  return mediaCandidates
    .map((candidate) => payloadMediaItem(candidate))
    .filter((candidate): candidate is ThreadMediaItem => candidate !== null);
}

function payloadMediaItem(candidate: unknown): ThreadMediaItem | null {
  const record = objectValue(candidate);
  if (!record) {
    return null;
  }

  const videoInfo = objectValue(record.video_info);
  const variants = arrayValue(videoInfo?.variants)
    .map((variant) => objectValue(variant))
    .filter((variant): variant is Record<string, unknown> => variant !== null);
  const videoUrl = variants
    .map((variant) => trimUrl(stringValue(variant.url)))
    .filter((url): url is string => url !== null)[0] ?? null;
  const imageUrl = trimUrl(
    stringValue(record.media_url_https) ??
      stringValue(record.media_url) ??
      stringValue(record.url),
  );
  const url = videoUrl ?? imageUrl;
  if (!url) {
    return null;
  }

  return {
    kind: videoUrl ? "video" : "image",
    url,
    alt: trimOrNull(
      stringValue(record.ext_alt_text) ??
        stringValue(record.alt_text) ??
        stringValue(record.description),
    ),
  };
}

function mergeAndNormalizeXPosts(input: {
  markupPosts: ThreadPostBlock[];
  payloadPosts: ThreadPostBlock[];
  remotePosts: ThreadPostBlock[];
  resolvedUrl: string;
}): ThreadPostBlock[] {
  const rootPostId = extractPostId(input.resolvedUrl);
  const merged = new Map<string, ThreadPostBlock>();

  for (const post of input.markupPosts) {
    merged.set(xPostKey(post), normalizeThreadPost(post));
  }

  for (const post of input.payloadPosts) {
    const normalized = normalizeThreadPost(post);
    const key = xPostKey(normalized);
    const existing = merged.get(key);
    if (!existing) {
      if (
        input.markupPosts.length === 0 ||
        normalized.post_id === rootPostId ||
        normalized.post_id === null
      ) {
        merged.set(key, normalized);
      }
      continue;
    }

    merged.set(key, chooseRicherPost(existing, normalized));
  }

  for (const post of input.remotePosts) {
    const normalized = normalizeThreadPost(post);
    const key = xPostKey(normalized);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, normalized);
      continue;
    }

    merged.set(key, chooseRicherPost(existing, normalized));
  }

  const posts = Array.from(merged.values());
  return sortXPosts(posts, rootPostId);
}

function normalizeThreadPost(post: ThreadPostBlock): ThreadPostBlock {
  return {
    ...post,
    author_handle: normalizeHandle(post.author_handle),
    display_name: trimOrNull(post.display_name),
    text: normalizeXPostText(post.text) ?? "",
    media: dedupeMedia(
      post.media.filter((item) =>
        trimUrl(item.url) !== null && !isAvatarMediaUrl(item.url)
      ),
    ),
  };
}

function chooseRicherPost(
  left: ThreadPostBlock,
  right: ThreadPostBlock,
): ThreadPostBlock {
  const preferredText = right.text.length > left.text.length
    ? right.text
    : left.text;
  const preferredMedia = right.media.length > left.media.length
    ? right.media
    : left.media;

  return {
    type: "thread_post",
    post_id: left.post_id ?? right.post_id,
    author_handle: right.author_handle ?? left.author_handle,
    display_name: right.display_name ?? left.display_name,
    published_at: right.published_at ?? left.published_at,
    text: preferredText,
    media: preferredMedia,
  };
}

function sortXPosts(
  posts: ThreadPostBlock[],
  rootPostId: string | null,
): ThreadPostBlock[] {
  return posts.slice().sort((left, right) => {
    if (left.post_id === rootPostId) {
      return -1;
    }
    if (right.post_id === rootPostId) {
      return 1;
    }

    if (
      left.published_at && right.published_at &&
      left.published_at !== right.published_at
    ) {
      return left.published_at.localeCompare(right.published_at);
    }

    return (left.post_id ?? "").localeCompare(right.post_id ?? "");
  });
}

function determineXSourceKind(
  posts: ThreadPostBlock[],
  syndicatedPost: XSyndicatedPost | null,
  hasStructuredLongFormPost: boolean,
): "article" | "thread" | "post" {
  if (posts.length > 1) {
    return "thread";
  }

  if (syndicatedPost?.article) {
    return "article";
  }

  if (syndicatedPost?.noteTweetId && !hasStructuredLongFormPost) {
    return "post";
  }

  if (hasStructuredLongFormPost) {
    return "article";
  }

  return posts[0] && isLongFormXPost(posts[0]) ? "article" : "post";
}

function isLongFormXPost(post: ThreadPostBlock): boolean {
  const paragraphs = splitXTextIntoParagraphs(post.text);
  return paragraphs.length >= LONG_FORM_POST_PARAGRAPH_THRESHOLD ||
    post.text.length >= LONG_FORM_POST_CHAR_THRESHOLD;
}

function buildXArticleBlocks(input: {
  primaryPost: ThreadPostBlock | null;
  syndicatedArticle: XSyndicatedArticle | null;
}): ParsedBlock[] {
  const syndicatedParagraphs = splitXTextIntoParagraphs(
    input.syndicatedArticle?.previewText ?? null,
  );
  if (syndicatedParagraphs.length > 0) {
    return syndicatedParagraphs.map((paragraph) => ({
      type: "paragraph" as const,
      text: paragraph,
    }));
  }

  if (!input.primaryPost) {
    return [];
  }

  return splitXTextIntoParagraphs(input.primaryPost.text)
    .map((paragraph) => ({ type: "paragraph" as const, text: paragraph }));
}

function splitXTextIntoParagraphs(text: string | null | undefined): string[] {
  const normalized = normalizeXPostText(text) ?? "";
  if (!normalized) {
    return [];
  }

  const blockParagraphs = normalized
    .split(/\n{2,}/)
    .map((segment) => collapseWhitespace(segment.replace(/\n/g, " ")))
    .filter(Boolean);
  if (blockParagraphs.length > 1) {
    return blockParagraphs;
  }

  const lineParagraphs = normalized
    .split("\n")
    .map((segment) => collapseWhitespace(segment))
    .filter(Boolean);
  return lineParagraphs.length > 1 ? lineParagraphs : [normalized];
}

function selectXTitle(input: {
  syndicatedArticle: XSyndicatedArticle | null;
  metadataTitle: string | null;
  primaryPost: ThreadPostBlock | null;
  sourceKind: "article" | "thread" | "post";
}): string | null {
  const syndicatedTitle = trimOrNull(input.syndicatedArticle?.title);
  if (syndicatedTitle) {
    return syndicatedTitle;
  }

  const cleanedMetadataTitle = cleanXMetadataTitle(input.metadataTitle);
  if (cleanedMetadataTitle) {
    return cleanedMetadataTitle;
  }

  const headingParagraph = selectXHeadingParagraphTitle(input.primaryPost);
  if (headingParagraph) {
    return headingParagraph;
  }

  if (input.sourceKind === "article" && input.primaryPost) {
    const paragraphs = splitXTextIntoParagraphs(input.primaryPost.text);
    const firstParagraph = paragraphs[0] ?? null;
    const sentenceTitle = firstSentence(firstParagraph);
    if (sentenceTitle) {
      return sentenceTitle;
    }
  }

  return clampSentence(input.primaryPost?.text ?? null, 120);
}

function selectXHeadingParagraphTitle(
  primaryPost: ThreadPostBlock | null,
): string | null {
  if (!primaryPost) {
    return null;
  }

  const paragraphs = splitXTextIntoParagraphs(primaryPost.text);
  const firstParagraph = paragraphs[0] ?? null;
  if (!isTitleLikeXParagraph(firstParagraph) || paragraphs.length < 2) {
    return null;
  }

  return trimOrNull(firstParagraph);
}

function selectXExcerpt(input: {
  syndicatedArticle: XSyndicatedArticle | null;
  metadataDescription: string | null;
  primaryPost: ThreadPostBlock | null;
}): string | null {
  const syndicatedPreview = summarizeText(
    input.syndicatedArticle?.previewText,
    280,
  );
  if (syndicatedPreview) {
    return syndicatedPreview;
  }

  const paragraphs = splitXTextIntoParagraphs(input.primaryPost?.text ?? null);
  const primaryExcerptSource = paragraphs.length > 1 &&
      isTitleLikeXParagraph(paragraphs[0] ?? null)
    ? paragraphs[1] ?? paragraphs[0]
    : paragraphs.length > 1
    ? paragraphs[0]
    : input.primaryPost?.text ?? null;
  const postSummary = summarizeText(primaryExcerptSource, 280);
  if (postSummary) {
    return postSummary;
  }

  return summarizeText(input.metadataDescription, 280);
}

function selectXCoverImageUrl(input: {
  syndicatedArticle: XSyndicatedArticle | null;
  posts: ThreadPostBlock[];
  metadataCoverImageUrl: string | null;
}): string | null {
  const syndicatedCover = trimUrl(input.syndicatedArticle?.coverImageUrl);
  if (syndicatedCover) {
    return syndicatedCover;
  }

  for (const post of input.posts) {
    const image = post.media.find((item) => item.kind === "image");
    if (image) {
      return trimUrl(image.url);
    }
  }

  return trimUrl(input.metadataCoverImageUrl);
}

function cleanXMetadataTitle(value: string | null): string | null {
  const title = trimOrNull(value);
  if (!title) {
    return null;
  }

  for (const pattern of X_TITLE_PATTERNS) {
    const match = title.match(pattern);
    if (!match) {
      continue;
    }

    return trimOrNull(match[2]);
  }

  if (/^\s*x\s*$/i.test(title)) {
    return null;
  }

  return title;
}

function normalizeXPostText(value: string | null | undefined): string | null {
  const raw = value?.replace(/\r\n?/g, "\n") ?? "";
  if (!raw.trim()) {
    return null;
  }

  const withoutTrailingTco = raw.replace(
    /(?:\s|\n)+(https?:\/\/t\.co\/[a-z0-9]+)(?=(?:\s|\n)*$)/gi,
    "",
  );
  const paragraphs = withoutTrailingTco
    .split(/\n{2,}/)
    .map((segment) =>
      segment
        .split("\n")
        .map((line) => collapseWhitespace(line))
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean);

  return paragraphs.join("\n\n") || null;
}

function isTitleLikeXParagraph(value: string | null | undefined): boolean {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return false;
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return trimmed.length <= 120 && wordCount <= 14;
}

function syndicatedPostToThreadPost(
  post: XSyndicatedPost | null,
): ThreadPostBlock | null {
  if (!post || !hasMeaningfulXText(post.text)) {
    return null;
  }

  return {
    type: "thread_post",
    post_id: post.postId,
    author_handle: post.authorHandle,
    display_name: post.displayName,
    published_at: post.publishedAt,
    text: post.text ?? "",
    media: post.media,
  };
}

function hasMeaningfulXText(value: string | null | undefined): boolean {
  const normalized = normalizeXPostText(value);
  return normalized !== null && !isBareXUrlText(normalized);
}

function isBareXUrlText(value: string): boolean {
  return /^https?:\/\/(?:t\.co|x\.com|twitter\.com)\//i.test(value.trim());
}

function summarizeText(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const truncated = trimmed.slice(0, maxChars).trimEnd();
  const sentenceBoundary = findLastSentenceBoundary(truncated);
  if (sentenceBoundary >= Math.floor(maxChars * 0.55)) {
    return truncated.slice(0, sentenceBoundary).trimEnd();
  }

  return truncated.replace(/\s+\S*$/, "").trimEnd() || truncated;
}

function clampSentence(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  return trimText(summarizeText(value, maxChars), maxChars);
}

function firstSentence(value: string | null | undefined): string | null {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return null;
  }

  const boundary = findLastSentenceBoundary(trimmed);
  if (boundary > 0 && boundary <= 160) {
    return trimmed.slice(0, boundary).trim();
  }

  return clampSentence(trimmed, 120);
}

function findLastSentenceBoundary(value: string): number {
  const matches = Array.from(value.matchAll(/[.?!]["')\]]?(?:\s|$)/g));
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) {
    return -1;
  }

  return last.index + last[0].trimEnd().length;
}

function dedupeMedia(media: ThreadMediaItem[]): ThreadMediaItem[] {
  const seen = new Set<string>();
  const deduped: ThreadMediaItem[] = [];

  for (const item of media) {
    const key = `${item.kind}:${item.url}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      kind: item.kind,
      url: item.url,
      alt: trimOrNull(item.alt),
    });
  }

  return deduped;
}

function dedupeThreadPosts(posts: ThreadPostBlock[]): ThreadPostBlock[] {
  const deduped = new Map<string, ThreadPostBlock>();

  for (const post of posts) {
    const key = xPostKey(post);
    const existing = deduped.get(key);
    deduped.set(key, existing ? chooseRicherPost(existing, post) : post);
  }

  return Array.from(deduped.values());
}

function xPostKey(post: ThreadPostBlock): string {
  return post.post_id ?? comparableText(post.text) ?? post.text;
}

function extractPostId(resolvedUrl: string): string | null {
  const match = resolvedUrl.match(/\/status\/(\d+)/i);
  return match?.[1] ?? null;
}

function extractHandleFromUrl(url: string): string | null {
  const match = url.match(
    /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\//i,
  );
  return match?.[1] ?? null;
}

function normalizeHandle(value: string | null | undefined): string | null {
  return trimOrNull(value)?.replace(/^@/, "") ?? null;
}

function formatHandle(value: string | null | undefined): string | null {
  const normalized = normalizeHandle(value);
  return normalized ? `@${normalized}` : null;
}

function parseDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isAvatarMediaUrl(url: string): boolean {
  return /profile_images|emoji|abs-0\.twimg\.com/i.test(url);
}

function looksLikeJsonPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
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

  const trimmed = value.trim();
  return trimmed || null;
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
