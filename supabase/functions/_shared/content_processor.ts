import { createClient } from "npm:@supabase/supabase-js@2.58.0";

import {
  envNumber,
  faviconMaxBytes,
  MAX_AUTHOR_CHARS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_LANGUAGE_CODE_CHARS,
  MAX_SITE_NAME_CHARS,
  MAX_TITLE_CHARS,
  maxOEmbedBytes,
  maxRedirects,
  safeEnvGet,
  trustedFetchHosts,
} from "./content/config.ts";
import {
  fetchDocument,
  isDisallowedHostname,
  isPublicIpLiteral,
  performValidatedFetch,
  readResponseBytes,
  readResponseText,
  validateFetchTargetUrl,
} from "./content/fetch.ts";
import type {
  Document,
  FaviconResult,
  FetchDocumentResult,
  ParseFetchedDocumentOptions,
  ProcessedContent,
  ThreadPostBlock,
  XSyndicatedPost,
} from "./content/model.ts";
import { ProcessingFailure } from "./content/model.ts";
import {
  buildArticleBlocks,
  collectFaviconCandidates,
  collectMetadata,
  discoverArticleSourceUrl,
  extractArchiveSnapshot,
  extractFallbackArticleHtml,
  extractOriginalUrlFromLinkHeader,
  extractThreadPosts,
  sanitizeParsedBlocks,
  toByteaHex,
  trimText,
  trimUrl,
  xPostFromOEmbedPayload,
} from "./content/normalize.ts";
import {
  deriveParserQualityScore,
  prepareParserDiagnosticsForStorage,
} from "./content/diagnostics.ts";
import {
  deriveParserRecoveryDecision,
  prepareParserRecoveryForStorage,
} from "./content/recovery.ts";
import { parseFetchedDocumentWithRegistry } from "./content/registry.ts";
import {
  enqueueContentRecovery,
  invokeContentRecoveryProcessor,
} from "./content_recovery_processor.ts";
import {
  extractXStatusIdFromUrl,
  xPostFromSyndicationPayload,
} from "./content/x_syndication.ts";

export type {
  ArchiveSnapshot,
  ContentMetadata,
  Document,
  Element,
  FaviconResult,
  FetchDocumentResult,
  NetworkPolicy,
  ParsedBlock,
  ParseFetchedDocumentOptions,
  PartialContentUpdate,
  ProcessedContent,
  SourceKind,
  ThreadMediaItem,
  ThreadPostBlock,
  XSyndicatedArticle,
  XSyndicatedPost,
} from "./content/model.ts";
export { ProcessingFailure } from "./content/model.ts";
export {
  fetchDocument,
  isDisallowedHostname,
  isPublicIpLiteral,
  performValidatedFetch,
  readResponseBytes,
  readResponseText,
  validateFetchTargetUrl,
} from "./content/fetch.ts";
export {
  buildArticleBlocks,
  collectFaviconCandidates,
  collectMetadata,
  discoverArticleSourceUrl,
  extractArchiveSnapshot,
  extractFallbackArticleHtml,
  extractOriginalUrlFromLinkHeader,
  extractThreadPosts,
  sanitizeParsedBlocks,
  xPostFromOEmbedPayload,
} from "./content/normalize.ts";
export {
  extractXStatusIdFromUrl,
  xPostFromSyndicationPayload,
} from "./content/x_syndication.ts";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
const DEFAULT_STALE_AFTER_SECONDS = 900;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_DELAYS_SECONDS = [60, 300, 1800];

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
  fetch_etag?: string | null;
  fetch_last_modified?: string | null;
  has_parsed_document?: boolean;
  fetch_attempt_count: number;
  parse_attempt_count: number;
}

interface BatchResult {
  dequeued: number;
  processed: number;
  retried: number;
  failed: number;
  skipped: number;
  archived: number;
}

type ClaimedContentProcessingResult =
  | {
    kind: "parsed";
    fetched: FetchDocumentResult;
    processed: ProcessedContent;
  }
  | {
    kind: "not_modified";
    fetched: FetchDocumentResult;
  };

