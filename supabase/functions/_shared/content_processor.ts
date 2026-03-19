import { createClient } from "npm:@supabase/supabase-js@2.58.0";
import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.12";

type Document = any;
type Element = any;

const USER_AGENT = "motif-content-processor/0.1";
const PROCESSOR_NAME = "motif-content-processor";
const PROCESSOR_VERSION = "1";
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
const DEFAULT_STALE_AFTER_SECONDS = 900;
const DEFAULT_MAX_RETRIES = 3;
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
const MAX_TITLE_CHARS = 512;
const MAX_EXCERPT_CHARS = 1024;
const MAX_AUTHOR_CHARS = 256;
const MAX_SITE_NAME_CHARS = 256;
const MAX_LANGUAGE_CODE_CHARS = 16;
const MAX_URL_CHARS = 2048;
const MAX_ERROR_MESSAGE_CHARS = 512;
const MAX_THREAD_MEDIA_ITEMS = 8;
const MAX_THREAD_HANDLE_CHARS = 64;
const MAX_THREAD_DISPLAY_NAME_CHARS = 128;
const RETRY_DELAYS_SECONDS = [60, 300, 1800];
const TRUSTED_FETCH_HOSTS = new Set(["publish.twitter.com"]);
const NOISY_ARTICLE_TAGS = new Set([
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

type ProcessingStage = "fetch" | "parse";
type SourceKind = "article" | "thread" | "post";

interface QueuePayload {
  content_id: string;
  trigger?: string;
  requested_at?: string;
  retry_count?: number;
}

interface QueueMessageRow {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: QueuePayload;
}

interface ClaimedContentRow {
  id: string;
  canonical_url: string;
  resolved_url: string | null;
  host: string;
  fetch_attempt_count: number;
  parse_attempt_count: number;
}

interface FaviconResult {
  byteaHex: string;
  mimeType: string;
  sourceUrl: string;
  fetchedAt: string;
}

interface ThreadMediaItem {
  kind: "image" | "video";
  url: string;
  alt: string | null;
}

interface ThreadPostBlock {
  type: "thread_post";
  post_id: string | null;
  author_handle: string | null;
  display_name: string | null;
  published_at: string | null;
  text: string;
  media: ThreadMediaItem[];
}

type ParsedBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; style: "bulleted" | "numbered"; items: string[] }
  | { type: "code"; language: string | null; text: string }
  | { type: "image"; url: string; alt: string | null; caption: string | null }
  | ThreadPostBlock;

interface ProcessedContent {
  resolvedUrl: string;
  host: string;
  siteName: string | null;
  sourceKind: SourceKind;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  languageCode: string | null;
  coverImageUrl: string | null;
  favicon: FaviconResult | null;
  parsedDocument: Record<string, unknown>;
  wordCount: number;
  estimatedReadSeconds: number;
  blockCount: number;
  imageCount: number;
  httpStatus: number;
  fetchedAt: string;
}

interface PartialContentUpdate {
  resolved_url?: string | null;
  host?: string | null;
  site_name?: string | null;
  source_kind?: SourceKind | null;
  title?: string | null;
  excerpt?: string | null;
  author?: string | null;
  published_at?: string | null;
  language_code?: string | null;
  cover_image_url?: string | null;
  favicon_bytes?: string | null;
  favicon_mime_type?: string | null;
  favicon_source_url?: string | null;
  favicon_fetched_at?: string | null;
  last_http_status?: number | null;
  last_successful_fetch_at?: string | null;
}

interface BatchResult {
  dequeued: number;
  processed: number;
  retried: number;
  failed: number;
  skipped: number;
  archived: number;
}

interface FetchDocumentResult {
  resolvedUrl: string;
  host: string;
  html: string;
  status: number;
  fetchedAt: string;
}

type DnsRecordType = "A" | "AAAA";
type ResolveDnsFn = (
  hostname: string,
  recordType: DnsRecordType,
) => Promise<string[]>;
type FetchImpl = typeof fetch;

interface NetworkPolicy {
  fetchImpl?: FetchImpl;
  resolveDns?: ResolveDnsFn;
}

let supabaseClient: ReturnType<typeof createClient<any>> | null = null;

function parseDocument(html: string): Document {
  return (parseHTML(html) as unknown as { document: Document }).document;
}

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

const batchSize = envNumber(
  "CONTENT_PROCESSING_BATCH_SIZE",
  DEFAULT_BATCH_SIZE,
);
const visibilityTimeoutSeconds = envNumber(
  "CONTENT_PROCESSING_VISIBILITY_TIMEOUT_SECONDS",
  DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
);
const staleAfterSeconds = envNumber(
  "CONTENT_PROCESSING_STALE_AFTER_SECONDS",
  DEFAULT_STALE_AFTER_SECONDS,
);
const maxRetries = envNumber(
  "CONTENT_PROCESSING_RETRY_LIMIT",
  DEFAULT_MAX_RETRIES,
);
const httpTimeoutMs = envNumber(
  "CONTENT_PROCESSING_HTTP_TIMEOUT_MS",
  DEFAULT_HTTP_TIMEOUT_MS,
);
const maxRedirects = envNumber(
  "CONTENT_PROCESSING_MAX_REDIRECTS",
  DEFAULT_MAX_REDIRECTS,
);
const maxHtmlBytes = envNumber(
  "CONTENT_PROCESSING_MAX_HTML_BYTES",
  DEFAULT_MAX_HTML_BYTES,
);
const maxOEmbedBytes = envNumber(
  "CONTENT_PROCESSING_MAX_OEMBED_BYTES",
  DEFAULT_MAX_OEMBED_BYTES,
);
const faviconMaxBytes = envNumber(
  "CONTENT_PROCESSING_FAVICON_MAX_BYTES",
  DEFAULT_FAVICON_MAX_BYTES,
);
const maxParsedBlocks = envNumber(
  "CONTENT_PROCESSING_MAX_PARSED_BLOCKS",
  DEFAULT_MAX_PARSED_BLOCKS,
);
const maxTextChars = envNumber(
  "CONTENT_PROCESSING_MAX_TEXT_CHARS",
  DEFAULT_MAX_TEXT_CHARS,
);
const maxCodeChars = envNumber(
  "CONTENT_PROCESSING_MAX_CODE_CHARS",
  DEFAULT_MAX_CODE_CHARS,
);
const maxListItems = envNumber(
  "CONTENT_PROCESSING_MAX_LIST_ITEMS",
  DEFAULT_MAX_LIST_ITEMS,
);
const maxListItemChars = envNumber(
  "CONTENT_PROCESSING_MAX_LIST_ITEM_CHARS",
  DEFAULT_MAX_LIST_ITEM_CHARS,
);
const maxParsedDocumentBytes = envNumber(
  "CONTENT_PROCESSING_MAX_PARSED_DOCUMENT_BYTES",
  DEFAULT_MAX_PARSED_DOCUMENT_BYTES,
);

function getSupabase(): ReturnType<typeof createClient<any>> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = safeEnvGet("SUPABASE_URL");
  const serviceRoleKey = safeEnvGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for content processing",
    );
  }

  supabaseClient = createClient<any>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseClient;
}

