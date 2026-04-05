import { archiveHosts } from "./config.ts";
import type { FetchDocumentResult } from "./model.ts";

export type ContentRouteId =
  | "text-document"
  | "generic-article"
  | "archive-snapshot"
  | "x-thread"
  | "live-blog"
  | "bloomberg-article"
  | "substack-article";

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function isArchiveHost(host: string): boolean {
  return archiveHosts.has(normalizeHost(host));
}

export function isXHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "x.com" ||
    normalized === "twitter.com" ||
    normalized.endsWith(".x.com") ||
    normalized.endsWith(".twitter.com");
}

export function isBloombergHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "bloomberg.com" ||
    normalized.endsWith(".bloomberg.com");
}

export function isSubstackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "substack.com" ||
    normalized.endsWith(".substack.com");
}

export function looksLikeSubstackHtml(html: string): boolean {
  const hasPreloads = /window\._preloads\s*=\s*JSON\.parse\(/i.test(html);
  const hasPostShell =
    /newsletter-post post|single-post-container|available-content/i
      .test(html);
  const hasSubstackAssets = /substackcdn\.com|substack\.com\/@/i.test(html);

  return (hasPreloads && hasPostShell) || (hasPostShell && hasSubstackAssets);
}

export function looksLikeLiveBlogHtml(html: string): boolean {
  return /["']liveblogposting["']/i.test(html) ||
    /\bid=["']liveblog-body["']/i.test(html) ||
    /"contentType"\s*:\s*"LiveBlog"/i.test(html) ||
    /["']tone\/minutebyminute["']/i.test(html);
}

export function normalizeMimeType(
  contentType: string | null | undefined,
): string | null {
  if (!contentType) {
    return null;
  }

  const trimmed = contentType.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  return trimmed.split(";", 1)[0]?.trim() || null;
}

export function isTextDocumentContentType(
  contentType: string | null | undefined,
): boolean {
  const mimeType = normalizeMimeType(contentType);
  return mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    mimeType === "text/x-markdown" ||
    mimeType === "application/markdown" ||
    mimeType === "application/x-markdown";
}

export function looksLikeTextDocumentUrl(
  url: string | null | undefined,
): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return /\.(md|markdown|txt|text|rst)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function detectContentRoute(
  fetched: Pick<FetchDocumentResult, "host" | "html"> & {
    contentType?: string | null;
    resolvedUrl?: string | null;
  },
): ContentRouteId {
  if (
    isTextDocumentContentType(fetched.contentType) ||
    (
      !normalizeMimeType(fetched.contentType) &&
      looksLikeTextDocumentUrl(fetched.resolvedUrl)
    )
  ) {
    return "text-document";
  }
  if (isXHost(fetched.host)) {
    return "x-thread";
  }
  if (isArchiveHost(fetched.host)) {
    return "archive-snapshot";
  }
  if (looksLikeLiveBlogHtml(fetched.html)) {
    return "live-blog";
  }
  if (isBloombergHost(fetched.host)) {
    return "bloomberg-article";
  }
  if (isSubstackHost(fetched.host) || looksLikeSubstackHtml(fetched.html)) {
    return "substack-article";
  }

  return "generic-article";
}
