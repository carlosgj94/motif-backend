import type {
  ThreadMediaItem,
  XSyndicatedArticle,
  XSyndicatedPost,
} from "./model.ts";
import { trimUrl } from "./normalize.ts";

export function extractXStatusIdFromUrl(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/i);
  return match?.[1] ?? null;
}

export function xPostFromSyndicationPayload(
  payload: unknown,
  resolvedUrl: string,
): XSyndicatedPost | null {
  const record = objectValue(payload);
  if (!record) {
    return null;
  }

  const user = objectValue(record.user);
  const article = syndicatedArticleFromRecord(record);
  const postId = trimOrNull(
    stringValue(record.id_str) ??
      stringValue(record.id) ??
      extractXStatusIdFromUrl(resolvedUrl),
  );
  const text = trimOrNull(
    stringValue(record.full_text) ?? stringValue(record.text),
  );
  const publishedAt = parseDate(
    stringValue(record.created_at) ?? stringValue(record.createdAt),
  );
  const authorHandle = normalizeHandle(
    stringValue(user?.screen_name) ??
      stringValue(user?.screenName) ??
      extractHandleFromUrl(resolvedUrl),
  );
  const displayName = trimOrNull(stringValue(user?.name));
  const noteTweetId = trimOrNull(
    stringValue(objectValue(record.note_tweet)?.id) ??
      stringValue(objectValue(record.noteTweet)?.id),
  );
  const media = dedupeMedia([
    ...arrayValue(record.mediaDetails)
      .map((candidate) => syndicatedMediaItem(candidate))
      .filter((candidate): candidate is ThreadMediaItem => candidate !== null),
    ...arrayValue(record.photos)
      .map((candidate) => syndicatedMediaItem(candidate))
      .filter((candidate): candidate is ThreadMediaItem => candidate !== null),
  ]);

  if (!postId && !text && !article) {
    return null;
  }

  return {
    postId,
    authorHandle,
    displayName,
    publishedAt,
    text,
    media,
    noteTweetId,
    article,
  };
}

function syndicatedArticleFromRecord(
  record: Record<string, unknown>,
): XSyndicatedArticle | null {
  const article = objectValue(record.article);
  if (!article) {
    return null;
  }

  const entities = objectValue(record.entities);
  const articleUrl = arrayValue(entities?.urls)
    .map((candidate) => objectValue(candidate))
    .filter((candidate): candidate is Record<string, unknown> => candidate !== null)
    .map((candidate) =>
      trimUrl(
        stringValue(candidate.expanded_url) ??
          stringValue(candidate.expandedUrl) ??
          stringValue(candidate.url),
      )
    )
    .find((candidate) => candidate !== null && /\/i\/article\//i.test(candidate)) ??
    null;
  const coverMedia = objectValue(article.cover_media) ??
    objectValue(article.coverMedia);
  const mediaInfo = objectValue(coverMedia?.media_info) ??
    objectValue(coverMedia?.mediaInfo);

  return {
    articleId: trimOrNull(
      stringValue(article.rest_id) ?? stringValue(article.id),
    ),
    title: trimOrNull(stringValue(article.title)),
    previewText: trimOrNull(
      stringValue(article.preview_text) ?? stringValue(article.previewText),
    ),
    coverImageUrl: trimUrl(
      stringValue(mediaInfo?.original_img_url) ??
        stringValue(mediaInfo?.originalImgUrl) ??
        stringValue(coverMedia?.media_url_https) ??
        stringValue(coverMedia?.media_url) ??
        stringValue(coverMedia?.url),
    ),
    url: articleUrl?.replace(/^http:\/\//i, "https://") ?? null,
  };
}

function syndicatedMediaItem(candidate: unknown): ThreadMediaItem | null {
  const record = objectValue(candidate);
  if (!record) {
    return null;
  }

  const mediaInfo = objectValue(record.media_info) ?? objectValue(record.mediaInfo);
  const videoInfo = objectValue(record.video_info) ?? objectValue(record.videoInfo);
  const videoVariants = arrayValue(videoInfo?.variants)
    .map((variant) => objectValue(variant))
    .filter((variant): variant is Record<string, unknown> => variant !== null);
  const videoUrl = videoVariants
    .map((variant) => trimUrl(stringValue(variant.url)))
    .find((url) => url !== null) ?? null;
  const imageUrl = trimUrl(
    stringValue(record.media_url_https) ??
      stringValue(record.media_url) ??
      stringValue(record.url) ??
      stringValue(mediaInfo?.original_img_url) ??
      stringValue(mediaInfo?.originalImgUrl),
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

function extractHandleFromUrl(url: string): string | null {
  const match = url.match(
    /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\//i,
  );
  return match?.[1] ?? null;
}

function normalizeHandle(value: string | null | undefined): string | null {
  return trimOrNull(value)?.replace(/^@/, "") ?? null;
}

function parseDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

function trimOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}