export function authorizeProcessorRequest(request: Request): Response | null {
  const expected = safeEnvGet("CONTENT_PROCESSOR_SECRET");
  if (!expected) {
    return jsonResponse(500, {
      error: "content_processor_secret_missing",
      message: "CONTENT_PROCESSOR_SECRET must be set for the content processor",
    });
  }

  const actual = request.headers.get("x-content-processor-secret");
  if (actual !== expected) {
    return jsonResponse(401, {
      error: "unauthorized",
      message: "The content processor secret is invalid",
    });
  }

  return null;
}

export async function processContentBatch(): Promise<BatchResult> {
  const supabase = getSupabase();
  const result: BatchResult = {
    dequeued: 0,
    processed: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    archived: 0,
  };

  const { data, error } = await supabase.rpc("dequeue_content_processing", {
    p_batch_size: batchSize,
    p_visibility_timeout_seconds: visibilityTimeoutSeconds,
  });

  if (error) {
    throw new Error(`Failed to read content queue: ${error.message}`);
  }

  const queueMessages = (data ?? []) as QueueMessageRow[];
  result.dequeued = queueMessages.length;

  for (const queueMessage of queueMessages) {
    try {
      await processQueueMessage(queueMessage, result);
    } catch (error) {
      result.failed += 1;
      console.error("content processing message failed unexpectedly", {
        msgId: queueMessage.msg_id,
        error,
      });
    }
  }

  return result;
}

async function processQueueMessage(
  queueMessage: QueueMessageRow,
  result: BatchResult,
): Promise<void> {
  const supabase = getSupabase();
  const contentId = queueMessage.message?.content_id;
  if (!contentId) {
    await archiveQueueMessage(queueMessage.msg_id);
    result.archived += 1;
    result.skipped += 1;
    return;
  }

  const { data: claimedRows, error: claimError } = await supabase.rpc(
    "claim_content_processing",
    {
      p_content_id: contentId,
      p_stale_after_seconds: staleAfterSeconds,
    },
  );

  if (claimError) {
    throw new Error(
      `Failed to claim content ${contentId}: ${claimError.message}`,
    );
  }

  const claimed = ((claimedRows ?? []) as ClaimedContentRow[])[0];
  if (!claimed) {
    await archiveQueueMessage(queueMessage.msg_id);
    result.archived += 1;
    result.skipped += 1;
    return;
  }

  const retryCount = normalizeRetryCount(queueMessage.message?.retry_count);

  try {
    const processed = await processClaimedContent(claimed);
    await persistSuccess(claimed.id, processed);
    result.processed += 1;
  } catch (error) {
    const failure = ProcessingFailure.fromUnknown(error);
    await persistFailure(claimed.id, failure);

    if (failure.retryable && retryCount < maxRetries) {
      const retryDelaySeconds = RETRY_DELAYS_SECONDS[
        Math.min(retryCount, RETRY_DELAYS_SECONDS.length - 1)
      ];
      await enqueueRetry(claimed.id, retryDelaySeconds, retryCount + 1);
      result.retried += 1;
    } else {
      result.failed += 1;
    }
  }

  await archiveQueueMessage(queueMessage.msg_id);
  result.archived += 1;
}