let supabaseClient: ReturnType<typeof createClient<any>> | null = null;

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

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function acceptedResponse(body: Record<string, unknown>): Response {
  return jsonResponse(202, body);
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
    const outcome = await processClaimedContent(claimed);
    if (outcome.kind === "not_modified") {
      await persistNotModified(claimed.id, outcome.fetched);
    } else {
      await persistSuccess(claimed.id, outcome.fetched, outcome.processed);
      await attemptSourceDiscoveryForProcessedContent(
        claimed.id,
        outcome.processed,
      );
    }
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
): Promise<ClaimedContentProcessingResult> {
  const fetchUrl = claimed.resolved_url ?? claimed.canonical_url;
  const fetched = await fetchDocument(
    fetchUrl,
    {},
    claimed.has_parsed_document
      ? {
        etag: claimed.fetch_etag ?? null,
        lastModified: claimed.fetch_last_modified ?? null,
      }
      : {},
  );
  if (fetched.notModified) {
    return {
      kind: "not_modified",
      fetched,
    };
  }

  return {
    kind: "parsed",
    fetched,
    processed: await parseFetchedDocument(fetched),
  };
}

export async function parseFetchedDocument(
  fetched: FetchDocumentResult,
  options: ParseFetchedDocumentOptions = {},
): Promise<ProcessedContent> {
  return await parseFetchedDocumentWithRegistry(fetched, {
    faviconFetcher: options.faviconFetcher ?? fetchFavicon,
    xOEmbedFetcher: options.xOEmbedFetcher ?? fetchXOEmbedPost,
    xSyndicationFetcher: options.xSyndicationFetcher ?? fetchXSyndicationPost,
  });
}

async function persistSuccess(
  contentId: string,
  fetched: FetchDocumentResult,
  processed: ProcessedContent,
): Promise<void> {
  const supabase = getSupabase();
  const parserRecovery = deriveParserRecoveryDecision(processed);
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
    fetch_etag: trimText(fetched.etag, 512),
    fetch_last_modified: trimText(fetched.lastModified, 512),
    parsed_document: processed.parsedDocument,
    word_count: processed.wordCount,
    estimated_read_seconds: processed.estimatedReadSeconds,
    block_count: processed.blockCount,
    image_count: processed.imageCount,
    parsed_at: new Date().toISOString(),
    parser_name: trimText(processed.parserName, MAX_SITE_NAME_CHARS),
    parser_version: trimText(processed.parserVersion, 64),
    parser_diagnostics: prepareParserDiagnosticsForStorage(
      processed.parserDiagnostics,
    ),
    parser_quality_score: deriveParserQualityScore(processed.parserDiagnostics),
    parser_recovery: prepareParserRecoveryForStorage(parserRecovery),
    parser_recovery_status: parserRecovery.shouldRecover ? "needed" : "none",
    parser_recovery_stage: "static",
    parser_recovery_requested_at: parserRecovery.shouldRecover
      ? new Date().toISOString()
      : null,
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

  if (parserRecovery.shouldRecover) {
    try {
      await enqueueContentRecovery(contentId, "save");
      await invokeContentRecoveryProcessor({
        content_id: contentId,
        trigger: "save",
      });
    } catch (error) {
      console.warn("failed to enqueue content recovery", {
        contentId,
        error,
      });
    }
  }
}

async function persistNotModified(
  contentId: string,
  fetched: FetchDocumentResult,
): Promise<void> {
  const supabase = getSupabase();
  const payload: Record<string, unknown> = {
    resolved_url: trimUrl(fetched.resolvedUrl),
    host: trimText(fetched.host, MAX_SITE_NAME_CHARS),
    fetch_status: "succeeded",
    parse_status: "succeeded",
    last_fetch_error: null,
    last_parse_error: null,
    last_http_status: fetched.status,
    last_successful_fetch_at: fetched.fetchedAt,
  };

  if (fetched.etag) {
    payload.fetch_etag = trimText(fetched.etag, 512);
  }
  if (fetched.lastModified) {
    payload.fetch_last_modified = trimText(fetched.lastModified, 512);
  }

  const { error } = await supabase.from("content").update(payload).eq(
    "id",
    contentId,
  );
  if (error) {
    throw new Error(
      `Failed to persist content 304 refresh ${contentId}: ${error.message}`,
    );
  }
}

