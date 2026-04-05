function safeEnvGet(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = safeEnvGet(name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OEMBED_BYTES = 128 * 1024;
const DEFAULT_FAVICON_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_PARSED_BLOCKS = 128;
const DEFAULT_MAX_TEXT_CHARS = 4000;
const DEFAULT_MAX_CODE_CHARS = 16_000;
const DEFAULT_MAX_LIST_ITEMS = 50;
const DEFAULT_MAX_LIST_ITEM_CHARS = 500;
const DEFAULT_MAX_PARSED_DOCUMENT_BYTES = 256 * 1024;
const DEFAULT_MAX_COMPACT_BODY_BYTES = 32 * 1024;
const DEFAULT_MAX_PARSER_DIAGNOSTICS_BYTES = 16 * 1024;
const DEFAULT_RENDERED_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_RENDERED_RESPONSE_BYTES = 3 * 1024 * 1024;

export const USER_AGENT = "motif-content-processor/0.1";
export const PARSER_VERSION = "1";
export const PARSED_DOCUMENT_VERSION = 1;

export const MAX_TITLE_CHARS = 512;
export const MAX_EXCERPT_CHARS = 1024;
export const MAX_AUTHOR_CHARS = 256;
export const MAX_SITE_NAME_CHARS = 256;
export const MAX_LANGUAGE_CODE_CHARS = 16;
export const MAX_URL_CHARS = 2048;
export const MAX_ERROR_MESSAGE_CHARS = 512;
export const MAX_THREAD_MEDIA_ITEMS = 8;
export const MAX_THREAD_HANDLE_CHARS = 64;
export const MAX_THREAD_DISPLAY_NAME_CHARS = 128;

export const trustedFetchHosts = new Set([
  "publish.twitter.com",
  "cdn.syndication.twimg.com",
]);
export const archiveMirrorHosts = [
  "archive.ph",
  "archive.md",
  "archive.today",
  "archive.is",
  "archive.fo",
  "archive.li",
  "archive.vn",
] as const;
export const archiveHosts: ReadonlySet<string> = new Set<string>(
  archiveMirrorHosts,
);
export const nonDiscoverableSourceHosts = new Set([
  "x.com",
  "twitter.com",
  "www.twitter.com",
  "www.x.com",
  "mobile.twitter.com",
  "reddit.com",
  "www.reddit.com",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "medium.com",
  "www.medium.com",
  "linkedin.com",
  "www.linkedin.com",
]);
export const noisyArticleTags = new Set([
  "aside",
  "button",
  "canvas",
  "dialog",
  "footer",
  "form",
  "input",
  "nav",
  "noscript",
  "script",
  "select",
  "style",
  "svg",
  "textarea",
]);

export const httpTimeoutMs = envNumber(
  "CONTENT_PROCESSING_HTTP_TIMEOUT_MS",
  DEFAULT_HTTP_TIMEOUT_MS,
);
export const maxRedirects = envNumber(
  "CONTENT_PROCESSING_MAX_REDIRECTS",
  DEFAULT_MAX_REDIRECTS,
);
export const maxHtmlBytes = envNumber(
  "CONTENT_PROCESSING_MAX_HTML_BYTES",
  DEFAULT_MAX_HTML_BYTES,
);
export const maxOEmbedBytes = envNumber(
  "CONTENT_PROCESSING_MAX_OEMBED_BYTES",
  DEFAULT_MAX_OEMBED_BYTES,
);
export const faviconMaxBytes = envNumber(
  "CONTENT_PROCESSING_FAVICON_MAX_BYTES",
  DEFAULT_FAVICON_MAX_BYTES,
);
export const maxParsedBlocks = envNumber(
  "CONTENT_PROCESSING_MAX_PARSED_BLOCKS",
  DEFAULT_MAX_PARSED_BLOCKS,
);
export const maxTextChars = envNumber(
  "CONTENT_PROCESSING_MAX_TEXT_CHARS",
  DEFAULT_MAX_TEXT_CHARS,
);
export const maxCodeChars = envNumber(
  "CONTENT_PROCESSING_MAX_CODE_CHARS",
  DEFAULT_MAX_CODE_CHARS,
);
export const maxListItems = envNumber(
  "CONTENT_PROCESSING_MAX_LIST_ITEMS",
  DEFAULT_MAX_LIST_ITEMS,
);
export const maxListItemChars = envNumber(
  "CONTENT_PROCESSING_MAX_LIST_ITEM_CHARS",
  DEFAULT_MAX_LIST_ITEM_CHARS,
);
export const maxParsedDocumentBytes = envNumber(
  "CONTENT_PROCESSING_MAX_PARSED_DOCUMENT_BYTES",
  DEFAULT_MAX_PARSED_DOCUMENT_BYTES,
);
export const maxCompactBodyBytes = envNumber(
  "CONTENT_PROCESSING_MAX_COMPACT_BODY_BYTES",
  DEFAULT_MAX_COMPACT_BODY_BYTES,
);
export const maxParserDiagnosticsBytes = envNumber(
  "CONTENT_PROCESSING_MAX_PARSER_DIAGNOSTICS_BYTES",
  DEFAULT_MAX_PARSER_DIAGNOSTICS_BYTES,
);
export const renderedFetchTimeoutMs = envNumber(
  "CONTENT_RENDERED_FETCH_TIMEOUT_MS",
  DEFAULT_RENDERED_FETCH_TIMEOUT_MS,
);
export const maxRenderedResponseBytes = envNumber(
  "CONTENT_RENDERED_RESPONSE_BYTES",
  DEFAULT_RENDERED_RESPONSE_BYTES,
);

export { envNumber, safeEnvGet };