async function processClaimedContent(
  claimed: ClaimedContentRow,
): Promise<ProcessedContent> {
  const fetched = await fetchDocument(claimed.canonical_url);
  if (isXHost(fetched.host)) {
    return processXDocument(fetched);
  }

  return processArticleDocument(fetched);
}

export async function fetchDocument(
  url: string,
  policy: NetworkPolicy = {},
): Promise<FetchDocumentResult> {
  const { response, resolvedUrl } = await performValidatedFetch(url, {
    policy,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    maxRedirects,
  });

  if (!response.ok) {
    throw ProcessingFailure.fetch(
      `Source URL returned HTTP ${response.status}`,
      {
        httpStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("html")) {
    throw ProcessingFailure.fetch("Source URL did not return HTML content", {
      httpStatus: response.status,
      retryable: false,
    });
  }

  const html = await readResponseText(
    response,
    maxHtmlBytes,
    "Source HTML body",
  );
  const resolvedHost = safeHost(resolvedUrl);
  if (!resolvedHost) {
    throw ProcessingFailure.fetch("Resolved URL host was invalid", {
      httpStatus: response.status,
      retryable: false,
    });
  }

  return {
    resolvedUrl,
    host: resolvedHost,
    html,
    status: response.status,
    fetchedAt: new Date().toISOString(),
  };
}

export async function performValidatedFetch(
  initialUrl: string,
  input: {
    policy?: NetworkPolicy;
    accept?: string;
    headers?: Record<string, string>;
    maxRedirects: number;
    trustedHosts?: Set<string>;
  },
): Promise<{ response: Response; resolvedUrl: string }> {
  const fetchImpl = input.policy?.fetchImpl ?? fetch;
  const resolveDns = input.policy?.resolveDns ?? resolvePublicDns;
  let currentUrl = initialUrl;

  for (
    let redirectCount = 0;
    redirectCount <= input.maxRedirects;
    redirectCount += 1
  ) {
    const validated = await validateFetchTargetUrl(currentUrl, {
      resolveDns,
      trustedHosts: input.trustedHosts,
    });

    let response: Response;
    try {
      const headers = new Headers(input.headers ?? {});
      if (input.accept && !headers.has("accept")) {
        headers.set("accept", input.accept);
      }
      if (!headers.has("user-agent")) {
        headers.set("user-agent", USER_AGENT);
      }
      response = await fetchImpl(validated.url, {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(httpTimeoutMs),
      });
    } catch (error) {
      throw ProcessingFailure.fetch("Request to source URL failed", {
        retryable: true,
        cause: error,
      });
    }

    if (!isRedirectStatus(response.status)) {
      return { response, resolvedUrl: validated.url };
    }

    if (redirectCount === input.maxRedirects) {
      throw ProcessingFailure.fetch("Source URL redirected too many times", {
        httpStatus: response.status,
        retryable: false,
      });
    }

    const location = response.headers.get("location");
    const nextUrl = resolveUrl(validated.url, location);
    if (!nextUrl) {
      throw ProcessingFailure.fetch(
        "Source URL redirect location was invalid",
        {
          httpStatus: response.status,
          retryable: false,
        },
      );
    }

    currentUrl = nextUrl;
  }

  throw ProcessingFailure.fetch("Source URL redirected too many times", {
    retryable: false,
  });
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  bodyLabel: string,
): Promise<string> {
  const bytes = await readResponseBytes(response, maxBytes, bodyLabel);
  try {
    return new TextDecoder().decode(bytes);
  } catch (error) {
    throw ProcessingFailure.fetch(`${bodyLabel} could not be decoded`, {
      httpStatus: response.status,
      retryable: false,
      cause: error,
    });
  }
}

export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  bodyLabel: string,
): Promise<Uint8Array> {
  const contentLength = parseContentLength(
    response.headers.get("content-length"),
  );
  if (contentLength !== null && contentLength > maxBytes) {
    throw ProcessingFailure.fetch(`${bodyLabel} exceeded the size limit`, {
      httpStatus: response.status,
      retryable: false,
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw ProcessingFailure.fetch(`${bodyLabel} exceeded the size limit`, {
        httpStatus: response.status,
        retryable: false,
      });
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308;
}

async function processArticleDocument(
  fetched: FetchDocumentResult,
): Promise<ProcessedContent> {
  const sourceDocument = parseDocument(fetched.html);
  const metadata = collectMetadata(sourceDocument);
  const favicon = await fetchFavicon(sourceDocument, fetched.resolvedUrl);

  const readabilityDocument = parseDocument(fetched.html);
  const readable = new Readability(readabilityDocument).parse();
  let blocks = buildArticleBlocks(readable?.content ?? "", fetched.resolvedUrl);
  if (blocks.length === 0) {
    blocks = buildArticleBlocks(
      extractFallbackArticleHtml(sourceDocument),
      fetched.resolvedUrl,
    );
  }
  const title = trimText(
    readable?.title ?? metadata.title ?? null,
    MAX_TITLE_CHARS,
  );
  const author = trimText(
    readable?.byline ?? metadata.author ?? null,
    MAX_AUTHOR_CHARS,
  );
  const excerpt = trimText(
    metadata.description ?? summarizeBlocks(blocks),
    MAX_EXCERPT_CHARS,
  );
  const siteName = trimText(
    metadata.siteName ?? fetched.host,
    MAX_SITE_NAME_CHARS,
  );
  const languageCode = trimText(metadata.languageCode, MAX_LANGUAGE_CODE_CHARS);
  const coverImageUrl = trimUrl(metadata.coverImageUrl);
  const baseUpdate = buildBaseUpdate({
    fetched,
    metadata,
    favicon,
    sourceKind: "article",
    siteName,
    title,
    excerpt,
    author,
    publishedAt: metadata.publishedAt,
    languageCode,
    coverImageUrl,
  });

  if (blocks.length === 0) {
    throw ProcessingFailure.parse("Readable article body was empty", {
      httpStatus: fetched.status,
      retryable: false,
      partialUpdate: baseUpdate,
    });
  }

  blocks = sanitizeParsedBlocks(blocks);
  if (blocks.length === 0) {
    throw ProcessingFailure.parse(
      "Readable article body was empty after normalization",
      {
        httpStatus: fetched.status,
        retryable: false,
        partialUpdate: baseUpdate,
      },
    );
  }
  const parsedDocument = enforceParsedDocumentSizeLimit({
    version: 1,
    kind: "article",
    title,
    byline: author,
    published_at: metadata.publishedAt,
    language_code: languageCode,
    blocks,
  }, baseUpdate);
  const metrics = deriveParsedDocumentMetrics(parsedDocument);

  return {
    resolvedUrl: fetched.resolvedUrl,
    host: fetched.host,
    siteName,
    sourceKind: "article",
    title,
    excerpt,
    author,
    publishedAt: metadata.publishedAt,
    languageCode,
    coverImageUrl,
    favicon,
    parsedDocument,
    wordCount: metrics.wordCount,
    estimatedReadSeconds: metrics.estimatedReadSeconds,
    blockCount: metrics.blockCount,
    imageCount: metrics.imageCount,
    httpStatus: fetched.status,
    fetchedAt: fetched.fetchedAt,
  };
}

async function processXDocument(
  fetched: FetchDocumentResult,
): Promise<ProcessedContent> {
  const document = parseDocument(fetched.html);
  const metadata = collectMetadata(document);
  const favicon = await fetchFavicon(document, fetched.resolvedUrl);
  let posts = extractThreadPosts(document, fetched.resolvedUrl, metadata);
  if (posts.length === 0) {
    const fromOEmbed = await fetchXOEmbedPost(fetched.resolvedUrl);
    if (fromOEmbed) {
      posts = [fromOEmbed];
    }
  }

  const sourceKind: SourceKind = posts.length > 1 ? "thread" : "post";
  const title = trimText(
    metadata.title ?? posts[0]?.text?.slice(0, 120) ?? null,
    MAX_TITLE_CHARS,
  );
  const excerpt = trimText(
    metadata.description ?? posts[0]?.text ?? null,
    MAX_EXCERPT_CHARS,
  );
  const author = trimText(
    posts[0]?.display_name ?? posts[0]?.author_handle ?? null,
    MAX_AUTHOR_CHARS,
  );
  const publishedAt = posts[0]?.published_at ?? metadata.publishedAt;
  const languageCode = trimText(metadata.languageCode, MAX_LANGUAGE_CODE_CHARS);
  const coverImageUrl = trimUrl(metadata.coverImageUrl);
  const baseUpdate = buildBaseUpdate({
    fetched,
    metadata,
    favicon,
    sourceKind,
    siteName: "X",
    title,
    excerpt,
    author,
    publishedAt,
    languageCode,
    coverImageUrl,
  });

  if (posts.length === 0) {
    throw ProcessingFailure.parse(
      "Could not recover post or thread content from X",
      {
        httpStatus: fetched.status,
        retryable: false,
        partialUpdate: baseUpdate,
      },
    );
  }

  const sanitizedPosts = sanitizeParsedBlocks(posts);
  if (sanitizedPosts.length === 0) {
    throw ProcessingFailure.parse(
      "Recovered X content was empty after normalization",
      {
        httpStatus: fetched.status,
        retryable: false,
        partialUpdate: baseUpdate,
      },
    );
  }
  const parsedDocument = enforceParsedDocumentSizeLimit({
    version: 1,
    kind: sourceKind,
    title,
    byline: author,
    published_at: publishedAt,
    language_code: languageCode,
    blocks: sanitizedPosts,
  }, baseUpdate);
  const metrics = deriveParsedDocumentMetrics(parsedDocument);

  return {
    resolvedUrl: fetched.resolvedUrl,
    host: fetched.host,
    siteName: "X",
    sourceKind,
    title,
    excerpt,
    author,
    publishedAt,
    languageCode,
    coverImageUrl,
    favicon,
    parsedDocument,
    wordCount: metrics.wordCount,
    estimatedReadSeconds: metrics.estimatedReadSeconds,
    blockCount: metrics.blockCount,
    imageCount: metrics.imageCount,
    httpStatus: fetched.status,
    fetchedAt: fetched.fetchedAt,
  };
}

async function persistSuccess(
  contentId: string,
  processed: ProcessedContent,
): Promise<void> {
  const supabase = getSupabase();
  const payload = {
    resolved_url: trimUrl(processed.resolvedUrl),
    host: trimText(processed.host, MAX_SITE_NAME_CHARS),
    site_name: trimText(processed.siteName, MAX_SITE_NAME_CHARS),
    source_kind: processed.sourceKind,
    title: trimText(processed.title, MAX_TITLE_CHARS),
    excerpt: trimText(processed.excerpt, MAX_EXCERPT_CHARS),
    author: trimText(processed.author, MAX_AUTHOR_CHARS),
    published_at: processed.publishedAt,
    language_code: trimText(processed.languageCode, MAX_LANGUAGE_CODE_CHARS),
    cover_image_url: trimUrl(processed.coverImageUrl),
    favicon_bytes: processed.favicon?.byteaHex ?? null,
    favicon_mime_type: trimText(processed.favicon?.mimeType ?? null, 128),
    favicon_source_url: trimUrl(processed.favicon?.sourceUrl ?? null),
    favicon_fetched_at: processed.favicon?.fetchedAt ?? null,
    parsed_document: processed.parsedDocument,
    word_count: processed.wordCount,
    estimated_read_seconds: processed.estimatedReadSeconds,
    block_count: processed.blockCount,
    image_count: processed.imageCount,
    parsed_at: new Date().toISOString(),
    parser_name: PROCESSOR_NAME,
    parser_version: PROCESSOR_VERSION,
    fetch_status: "succeeded",
    parse_status: "succeeded",
    last_fetch_error: null,
    last_parse_error: null,
    last_http_status: processed.httpStatus,
    last_successful_fetch_at: processed.fetchedAt,
  };

  const { error } = await supabase.from("content").update(payload).eq(
    "id",
    contentId,
  );
  if (error) {
    throw new Error(
      `Failed to persist processed content ${contentId}: ${error.message}`,
    );
  }
}

async function persistFailure(
  contentId: string,
  failure: ProcessingFailure,
): Promise<void> {
  const supabase = getSupabase();
  const payload: Record<string, unknown> = {
    last_http_status: failure.httpStatus ?? null,
  };
  const failureMessage = trimText(failure.message, MAX_ERROR_MESSAGE_CHARS);

  if (failure.stage === "fetch") {
    Object.assign(payload, {
      fetch_status: "failed",
      parse_status: "failed",
      last_fetch_error: failureMessage,
      last_parse_error: failureMessage,
    });
  } else {
    Object.assign(payload, {
      fetch_status: "succeeded",
      parse_status: "failed",
      last_fetch_error: null,
      last_parse_error: failureMessage,
    });
  }

  if (failure.partialUpdate) {
    Object.assign(payload, failure.partialUpdate);
  }

  const { error } = await supabase.from("content").update(payload).eq(
    "id",
    contentId,
  );
  if (error) {
    throw new Error(
      `Failed to persist content failure ${contentId}: ${error.message}`,
    );
  }
}

async function enqueueRetry(
  contentId: string,
  delaySeconds: number,
  retryCount: number,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("enqueue_content_processing", {
    p_content_id: contentId,
    p_trigger: "retry",
    p_delay_seconds: delaySeconds,
    p_retry_count: retryCount,
  });

  if (error) {
    throw new Error(
      `Failed to enqueue retry for ${contentId}: ${error.message}`,
    );
  }
}

function normalizeRetryCount(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.trunc(value)
    : 0;
}

async function archiveQueueMessage(msgId: number): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("archive_content_processing", {
    p_msg_id: msgId,
  });

  if (error) {
    throw new Error(
      `Failed to archive queue message ${msgId}: ${error.message}`,
    );
  }
}

async function fetchFavicon(
  document: Document,
  resolvedUrl: string,
): Promise<FaviconResult | null> {
  for (const candidate of collectFaviconCandidates(document, resolvedUrl)) {
    try {
      const { response, resolvedUrl: fetchedUrl } = await performValidatedFetch(
        candidate,
        {
          maxRedirects,
        },
      );
      if (!response.ok) {
        continue;
      }

      const mimeType =
        response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!mimeType.startsWith("image/")) {
        continue;
      }

      const bytes = await readResponseBytes(
        response,
        faviconMaxBytes,
        "Favicon body",
      );
      if (bytes.byteLength === 0 || bytes.byteLength > faviconMaxBytes) {
        continue;
      }

      return {
        byteaHex: toByteaHex(bytes),
        mimeType,
        sourceUrl: fetchedUrl,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.warn("favicon fetch failed", { candidate, error });
    }
  }

  return null;
}

async function fetchXOEmbedPost(
  resolvedUrl: string,
): Promise<ThreadPostBlock | null> {
  const endpoint = new URL("https://publish.twitter.com/oembed");
  endpoint.searchParams.set("omit_script", "1");
  endpoint.searchParams.set("url", resolvedUrl);

  try {
    const { response } = await performValidatedFetch(endpoint.toString(), {
      accept: "application/json",
      maxRedirects,
      trustedHosts: TRUSTED_FETCH_HOSTS,
    });
    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ??
      "";
    if (!contentType.includes("json")) {
      throw ProcessingFailure.parse("X oEmbed did not return JSON content", {
        httpStatus: response.status,
        retryable: false,
      });
    }

    const payload = JSON.parse(
      await readResponseText(response, maxOEmbedBytes, "X oEmbed response"),
    );
    return xPostFromOEmbedPayload(payload, resolvedUrl);
  } catch (error) {
    if (error instanceof ProcessingFailure) {
      throw error;
    }
    console.warn("x oembed fetch failed", { resolvedUrl, error });
    return null;
  }
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

function appendBlocksFromElement(
  element: Element,
  blocks: ParsedBlock[],
  baseUrl: string,
): void {
  const tagName = element.tagName.toLowerCase();
  if (NOISY_ARTICLE_TAGS.has(tagName) || isHiddenElement(element)) {
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

export function extractThreadPosts(
  document: Document,
  resolvedUrl: string,
  metadata: ReturnType<typeof collectMetadata>,
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
  if (!fallbackText) {
    return [];
  }

  const resolved = new URL(resolvedUrl);
  const handleMatch = resolved.pathname.match(/^\/([^/]+)\/status\//i);
  const statusMatch = resolved.pathname.match(/status\/(\d+)/i);
  return [{
    type: "thread_post",
    post_id: statusMatch?.[1] ?? null,
    author_handle: handleMatch?.[1] ?? null,
    display_name: metadata.title?.split(" on X")[0]?.trim() ?? null,
    published_at: metadata.publishedAt,
    text: fallbackText,
    media: metadata.coverImageUrl
      ? [{ kind: "image", url: metadata.coverImageUrl, alt: null }]
      : [],
  }];
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

export function collectMetadata(document: Document) {
  const title =
    collapseWhitespace(document.querySelector("title")?.textContent ?? "") ||
    null;
  const timeDateTime =
    document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
  const meta = new Map<string, string>();
  for (
    const tag of Array.from(document.querySelectorAll("meta")) as Element[]
  ) {
    const name = (
      tag.getAttribute("property") ??
        tag.getAttribute("name") ??
        tag.getAttribute("itemprop")
    )?.trim().toLowerCase();
    const content = tag.getAttribute("content")?.trim();
    if (name && content && !meta.has(name)) {
      meta.set(name, content);
    }
  }

  const htmlLang = document.documentElement?.getAttribute("lang") ?? null;

  return {
    title: firstNonEmpty(
      meta.get("og:title"),
      meta.get("twitter:title"),
      title,
    ),
    description: firstNonEmpty(
      meta.get("description"),
      meta.get("og:description"),
      meta.get("twitter:description"),
    ),
    author: firstNonEmpty(
      meta.get("author"),
      meta.get("article:author"),
      meta.get("parsely-author"),
    ),
    publishedAt: parseIsoDate(
      firstNonEmpty(
        meta.get("article:published_time"),
        meta.get("og:article:published_time"),
        meta.get("parsely-pub-date"),
        meta.get("pubdate"),
        meta.get("date"),
        meta.get("dc.date"),
        timeDateTime,
      ),
    ),
    languageCode: normalizeLanguageCode(
      firstNonEmpty(meta.get("og:locale"), htmlLang),
    ),
    coverImageUrl: firstNonEmpty(
      meta.get("og:image"),
      meta.get("twitter:image"),
    ),
    siteName: firstNonEmpty(
      meta.get("og:site_name"),
      meta.get("application-name"),
    ),
  };
}

function buildBaseUpdate(input: {
  fetched: FetchDocumentResult;
  metadata: ReturnType<typeof collectMetadata>;
  favicon: FaviconResult | null;
  sourceKind: SourceKind;
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
    site_name: input.siteName,
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
    last_http_status: input.fetched.status,
    last_successful_fetch_at: input.fetched.fetchedAt,
  };
}

function trimText(
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

function trimUrl(value: string | null | undefined): string | null {
  const trimmed = trimText(value, MAX_URL_CHARS);
  return trimmed ? trimmed : null;
}

export function sanitizeParsedBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
  return blocks
    .slice(0, maxParsedBlocks)
    .map((block) => sanitizeParsedBlock(block))
    .filter((block): block is ParsedBlock => block !== null);
}

function deriveParsedDocumentMetrics(parsedDocument: Record<string, unknown>): {
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

function enforceParsedDocumentSizeLimit(
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
      NOISY_ARTICLE_TAGS.has(descendant.tagName.toLowerCase()) ||
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

  return normalized.slice(0, 16);
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

function summarizeBlocks(blocks: ParsedBlock[]): string | null {
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "quote") {
      return block.text.slice(0, 280);
    }

    if (block.type === "thread_post") {
      return block.text.slice(0, 280);
    }
  }

  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

interface ValidateFetchTargetOptions {
  resolveDns?: ResolveDnsFn;
  trustedHosts?: Set<string>;
}

export async function validateFetchTargetUrl(
  url: string,
  options: ValidateFetchTargetOptions = {},
): Promise<{ url: string; host: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw ProcessingFailure.fetch("Source URL was invalid", {
      retryable: false,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw ProcessingFailure.fetch("Source URL must use http or https", {
      retryable: false,
    });
  }

  if (parsed.username || parsed.password) {
    throw ProcessingFailure.fetch(
      "Source URL must not include username or password",
      {
        retryable: false,
      },
    );
  }

  const defaultPort = parsed.protocol === "http:" ? "80" : "443";
  if (parsed.port && parsed.port !== defaultPort) {
    throw ProcessingFailure.fetch("Source URL must use the default port", {
      retryable: false,
    });
  }

  parsed.hash = "";
  if (parsed.port === defaultPort) {
    parsed.port = "";
  }

  const host = normalizeHostValue(parsed.hostname);
  if (!host) {
    throw ProcessingFailure.fetch("Source URL must include a host", {
      retryable: false,
    });
  }

  if (
    options.trustedHosts && options.trustedHosts.size > 0 &&
    !options.trustedHosts.has(host)
  ) {
    throw ProcessingFailure.fetch("Source URL host is not allowed", {
      retryable: false,
    });
  }

  if (!options.trustedHosts?.has(host) && isDisallowedHostname(host)) {
    throw ProcessingFailure.fetch("Source URL host is not allowed", {
      retryable: false,
    });
  }

  if (isIpLiteral(host)) {
    if (!isPublicIpLiteral(host)) {
      throw ProcessingFailure.fetch(
        "Source URL host must resolve to a public address",
        {
          retryable: false,
        },
      );
    }

    return { url: parsed.toString(), host };
  }

  await validateResolvedHost(host, options.resolveDns ?? resolvePublicDns);
  return { url: parsed.toString(), host };
}

async function validateResolvedHost(
  host: string,
  resolveDns: ResolveDnsFn,
): Promise<void> {
  const resolvedAddresses = new Set<string>();

  for (const recordType of ["A", "AAAA"] as const) {
    try {
      const results = await resolveDns(host, recordType);
      for (const result of results) {
        resolvedAddresses.add(normalizeHostValue(result));
      }
    } catch (error) {
      if (isDnsNoDataError(error)) {
        continue;
      }

      throw ProcessingFailure.fetch("Source URL host could not be resolved", {
        retryable: true,
        cause: error,
      });
    }
  }

  if (resolvedAddresses.size === 0) {
    throw ProcessingFailure.fetch("Source URL host could not be resolved", {
      retryable: false,
    });
  }

  for (const address of resolvedAddresses) {
    if (!isPublicIpLiteral(address)) {
      throw ProcessingFailure.fetch(
        "Source URL host must resolve to a public address",
        {
          retryable: false,
        },
      );
    }
  }
}

async function resolvePublicDns(
  hostname: string,
  recordType: DnsRecordType,
): Promise<string[]> {
  return await Deno.resolveDns(hostname, recordType) as string[];
}

function isDnsNoDataError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();
  return message.includes("no data") ||
    message.includes("nodata") ||
    message.includes("not found") ||
    message.includes("nxdomain");
}

export function isDisallowedHostname(host: string): boolean {
  const normalized = normalizeHostValue(host);
  if (!normalized) {
    return true;
  }

  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  return !normalized.includes(".") && !isIpLiteral(normalized);
}

function normalizeHostValue(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

export function isPublicIpLiteral(host: string): boolean {
  const normalized = normalizeHostValue(host);
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isPublicIpv4(ipv4);
  }

  const ipv6 = parseIpv6(normalized);
  if (ipv6) {
    return isPublicIpv6(ipv6);
  }

  return false;
}

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return null;
  }

  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return parts;
}

function isPublicIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) {
    return false;
  }

  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }

  if (a === 169 && b === 254) {
    return false;
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }

  if (a === 192 && b === 168) {
    return false;
  }

  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return false;
  }

  if (a === 198 && (b === 18 || b === 19)) {
    return false;
  }

  if (a === 198 && b === 51 && c === 100) {
    return false;
  }

  if (a === 203 && b === 0 && c === 113) {
    return false;
  }

  if (a >= 224 || a >= 240) {
    return false;
  }

  return true;
}

function parseIpv6(host: string): number[] | null {
  let normalized = host.trim().toLowerCase();
  if (!normalized.includes(":")) {
    return null;
  }

  if (normalized.includes("%")) {
    return null;
  }

  let ipv4Tail: number[] | null = null;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) {
      return null;
    }

    ipv4Tail = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4Tail) {
      return null;
    }

    normalized = `${normalized.slice(0, lastColon)}:${
      ((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16)
    }:${((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16)}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":").filter(Boolean)
    : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(":").filter(Boolean)
    : [];
  const missing = 8 - (left.length + right.length);
  if ((doubleColonParts.length === 1 && left.length !== 8) || missing < 0) {
    return null;
  }

  const parts = [
    ...left,
    ...Array.from(
      { length: doubleColonParts.length === 2 ? missing : 0 },
      () => "0",
    ),
    ...right,
  ];
  if (parts.length !== 8) {
    return null;
  }

  const parsed = parts.map((part) => Number.parseInt(part, 16));
  if (
    parsed.some((part, index) =>
      !/^[0-9a-f]{1,4}$/i.test(parts[index]) || !Number.isInteger(part) ||
      part < 0 || part > 0xffff
    )
  ) {
    return null;
  }

  return parsed;
}

function isPublicIpv6(parts: number[]): boolean {
  const allZero = parts.every((part) => part === 0);
  if (allZero) {
    return false;
  }

  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) {
    return false;
  }

  if ((parts[0] & 0xfe00) === 0xfc00) {
    return false;
  }

  if ((parts[0] & 0xffc0) === 0xfe80) {
    return false;
  }

  if ((parts[0] & 0xff00) === 0xff00) {
    return false;
  }

  if (parts[0] === 0x2001 && parts[1] === 0x0db8) {
    return false;
  }

  if (parts[0] === 0x2001 && parts[1] === 0x0002 && parts[2] === 0x0000) {
    return false;
  }

  const isIpv4Mapped = parts[0] === 0 &&
    parts[1] === 0 &&
    parts[2] === 0 &&
    parts[3] === 0 &&
    parts[4] === 0 &&
    parts[5] === 0xffff;
  if (isIpv4Mapped) {
    const ipv4 = [
      parts[6] >> 8,
      parts[6] & 0xff,
      parts[7] >> 8,
      parts[7] & 0xff,
    ];
    return isPublicIpv4(ipv4);
  }

  return true;
}

function safeHost(url: string): string | null {
  try {
    return normalizeHostValue(new URL(url).hostname);
  } catch {
    return null;
  }
}

function isXHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  return normalized === "x.com" ||
    normalized === "twitter.com" ||
    normalized.endsWith(".x.com") ||
    normalized.endsWith(".twitter.com");
}

function toByteaHex(bytes: Uint8Array): string {
  let hex = "\\x";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

class ProcessingFailure extends Error {
  readonly stage: ProcessingStage;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly partialUpdate: PartialContentUpdate | null;

  private constructor(
    stage: ProcessingStage,
    message: string,
    options: {
      retryable: boolean;
      httpStatus?: number | null;
      partialUpdate?: PartialContentUpdate | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProcessingFailure";
    this.stage = stage;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus ?? null;
    this.partialUpdate = options.partialUpdate ?? null;
  }

  static fetch(
    message: string,
    options: {
      retryable: boolean;
      httpStatus?: number | null;
      cause?: unknown;
    },
  ): ProcessingFailure {
    return new ProcessingFailure("fetch", message, options);
  }

  static parse(
    message: string,
    options: {
      retryable: boolean;
      httpStatus?: number | null;
      partialUpdate?: PartialContentUpdate | null;
      cause?: unknown;
    },
  ): ProcessingFailure {
    return new ProcessingFailure("parse", message, options);
  }

  static fromUnknown(error: unknown): ProcessingFailure {
    if (error instanceof ProcessingFailure) {
      return error;
    }

    return new ProcessingFailure("fetch", "Content processing failed", {
      retryable: true,
      cause: error,
    });
  }
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function acceptedResponse(body: Record<string, unknown>): Response {
  return jsonResponse(202, body);
}