async function attemptSourceDiscoveryForProcessedContent(
  contentId: string,
  processed: ProcessedContent,
): Promise<void> {
  if (processed.sourceKind !== "article") {
    return;
  }

  const candidateUrl = processed.sourceDiscoveryUrl;
  if (!candidateUrl) {
    return;
  }

  try {
    const supabase = getSupabase();
    const { data: currentContent, error: currentContentError } = await supabase
      .from("content")
      .select("source_id")
      .eq("id", contentId)
      .maybeSingle();
    if (currentContentError) {
      throw new Error(
        `Failed to load content source link for ${contentId}: ${currentContentError.message}`,
      );
    }
    if ((currentContent as { source_id?: string | null } | null)?.source_id) {
      return;
    }

    const validated = await validateFetchTargetUrl(candidateUrl);
    const now = new Date().toISOString();
    const { data: sourceRow, error: sourceError } = await supabase
      .from("content_sources")
      .upsert(
        {
          source_url: validated.url,
          host: validated.host,
          updated_at: now,
        },
        { onConflict: "source_url" },
      )
      .select("id")
      .single();
    if (sourceError) {
      throw new Error(
        `Failed to upsert discovered source for ${contentId}: ${sourceError.message}`,
      );
    }

    const sourceId = (sourceRow as { id: string }).id;
    const { error: linkError } = await supabase
      .from("content")
      .update({
        source_id: sourceId,
        updated_at: now,
      })
      .eq("id", contentId)
      .is("source_id", null);
    if (linkError) {
      throw new Error(
        `Failed to link content ${contentId} to discovered source ${sourceId}: ${linkError.message}`,
      );
    }

    const { error: enqueueError } = await supabase.rpc(
      "enqueue_source_refresh",
      {
        p_source_id: sourceId,
        p_trigger: "save",
        p_delay_seconds: 0,
        p_retry_count: 0,
      },
    );
    if (enqueueError) {
      throw new Error(
        `Failed to enqueue source refresh for ${sourceId}: ${enqueueError.message}`,
      );
    }

    const { data: invokeJobId, error: invokeError } = await supabase.rpc(
      "invoke_source_processor",
      {
        p_payload: {
          source_id: sourceId,
          trigger: "save",
        },
      },
    );
    if (invokeError) {
      throw new Error(
        `Failed to invoke source processor for ${sourceId}: ${invokeError.message}`,
      );
    }
    if (invokeJobId === null) {
      console.warn(
        "source processor invoke skipped because required Vault secrets are missing",
        {
          contentId,
          sourceId,
          trigger: "save",
        },
      );
    }
  } catch (error) {
    console.warn("processed content source discovery failed", {
      contentId,
      candidateUrl,
      error,
    });
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
      trustedHosts: trustedFetchHosts,
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

async function fetchXSyndicationPost(
  resolvedUrl: string,
): Promise<XSyndicatedPost | null> {
  const postId = extractXStatusIdFromUrl(resolvedUrl);
  if (!postId) {
    return null;
  }

  const endpoint = new URL("https://cdn.syndication.twimg.com/tweet-result");
  endpoint.searchParams.set("id", postId);
  endpoint.searchParams.set("token", "x");

  try {
    const { response } = await performValidatedFetch(endpoint.toString(), {
      accept: "application/json",
      maxRedirects,
      trustedHosts: trustedFetchHosts,
    });
    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ??
      "";
    if (!contentType.includes("json")) {
      throw ProcessingFailure.parse(
        "X syndication did not return JSON content",
        {
          httpStatus: response.status,
          retryable: false,
        },
      );
    }

    const payload = JSON.parse(
      await readResponseText(
        response,
        maxOEmbedBytes,
        "X syndication response",
      ),
    );
    return xPostFromSyndicationPayload(payload, resolvedUrl);
  } catch (error) {
    if (error instanceof ProcessingFailure) {
      throw error;
    }
    console.warn("x syndication fetch failed", { resolvedUrl, error });
    return null;
  }
}
