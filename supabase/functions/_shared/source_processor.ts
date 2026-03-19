import { createClient } from "npm:@supabase/supabase-js@2.58.0";
import { DOMParser, parseHTML } from "npm:linkedom@0.18.12";

import {
  performValidatedFetch,
  readResponseBytes,
} from "./content_processor.ts";

type Document = any;
type Element = any;

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
const DEFAULT_STALE_AFTER_SECONDS = 900;
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_MAX_DISCOVERY_BYTES = 1024 * 1024;
const DEFAULT_MAX_FEED_BYTES = 1024 * 1024;
const DEFAULT_MAX_DISCOVERY_CANDIDATES = 8;
const DEFAULT_BACKFILL_LIMIT = 30;
const DEFAULT_MAX_FEED_ENTRIES = 100;
const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_NO_FEED_RETRY_SECONDS = 6 * 3600;
const MAX_SOURCE_TITLE_CHARS = 256;
const MAX_SOURCE_DESCRIPTION_CHARS = 1024;
const MAX_ENTRY_TITLE_CHARS = 512;
const MAX_ENTRY_EXCERPT_CHARS = 1024;
const MAX_ENTRY_AUTHOR_CHARS = 256;
const MAX_URL_CHARS = 2048;
const MAX_ERROR_MESSAGE_CHARS = 512;
const RETRY_DELAYS_SECONDS = [60, 300, 1800];
const TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref_src",
]);
const TRACKING_QUERY_PREFIXES = ["utm_"];
const COMMON_FEED_PATHS = [
  "/feed",
  "/feed.xml",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
];
const DISCOVERY_ACCEPT =
  "application/atom+xml,application/rss+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8";
const FEED_ACCEPT =
  "application/atom+xml,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8";

interface QueuePayload {
  source_id: string;
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

interface ClaimedSourceRow {
  id: string;
  source_url: string;
  resolved_source_url: string | null;
  host: string;
  refresh_status: string;
  refresh_attempt_count: number;
}

interface SourceFeedRow {
  id: string;
  source_id: string;
  feed_url: string;
  feed_kind: string;
  discovery_method: string;
  is_primary: boolean;
  title: string | null;
  etag: string | null;
  last_modified: string | null;
  refresh_status: string;
  last_refreshed_at: string | null;
  next_refresh_at: string | null;
}

interface SourceSubscriptionRow {
  id: string;
  user_id: string;
  last_backfilled_at: string | null;
}

interface SourceContext {
  sourceId: string;
  sourceUrl: string;
  resolvedSourceUrl: string | null;
  host: string;
  primaryFeed: SourceFeedRow | null;
  subscriptions: SourceSubscriptionRow[];
}

interface FetchTextResult {
  resolvedUrl: string;
  status: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
  text: string;
}

type FeedKind = "rss" | "atom";
type DiscoveryMethod = "provided" | "html_link" | "common_path";

interface ParsedFeedEntry {
  entryKey: string;
  entryGuid: string | null;
  entryUrl: string;
  canonicalUrl: string;
  host: string;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: string | null;
  rawPayload: Record<string, unknown>;
}

interface ParsedFeed {
  kind: FeedKind;
  title: string | null;
  description: string | null;
  siteUrl: string | null;
  entries: ParsedFeedEntry[];
}

interface FeedDiscoveryResult {
  kind: "feed";
  feedUrl: string;
  discoveryMethod: DiscoveryMethod;
  fetched: FetchTextResult;
  parsedFeed: ParsedFeed;
}

interface FeedNotModifiedResult {
  kind: "not_modified";
  feedUrl: string;
  discoveryMethod: DiscoveryMethod;
  fetched: FetchTextResult;
}

type FeedResolutionResult = FeedDiscoveryResult | FeedNotModifiedResult;

interface ContentRow {
  id: string;
  canonical_url: string;
  source_id: string | null;
  fetch_status: string;
  parse_status: string;
  parsed_document: Record<string, unknown> | null;
}

interface FeedEntryRecord {
  contentId: string;
  entryKey: string;
  publishedAt: string | null;
  deliveredAt: string;
}

interface RefreshSuccess {
  deliveredCount: number;
  enqueuedContentCount: number;
  discoveredFeed: boolean;
}

interface BatchResult {
  dequeued: number;
  processed: number;
  retried: number;
  failed: number;
  skipped: number;
  archived: number;
  delivered: number;
  enqueued_content: number;
  discovered_feeds: number;
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

const batchSize = envNumber("SOURCE_REFRESH_BATCH_SIZE", DEFAULT_BATCH_SIZE);
const visibilityTimeoutSeconds = envNumber(
  "SOURCE_REFRESH_VISIBILITY_TIMEOUT_SECONDS",
  DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
);
const staleAfterSeconds = envNumber(
  "SOURCE_REFRESH_STALE_AFTER_SECONDS",
  DEFAULT_STALE_AFTER_SECONDS,
);
const retryLimit = envNumber("SOURCE_REFRESH_RETRY_LIMIT", DEFAULT_RETRY_LIMIT);
const maxDiscoveryBytes = envNumber(
  "SOURCE_REFRESH_MAX_DISCOVERY_BYTES",
  DEFAULT_MAX_DISCOVERY_BYTES,
);
const maxFeedBytes = envNumber(
  "SOURCE_REFRESH_MAX_FEED_BYTES",
  DEFAULT_MAX_FEED_BYTES,
);
const maxDiscoveryCandidates = envNumber(
  "SOURCE_REFRESH_MAX_DISCOVERY_CANDIDATES",
  DEFAULT_MAX_DISCOVERY_CANDIDATES,
);
const backfillLimit = envNumber(
  "SOURCE_REFRESH_BACKFILL_LIMIT",
  DEFAULT_BACKFILL_LIMIT,
);
const maxFeedEntries = envNumber(
  "SOURCE_REFRESH_MAX_FEED_ENTRIES",
  DEFAULT_MAX_FEED_ENTRIES,
);
const refreshIntervalSeconds = envNumber(
  "SOURCE_REFRESH_INTERVAL_SECONDS",
  DEFAULT_REFRESH_INTERVAL_SECONDS,
);
const noFeedRetrySeconds = envNumber(
  "SOURCE_REFRESH_NO_FEED_RETRY_SECONDS",
  DEFAULT_NO_FEED_RETRY_SECONDS,
);

function getSupabase(): ReturnType<typeof createClient<any>> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = safeEnvGet("SUPABASE_URL");
  const serviceRoleKey = safeEnvGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for source refresh",
    );
  }

  supabaseClient = createClient<any>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseClient;
}

export async function processSourceBatch(): Promise<BatchResult> {
  const supabase = getSupabase();
  const result: BatchResult = {
    dequeued: 0,
    processed: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    archived: 0,
    delivered: 0,
    enqueued_content: 0,
    discovered_feeds: 0,
  };

  const { error: enqueueDueError } = await supabase.rpc(
    "enqueue_due_source_refreshes",
    { p_limit: Math.max(batchSize * 5, 10) },
  );
  if (enqueueDueError) {
    throw new Error(
      `Failed to enqueue due source refreshes: ${enqueueDueError.message}`,
    );
  }

  const { data, error } = await supabase.rpc("dequeue_source_refresh", {
    p_batch_size: batchSize,
    p_visibility_timeout_seconds: visibilityTimeoutSeconds,
  });

  if (error) {
    throw new Error(`Failed to read source refresh queue: ${error.message}`);
  }

  const queueMessages = (data ?? []) as QueueMessageRow[];
  result.dequeued = queueMessages.length;

  for (const queueMessage of queueMessages) {
    try {
      await processQueueMessage(queueMessage, result);
    } catch (error) {
      result.failed += 1;
      console.error("source refresh message failed unexpectedly", {
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
  const sourceId = queueMessage.message?.source_id;
  if (!sourceId) {
    await archiveQueueMessage(queueMessage.msg_id);
    result.archived += 1;
    result.skipped += 1;
    return;
  }

  const { data: claimedRows, error: claimError } = await supabase.rpc(
    "claim_source_refresh",
    {
      p_source_id: sourceId,
      p_stale_after_seconds: staleAfterSeconds,
    },
  );

  if (claimError) {
    throw new Error(
      `Failed to claim source ${sourceId}: ${claimError.message}`,
    );
  }

  const claimed = ((claimedRows ?? []) as ClaimedSourceRow[])[0];
  if (!claimed) {
    await archiveQueueMessage(queueMessage.msg_id);
    result.archived += 1;
    result.skipped += 1;
    return;
  }

  const retryCount = normalizeRetryCount(queueMessage.message?.retry_count);

  try {
    const success = await refreshClaimedSource(claimed);
    result.processed += 1;
    result.delivered += success.deliveredCount;
    result.enqueued_content += success.enqueuedContentCount;
    if (success.discoveredFeed) {
      result.discovered_feeds += 1;
    }
  } catch (error) {
    const failure = RefreshFailure.fromUnknown(error);
    await persistSourceFailure(claimed.id, failure);

    if (failure.retryable && retryCount < retryLimit) {
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

async function refreshClaimedSource(
  claimed: ClaimedSourceRow,
): Promise<RefreshSuccess> {
  const source = await loadSourceContext(claimed.id);
  let feedRow = source.primaryFeed;

  try {
    const resolution = await resolveFeedForSource(source);
    if (resolution.kind === "not_modified") {
      const now = new Date().toISOString();
      if (!feedRow) {
        throw new Error(`Source ${source.sourceId} returned 304 without a feed row`);
      }

      await persistSourceNotModified(source, resolution, now);
      await persistFeedNotModified(feedRow.id, resolution, now);

      return {
        deliveredCount: 0,
        enqueuedContentCount: 0,
        discoveredFeed: false,
      };
    }

    feedRow = await ensurePrimaryFeed(
      source.sourceId,
      resolution.feedUrl,
      resolution.discoveryMethod,
    );

    const now = new Date().toISOString();
    const deliveredCount = await syncFeedEntries({
      source,
      feedRow,
      feedResolution: resolution,
    });

    await persistSourceSuccess(source, resolution, now);
    await persistFeedSuccess(feedRow.id, resolution, now);

    const contentIds = resolution.parsedFeed.entries
      .map((entry) => entry.canonicalUrl)
      .filter((value, index, values) => values.indexOf(value) === index);
    const enqueuedContentCount = await enqueueContentProcessingForUrls(
      contentIds,
    );
    if (enqueuedContentCount > 0) {
      await invokeContentProcessor(source.sourceId);
    }

    return {
      deliveredCount,
      enqueuedContentCount,
      discoveredFeed: source.primaryFeed?.feed_url.toLowerCase() !==
        resolution.feedUrl.toLowerCase(),
    };
  } catch (error) {
    const failure = RefreshFailure.fromUnknown(error);
    if (feedRow && !failure.noFeed) {
      await persistFeedFailure(feedRow.id, failure);
    }
    throw failure;
  }
}

async function resolveFeedForSource(
  source: SourceContext,
): Promise<FeedResolutionResult> {
  if (source.primaryFeed) {
    const fetched = await fetchFeed(source.primaryFeed.feed_url, {
      etag: source.primaryFeed.etag,
      lastModified: source.primaryFeed.last_modified,
    });
    if (fetched.notModified) {
      return {
        kind: "not_modified",
        feedUrl: fetched.resolvedUrl,
        discoveryMethod: parseDiscoveryMethod(
          source.primaryFeed.discovery_method,
        ),
        fetched,
      };
    }

    const parsedFeed = parseFeedDocument(fetched.text, fetched.resolvedUrl);
    if (!parsedFeed) {
      throw RefreshFailure.feed(
        "Primary feed did not contain a valid RSS or Atom feed",
        {
          httpStatus: fetched.status,
          retryable: false,
        },
      );
    }

    return {
      kind: "feed",
      feedUrl: fetched.resolvedUrl,
      discoveryMethod: parseDiscoveryMethod(
        source.primaryFeed.discovery_method,
      ),
      fetched,
      parsedFeed,
    };
  }

  return discoverFeedForSource(source.sourceUrl);
}

async function discoverFeedForSource(
  sourceUrl: string,
): Promise<FeedDiscoveryResult> {
  const initial = await fetchTextResource(sourceUrl, {
    accept: DISCOVERY_ACCEPT,
    maxBytes: maxDiscoveryBytes,
    bodyLabel: "Source discovery response",
  });

  const directFeed = parseFeedDocument(initial.text, initial.resolvedUrl);
  if (directFeed) {
    return {
      kind: "feed",
      feedUrl: initial.resolvedUrl,
      discoveryMethod: "provided",
      fetched: initial,
      parsedFeed: directFeed,
    };
  }

  const candidates = discoverFeedCandidates(initial.text, initial.resolvedUrl)
    .filter((candidate) =>
      candidate.toLowerCase() !== initial.resolvedUrl.toLowerCase()
    )
    .slice(0, maxDiscoveryCandidates);
  let firstRetryableFailure: RefreshFailure | null = null;

  for (const candidate of candidates) {
    try {
      const fetched = await fetchFeed(candidate);
      const parsedFeed = parseFeedDocument(fetched.text, fetched.resolvedUrl);
      if (!parsedFeed) {
        continue;
      }

      return {
        kind: "feed",
        feedUrl: fetched.resolvedUrl,
        discoveryMethod: classifyDiscoveryMethod(
          initial.resolvedUrl,
          candidate,
        ),
        fetched,
        parsedFeed,
      };
    } catch (error) {
      const failure = RefreshFailure.fromUnknown(error);
      if (failure.retryable && !firstRetryableFailure) {
        firstRetryableFailure = failure;
      }
    }
  }

  if (firstRetryableFailure) {
    throw firstRetryableFailure;
  }

  throw RefreshFailure.noFeed(
    "No usable RSS or Atom feed was discovered for this source",
  );
}

async function fetchFeed(
  feedUrl: string,
  conditional: {
    etag?: string | null;
    lastModified?: string | null;
  } = {},
): Promise<FetchTextResult> {
  return fetchTextResource(feedUrl, {
    accept: FEED_ACCEPT,
    maxBytes: maxFeedBytes,
    bodyLabel: "Feed body",
    etag: conditional.etag,
    lastModified: conditional.lastModified,
  });
}

export async function fetchTextResource(
  url: string,
  input: {
    accept: string;
    maxBytes: number;
    bodyLabel: string;
    etag?: string | null;
    lastModified?: string | null;
    policy?: Parameters<typeof performValidatedFetch>[1]["policy"];
  },
): Promise<FetchTextResult> {
  let response: Response;
  let resolvedUrl: string;
  try {
    const headers: Record<string, string> = {};
    if (input.etag) {
      headers["if-none-match"] = input.etag;
    }
    if (input.lastModified) {
      headers["if-modified-since"] = input.lastModified;
    }
    const fetched = await performValidatedFetch(url, {
      policy: input.policy,
      accept: input.accept,
      headers,
      maxRedirects: 5,
    });
    response = fetched.response;
    resolvedUrl = fetched.resolvedUrl;
  } catch (error) {
    throw RefreshFailure.fromUnknown(error);
  }

  if (response.status === 304) {
    return {
      resolvedUrl,
      status: response.status,
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      notModified: true,
      text: "",
    };
  }

  if (!response.ok) {
    throw RefreshFailure.feed(`Source returned HTTP ${response.status}`, {
      httpStatus: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  let text: string;
  try {
    const bytes = await readResponseBytes(
      response,
      input.maxBytes,
      input.bodyLabel,
    );
    text = new TextDecoder().decode(bytes);
  } catch (error) {
    throw RefreshFailure.fromUnknown(error);
  }

  return {
    resolvedUrl,
    status: response.status,
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    notModified: false,
    text,
  };
}

async function loadSourceContext(sourceId: string): Promise<SourceContext> {
  const supabase = getSupabase();
  const { data: sourceRow, error: sourceError } = await supabase
    .from("content_sources")
    .select("id, source_url, resolved_source_url, host")
    .eq("id", sourceId)
    .maybeSingle();

  if (sourceError) {
    throw new Error(
      `Failed to load source ${sourceId}: ${sourceError.message}`,
    );
  }
  if (!sourceRow) {
    throw new Error(`Source ${sourceId} disappeared before refresh`);
  }

  const { data: feedRows, error: feedError } = await supabase
    .from("source_feeds")
    .select(
      "id, source_id, feed_url, feed_kind, discovery_method, is_primary, title, etag, last_modified, refresh_status, last_refreshed_at, next_refresh_at",
    )
    .eq("source_id", sourceId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  if (feedError) {
    throw new Error(
      `Failed to load source feed for ${sourceId}: ${feedError.message}`,
    );
  }

  const { data: subscriptions, error: subscriptionsError } = await supabase
    .from("source_subscriptions")
    .select("id, user_id, last_backfilled_at")
    .eq("source_id", sourceId)
    .order("created_at", { ascending: true });
  if (subscriptionsError) {
    throw new Error(
      `Failed to load subscriptions for ${sourceId}: ${subscriptionsError.message}`,
    );
  }

  return {
    sourceId,
    sourceUrl: sourceRow.source_url,
    resolvedSourceUrl: sourceRow.resolved_source_url,
    host: sourceRow.host,
    primaryFeed: ((feedRows ?? []) as SourceFeedRow[])[0] ?? null,
    subscriptions: (subscriptions ?? []) as SourceSubscriptionRow[],
  };
}

async function ensurePrimaryFeed(
  sourceId: string,
  feedUrl: string,
  discoveryMethod: DiscoveryMethod,
): Promise<SourceFeedRow> {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const { error: demoteError } = await supabase
    .from("source_feeds")
    .update({ is_primary: false, updated_at: now })
    .eq("source_id", sourceId)
    .neq("feed_url", feedUrl)
    .eq("is_primary", true);
  if (demoteError) {
    throw new Error(
      `Failed to demote old primary feed: ${demoteError.message}`,
    );
  }

  const { data, error } = await supabase
    .from("source_feeds")
    .upsert(
      {
        source_id: sourceId,
        feed_url: feedUrl,
        feed_kind: "unknown",
        discovery_method: discoveryMethod,
        is_primary: true,
        refresh_status: "in_progress",
        last_refresh_error: null,
        last_refresh_attempt_at: now,
        next_refresh_at: addSeconds(now, refreshIntervalSeconds),
        updated_at: now,
      },
      { onConflict: "source_id,feed_url" },
    )
    .select(
      "id, source_id, feed_url, feed_kind, discovery_method, is_primary, title, etag, last_modified, refresh_status, last_refreshed_at, next_refresh_at",
    )
    .single();

  if (error) {
    throw new Error(`Failed to upsert primary feed: ${error.message}`);
  }

  return data as SourceFeedRow;
}

async function syncFeedEntries(input: {
  source: SourceContext;
  feedRow: SourceFeedRow;
  feedResolution: FeedDiscoveryResult;
}): Promise<number> {
  const supabase = getSupabase();
  const parsedFeed = input.feedResolution.parsedFeed;
  if (parsedFeed.entries.length === 0) {
    throw RefreshFailure.feed("Feed did not contain any entries", {
      httpStatus: input.feedResolution.fetched.status,
      retryable: false,
    });
  }

  const canonicalUrls = parsedFeed.entries.map((entry) => entry.canonicalUrl);
  const { data: existingContent, error: existingContentError } = await supabase
    .from("content")
    .select(
      "id, canonical_url, source_id, fetch_status, parse_status, parsed_document",
    )
    .in("canonical_url", canonicalUrls);
  if (existingContentError) {
    throw new Error(
      `Failed to load existing content for feed sync: ${existingContentError.message}`,
    );
  }

  const existingByCanonicalUrl = new Map(
    ((existingContent ?? []) as ContentRow[]).map((
      row,
    ) => [row.canonical_url, row]),
  );
  const newContentRowsByCanonicalUrl = new Map<
    string,
    {
      canonical_url: string;
      host: string;
      source_id: string;
      title: string | null;
      excerpt: string | null;
      author: string | null;
      published_at: string | null;
    }
  >();
  for (const entry of parsedFeed.entries) {
    if (existingByCanonicalUrl.has(entry.canonicalUrl)) {
      continue;
    }

    if (!newContentRowsByCanonicalUrl.has(entry.canonicalUrl)) {
      newContentRowsByCanonicalUrl.set(entry.canonicalUrl, {
        canonical_url: entry.canonicalUrl,
        host: entry.host,
        source_id: input.source.sourceId,
        title: entry.title,
        excerpt: entry.excerpt,
        author: entry.author,
        published_at: entry.publishedAt,
      });
    }
  }
  const newContentRows = Array.from(newContentRowsByCanonicalUrl.values());

  if (newContentRows.length > 0) {
    const { error: insertContentError } = await supabase
      .from("content")
      .upsert(newContentRows, {
        defaultToNull: true,
        onConflict: "canonical_url",
        ignoreDuplicates: true,
      });
    if (insertContentError) {
      throw new Error(
        `Failed to insert new content from feed: ${insertContentError.message}`,
      );
    }
  }

  const { data: contentRows, error: contentRowsError } = await supabase
    .from("content")
    .select(
      "id, canonical_url, source_id, fetch_status, parse_status, parsed_document",
    )
    .in("canonical_url", canonicalUrls);
  if (contentRowsError) {
    throw new Error(
      `Failed to load content rows after feed sync: ${contentRowsError.message}`,
    );
  }

  const contentByCanonicalUrl = new Map(
    ((contentRows ?? []) as ContentRow[]).map((
      row,
    ) => [row.canonical_url, row]),
  );

  const rowsNeedingSourceLink = Array.from(contentByCanonicalUrl.values())
    .filter(
      (row) => row.source_id === null,
    );
  for (const row of rowsNeedingSourceLink) {
    const { error: linkError } = await supabase
      .from("content")
      .update({ source_id: input.source.sourceId })
      .eq("id", row.id)
      .is("source_id", null);
    if (linkError) {
      throw new Error(`Failed to link content to source: ${linkError.message}`);
    }
  }

  const existingKeys = await fetchExistingEntryKeys(
    input.feedRow.id,
    parsedFeed.entries.map((entry) => entry.entryKey),
  );

  const entryRecords = parsedFeed.entries
    .map((entry) => {
      const content = contentByCanonicalUrl.get(entry.canonicalUrl);
      if (!content) {
        return null;
      }

      return {
        contentId: content.id,
        entryKey: entry.entryKey,
        publishedAt: entry.publishedAt,
        deliveredAt: entry.publishedAt ?? new Date().toISOString(),
      } satisfies FeedEntryRecord;
    })
    .filter((entry): entry is FeedEntryRecord => entry !== null);

  const feedEntryRows = parsedFeed.entries.flatMap((entry) => {
    const content = contentByCanonicalUrl.get(entry.canonicalUrl);
    if (!content) {
      return [];
    }

    return [{
      feed_id: input.feedRow.id,
      entry_key: entry.entryKey,
      entry_guid: entry.entryGuid,
      entry_url: entry.entryUrl,
      content_id: content.id,
      title: entry.title,
      published_at: entry.publishedAt,
      raw_payload: entry.rawPayload,
      last_seen_at: new Date().toISOString(),
    }];
  });

  if (feedEntryRows.length > 0) {
    const { error: entryUpsertError } = await supabase
      .from("source_feed_entries")
      .upsert(feedEntryRows, { onConflict: "feed_id,entry_key" });
    if (entryUpsertError) {
      throw new Error(
        `Failed to upsert feed entries: ${entryUpsertError.message}`,
      );
    }
  }

  const newEntryRecords = entryRecords.filter(
    (entry) => !existingKeys.has(entry.entryKey),
  );

  let deliveredCount = 0;
  const sortedForBackfill = selectBackfillEntries(entryRecords, backfillLimit);
  for (const subscription of input.source.subscriptions) {
    const rowsToDeliver = new Map<string, FeedEntryRecord>();

    if (subscription.last_backfilled_at === null) {
      for (const entry of sortedForBackfill) {
        rowsToDeliver.set(entry.contentId, entry);
      }
    }

    for (const entry of newEntryRecords) {
      rowsToDeliver.set(entry.contentId, entry);
    }

    if (rowsToDeliver.size > 0) {
      const inboxRows = Array.from(rowsToDeliver.values()).map((entry) => ({
        subscription_id: subscription.id,
        user_id: subscription.user_id,
        content_id: entry.contentId,
        delivered_at: entry.deliveredAt,
      }));
      const { error: inboxInsertError, count } = await supabase
        .from("subscription_inbox")
        .upsert(inboxRows, {
          onConflict: "subscription_id,content_id",
          ignoreDuplicates: true,
          count: "exact",
        });
      if (inboxInsertError) {
        throw new Error(
          `Failed to insert subscription inbox rows: ${inboxInsertError.message}`,
        );
      }

      deliveredCount += count ?? 0;
    }

    if (subscription.last_backfilled_at === null) {
      const { error: backfillMarkError } = await supabase
        .from("source_subscriptions")
        .update({
          last_backfilled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", subscription.id);
      if (backfillMarkError) {
        throw new Error(
          `Failed to mark source subscription backfilled: ${backfillMarkError.message}`,
        );
      }
    }
  }

  return deliveredCount;
}

async function fetchExistingEntryKeys(
  feedId: string,
  entryKeys: string[],
): Promise<Set<string>> {
  if (entryKeys.length === 0) {
    return new Set();
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("source_feed_entries")
    .select("entry_key")
    .eq("feed_id", feedId)
    .in("entry_key", entryKeys);
  if (error) {
    throw new Error(
      `Failed to load existing feed entry keys: ${error.message}`,
    );
  }

  return new Set(
    (data ?? []).map((row: { entry_key: string }) => row.entry_key),
  );
}

async function enqueueContentProcessingForUrls(
  canonicalUrls: string[],
): Promise<number> {
  if (canonicalUrls.length === 0) {
    return 0;
  }

  const supabase = getSupabase();
  const { data: contentRows, error: selectError } = await supabase
    .from("content")
    .select("id, fetch_status, parse_status, parsed_document")
    .in("canonical_url", canonicalUrls);
  if (selectError) {
    throw new Error(
      `Failed to load content rows for enqueue: ${selectError.message}`,
    );
  }

  const rows = (contentRows ?? []) as Array<{
    id: string;
    fetch_status: string;
    parse_status: string;
    parsed_document: Record<string, unknown> | null;
  }>;

  let enqueuedCount = 0;
  for (const row of rows) {
    const shouldEnqueue = row.fetch_status === "pending" ||
      row.fetch_status === "failed" ||
      row.parse_status === "pending" ||
      row.parse_status === "failed" ||
      row.parsed_document === null;
    if (!shouldEnqueue) {
      continue;
    }

    const { error } = await supabase.rpc("enqueue_content_processing", {
      p_content_id: row.id,
      p_trigger: "retry",
      p_delay_seconds: 0,
      p_retry_count: 0,
    });
    if (error) {
      throw new Error(
        `Failed to enqueue content processing for ${row.id}: ${error.message}`,
      );
    }
    enqueuedCount += 1;
  }

  return enqueuedCount;
}

async function invokeContentProcessor(sourceId: string): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("invoke_content_processor", {
    p_payload: {
      source_id: sourceId,
      trigger: "source_refresh",
    },
  });
  if (error) {
    throw new Error(`Failed to invoke content processor: ${error.message}`);
  }
  if (data === null) {
    console.warn(
      "content processor invoke skipped because required Vault secrets are missing",
      { sourceId },
    );
  }
}

async function persistSourceSuccess(
  source: SourceContext,
  resolution: FeedDiscoveryResult,
  now: string,
): Promise<void> {
  const supabase = getSupabase();
  const normalizedSiteUrl = resolution.parsedFeed.siteUrl
    ? normalizeWebUrl(resolution.parsedFeed.siteUrl)
    : null;
  const resolvedSourceUrl = normalizedSiteUrl?.canonicalUrl ??
    source.resolvedSourceUrl ??
    source.sourceUrl;
  const update: Record<string, unknown> = {
    refresh_status: "succeeded",
    last_refresh_error: null,
    last_http_status: resolution.fetched.status,
    last_refreshed_at: now,
    next_refresh_at: addSeconds(now, refreshIntervalSeconds),
    resolved_source_url: resolvedSourceUrl,
    host: normalizedSiteUrl?.host ?? source.host,
  };
  if (resolution.parsedFeed.title) {
    update.title = resolution.parsedFeed.title;
  }
  if (resolution.parsedFeed.description) {
    update.description = resolution.parsedFeed.description;
  }

  const { error } = await supabase
    .from("content_sources")
    .update(update)
    .eq("id", source.sourceId);
  if (error) {
    throw new Error(`Failed to persist source success: ${error.message}`);
  }
}

async function persistSourceNotModified(
  source: SourceContext,
  resolution: FeedNotModifiedResult,
  now: string,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("content_sources")
    .update({
      refresh_status: "succeeded",
      last_refresh_error: null,
      last_http_status: resolution.fetched.status,
      last_refreshed_at: now,
      next_refresh_at: addSeconds(now, refreshIntervalSeconds),
      resolved_source_url: source.resolvedSourceUrl ?? source.sourceUrl,
      host: source.host,
    })
    .eq("id", source.sourceId);
  if (error) {
    throw new Error(`Failed to persist source 304 refresh: ${error.message}`);
  }
}

async function persistFeedSuccess(
  feedId: string,
  resolution: FeedDiscoveryResult,
  now: string,
): Promise<void> {
  const supabase = getSupabase();
  const update: Record<string, unknown> = {
    feed_url: resolution.feedUrl,
    feed_kind: resolution.parsedFeed.kind,
    refresh_status: "succeeded",
    last_refresh_error: null,
    last_http_status: resolution.fetched.status,
    last_refreshed_at: now,
    next_refresh_at: addSeconds(now, refreshIntervalSeconds),
    is_primary: true,
    discovery_method: resolution.discoveryMethod,
  };
  if (resolution.fetched.etag) {
    update.etag = resolution.fetched.etag;
  }
  if (resolution.fetched.lastModified) {
    update.last_modified = resolution.fetched.lastModified;
  }
  if (resolution.parsedFeed.title) {
    update.title = resolution.parsedFeed.title;
  }

  const { error } = await supabase
    .from("source_feeds")
    .update(update)
    .eq("id", feedId);
  if (error) {
    throw new Error(`Failed to persist feed success: ${error.message}`);
  }
}

async function persistFeedNotModified(
  feedId: string,
  resolution: FeedNotModifiedResult,
  now: string,
): Promise<void> {
  const supabase = getSupabase();
  const update: Record<string, unknown> = {
    feed_url: resolution.feedUrl,
    refresh_status: "succeeded",
    last_refresh_error: null,
    last_http_status: resolution.fetched.status,
    last_refreshed_at: now,
    next_refresh_at: addSeconds(now, refreshIntervalSeconds),
    is_primary: true,
    discovery_method: resolution.discoveryMethod,
  };
  if (resolution.fetched.etag) {
    update.etag = resolution.fetched.etag;
  }
  if (resolution.fetched.lastModified) {
    update.last_modified = resolution.fetched.lastModified;
  }

  const { error } = await supabase
    .from("source_feeds")
    .update(update)
    .eq("id", feedId);
  if (error) {
    throw new Error(`Failed to persist feed 304 refresh: ${error.message}`);
  }
}

async function persistFeedFailure(
  feedId: string,
  failure: RefreshFailure,
): Promise<void> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const retryDelaySeconds = failure.retryable
    ? RETRY_DELAYS_SECONDS[0]
    : refreshIntervalSeconds;
  const { error } = await supabase
    .from("source_feeds")
    .update({
      refresh_status: "failed",
      last_refresh_error: trimText(failure.message, MAX_ERROR_MESSAGE_CHARS),
      last_http_status: failure.httpStatus,
      next_refresh_at: addSeconds(now, retryDelaySeconds),
    })
    .eq("id", feedId);
  if (error) {
    throw new Error(`Failed to persist feed failure: ${error.message}`);
  }
}

async function persistSourceFailure(
  sourceId: string,
  failure: RefreshFailure,
): Promise<void> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const retryDelaySeconds = failure.noFeed
    ? noFeedRetrySeconds
    : failure.retryable
    ? RETRY_DELAYS_SECONDS[0]
    : refreshIntervalSeconds;
  const status = failure.noFeed ? "no_feed" : "failed";
  const { error } = await supabase
    .from("content_sources")
    .update({
      refresh_status: status,
      last_refresh_error: trimText(failure.message, MAX_ERROR_MESSAGE_CHARS),
      last_http_status: failure.httpStatus,
      next_refresh_at: addSeconds(now, retryDelaySeconds),
    })
    .eq("id", sourceId);
  if (error) {
    throw new Error(`Failed to persist source failure: ${error.message}`);
  }
}

async function enqueueRetry(
  sourceId: string,
  delaySeconds: number,
  retryCount: number,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("enqueue_source_refresh", {
    p_source_id: sourceId,
    p_trigger: "retry",
    p_delay_seconds: delaySeconds,
    p_retry_count: retryCount,
  });
  if (error) {
    throw new Error(`Failed to enqueue source retry: ${error.message}`);
  }
}

async function archiveQueueMessage(msgId: number): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("archive_source_refresh", {
    p_msg_id: msgId,
  });
  if (error) {
    throw new Error(
      `Failed to archive source queue message ${msgId}: ${error.message}`,
    );
  }
}

function normalizeRetryCount(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.trunc(value)
    : 0;
}

export function discoverFeedCandidates(
  html: string,
  baseUrl: string,
): string[] {
  const document = parseDocument(html);
  const base = safeBaseUrl(baseUrl);
  if (!base) {
    return [];
  }

  const scored = new Map<string, number>();
  const links = Array.from(
    document.querySelectorAll?.("link[href][rel]") ?? [],
  ) as Element[];
  for (const link of links) {
    const rel = `${link.getAttribute?.("rel") ?? ""}`.toLowerCase();
    const href = `${link.getAttribute?.("href") ?? ""}`.trim();
    if (!rel.includes("alternate") || href.length === 0) {
      continue;
    }

    const type = `${link.getAttribute?.("type") ?? ""}`.toLowerCase();
    if (
      !type.includes("rss") &&
      !type.includes("atom") &&
      !type.includes("xml")
    ) {
      continue;
    }

    const normalized = normalizeWebUrl(resolveUrl(base.toString(), href));
    if (!normalized) {
      continue;
    }

    let score = 100;
    if (normalized.host === base.host) {
      score += 20;
    }
    if (type.includes("rss")) {
      score += 10;
    }
    if (type.includes("atom")) {
      score += 8;
    }
    if (/feed|rss|atom/.test(normalized.canonicalUrl)) {
      score += 5;
    }

    const previous = scored.get(normalized.canonicalUrl) ??
      Number.NEGATIVE_INFINITY;
    scored.set(normalized.canonicalUrl, Math.max(previous, score));
  }

  for (const commonPath of COMMON_FEED_PATHS) {
    const normalized = normalizeWebUrl(resolveUrl(base.toString(), commonPath));
    if (!normalized) {
      continue;
    }

    const previous = scored.get(normalized.canonicalUrl) ??
      Number.NEGATIVE_INFINITY;
    scored.set(normalized.canonicalUrl, Math.max(previous, 50));
  }

  return Array.from(scored.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([url]) => url);
}

export function parseFeedDocument(
  xml: string,
  feedUrl: string,
): ParsedFeed | null {
  let document: Document | null = null;
  try {
    document = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return null;
  }

  if (!document?.documentElement) {
    return null;
  }
  if (document.getElementsByTagName("parsererror").length > 0) {
    return null;
  }

  const rootName = localName(document.documentElement);
  if (rootName === "rss" || rootName === "rdf") {
    return parseRssFeed(document, feedUrl);
  }
  if (rootName === "feed") {
    return parseAtomFeed(document, feedUrl);
  }

  return null;
}

function parseRssFeed(document: Document, feedUrl: string): ParsedFeed | null {
  const channel = firstDescendantByName(document.documentElement, "channel");
  if (!channel) {
    return null;
  }

  const entries = descendantsByName(channel, "item")
    .map((item, index) => parseRssItem(item, feedUrl, index))
    .filter((item): item is ParsedFeedEntry => item !== null);
  if (entries.length === 0) {
    return null;
  }

  return {
    kind: "rss",
    title: trimText(childText(channel, "title"), MAX_SOURCE_TITLE_CHARS),
    description: trimText(
      firstNonEmpty([
        childText(channel, "description"),
        childText(channel, "subtitle"),
      ]),
      MAX_SOURCE_DESCRIPTION_CHARS,
    ),
    siteUrl: normalizeWebUrl(childText(channel, "link"))?.canonicalUrl ?? null,
    entries: dedupeEntries(entries).slice(0, maxFeedEntries),
  };
}

function parseAtomFeed(document: Document, feedUrl: string): ParsedFeed | null {
  const feed = document.documentElement;
  if (localName(feed) !== "feed") {
    return null;
  }

  const feedAuthor = firstDescendantByName(feed, "author");
  const feedAuthorName = trimText(
    childText(feedAuthor, "name"),
    MAX_ENTRY_AUTHOR_CHARS,
  );
  const entries = directChildrenByName(feed, "entry")
    .map((entry, index) =>
      parseAtomEntry(entry, feedUrl, feedAuthorName, index)
    )
    .filter((item): item is ParsedFeedEntry => item !== null);
  if (entries.length === 0) {
    return null;
  }

  return {
    kind: "atom",
    title: trimText(childText(feed, "title"), MAX_SOURCE_TITLE_CHARS),
    description: trimText(
      firstNonEmpty([childText(feed, "subtitle"), childText(feed, "tagline")]),
      MAX_SOURCE_DESCRIPTION_CHARS,
    ),
    siteUrl: atomAlternateLink(feed) ?? null,
    entries: dedupeEntries(entries).slice(0, maxFeedEntries),
  };
}

function parseRssItem(
  item: Element,
  feedUrl: string,
  index: number,
): ParsedFeedEntry | null {
  const rawUrl = firstNonEmpty([
    childText(item, "link"),
    childText(item, "guid"),
  ]);
  const normalizedUrl = normalizeWebUrl(resolveUrl(feedUrl, rawUrl));
  if (!normalizedUrl) {
    return null;
  }

  const guid = trimText(childText(item, "guid"), MAX_URL_CHARS);
  const title = trimText(childText(item, "title"), MAX_ENTRY_TITLE_CHARS);
  const excerpt = trimText(
    stripMarkup(
      firstNonEmpty([
        childText(item, "description"),
        childText(item, "encoded"),
      ]),
    ),
    MAX_ENTRY_EXCERPT_CHARS,
  );
  const author = trimText(
    firstNonEmpty([
      childText(item, "creator"),
      childText(item, "author"),
    ]),
    MAX_ENTRY_AUTHOR_CHARS,
  );
  const publishedAt = parseFeedDate(
    firstNonEmpty([
      childText(item, "pubDate"),
      childText(item, "published"),
      childText(item, "updated"),
    ]),
  );
  const entryKey = trimText(guid, MAX_URL_CHARS) ??
    `${normalizedUrl.canonicalUrl}#${index}`;

  return {
    entryKey,
    entryGuid: guid,
    entryUrl: normalizedUrl.canonicalUrl,
    canonicalUrl: normalizedUrl.canonicalUrl,
    host: normalizedUrl.host,
    title,
    excerpt,
    author,
    publishedAt,
    rawPayload: {
      format: "rss",
      title,
      excerpt,
      author,
      published_at: publishedAt,
      guid,
      url: normalizedUrl.canonicalUrl,
    },
  };
}

function parseAtomEntry(
  entry: Element,
  feedUrl: string,
  feedAuthorName: string | null,
  index: number,
): ParsedFeedEntry | null {
  const rawUrl = firstNonEmpty([
    atomAlternateLink(entry),
    childText(entry, "id"),
  ]);
  const normalizedUrl = normalizeWebUrl(resolveUrl(feedUrl, rawUrl));
  if (!normalizedUrl) {
    return null;
  }

  const id = trimText(childText(entry, "id"), MAX_URL_CHARS);
  const title = trimText(childText(entry, "title"), MAX_ENTRY_TITLE_CHARS);
  const excerpt = trimText(
    stripMarkup(
      firstNonEmpty([childText(entry, "summary"), childText(entry, "content")]),
    ),
    MAX_ENTRY_EXCERPT_CHARS,
  );
  const entryAuthor = firstDescendantByName(entry, "author");
  const author = trimText(
    firstNonEmpty([childText(entryAuthor, "name"), feedAuthorName]),
    MAX_ENTRY_AUTHOR_CHARS,
  );
  const publishedAt = parseFeedDate(
    firstNonEmpty([childText(entry, "published"), childText(entry, "updated")]),
  );
  const entryKey = id ?? `${normalizedUrl.canonicalUrl}#${index}`;

  return {
    entryKey,
    entryGuid: id,
    entryUrl: normalizedUrl.canonicalUrl,
    canonicalUrl: normalizedUrl.canonicalUrl,
    host: normalizedUrl.host,
    title,
    excerpt,
    author,
    publishedAt,
    rawPayload: {
      format: "atom",
      title,
      excerpt,
      author,
      published_at: publishedAt,
      id,
      url: normalizedUrl.canonicalUrl,
    },
  };
}

export function selectBackfillEntries(
  entries: FeedEntryRecord[],
  limit: number,
): FeedEntryRecord[] {
  return [...entries]
    .sort((left, right) => {
      const leftTime = left.publishedAt
        ? Date.parse(left.publishedAt)
        : Number.NEGATIVE_INFINITY;
      const rightTime = right.publishedAt
        ? Date.parse(right.publishedAt)
        : Number.NEGATIVE_INFINITY;
      if (
        Number.isFinite(leftTime) && Number.isFinite(rightTime) &&
        leftTime !== rightTime
      ) {
        return rightTime - leftTime;
      }

      if (left.deliveredAt !== right.deliveredAt) {
        return right.deliveredAt.localeCompare(left.deliveredAt);
      }

      return left.entryKey.localeCompare(right.entryKey);
    })
    .slice(0, Math.max(limit, 0));
}

function directChildrenByName(element: Element, name: string): Element[] {
  return Array.from((element?.childNodes ?? []) as Array<any>).filter((child) =>
    child?.nodeType === 1 && localName(child) === name
  ) as Element[];
}

function descendantsByName(element: Element, name: string): Element[] {
  return Array.from(element?.getElementsByTagName?.(name) ?? []) as Element[];
}

function firstDescendantByName(element: Element, name: string): Element | null {
  return descendantsByName(element, name)[0] ?? null;
}

function childText(
  element: Element | null | undefined,
  name: string,
): string | null {
  if (!element) {
    return null;
  }

  const child = directChildrenByName(element, name)[0] ??
    firstDescendantByName(element, name);
  const text = child?.textContent?.trim();
  return text ? text : null;
}

function atomAlternateLink(element: Element): string | null {
  const links = directChildrenByName(element, "link");
  for (const link of links) {
    const rel = `${link.getAttribute?.("rel") ?? ""}`.toLowerCase();
    const href = `${link.getAttribute?.("href") ?? ""}`.trim();
    if (!href) {
      continue;
    }

    if (!rel || rel === "alternate") {
      return normalizeWebUrl(href)?.canonicalUrl ?? href;
    }
  }

  return null;
}

function localName(element: Element): string {
  return `${element?.localName ?? element?.nodeName ?? ""}`
    .split(":")
    .pop()
    ?.toLowerCase() ?? "";
}

function dedupeEntries(entries: ParsedFeedEntry[]): ParsedFeedEntry[] {
  const seen = new Set<string>();
  const deduped: ParsedFeedEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.entryKey)) {
      continue;
    }
    seen.add(entry.entryKey);
    deduped.push(entry);
  }

  return deduped;
}

function firstNonEmpty(
  values: Array<string | null | undefined>,
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function stripMarkup(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (!/[<>]/.test(value)) {
    return value;
  }

  try {
    const document = parseDocument(`<body>${value}</body>`);
    const text = document.body?.textContent?.trim();
    if (text) {
      return text;
    }
  } catch {
    // Fall through to the regex cleanup below.
  }

  const fallback = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
  return fallback || null;
}

function parseFeedDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function trimText(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(0, Math.max(maxChars - 1, 1)).trimEnd() + "…";
}

function addSeconds(isoTimestamp: string, seconds: number): string {
  return new Date(Date.parse(isoTimestamp) + seconds * 1000).toISOString();
}

function resolveUrl(
  baseUrl: string,
  maybeRelativeUrl: string | null | undefined,
): string {
  if (!maybeRelativeUrl) {
    return "";
  }

  try {
    return new URL(maybeRelativeUrl, baseUrl).toString();
  } catch {
    return "";
  }
}

function safeBaseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseDiscoveryMethod(value: string): DiscoveryMethod {
  switch (value) {
    case "provided":
    case "html_link":
    case "common_path":
      return value;
    default:
      return "html_link";
  }
}

function classifyDiscoveryMethod(
  sourceResolvedUrl: string,
  candidateUrl: string,
): DiscoveryMethod {
  try {
    const source = new URL(sourceResolvedUrl);
    const candidate = new URL(candidateUrl);
    if (
      candidate.pathname === source.pathname &&
      candidate.search === source.search
    ) {
      return "provided";
    }
  } catch {
    return "html_link";
  }

  return COMMON_FEED_PATHS.some((path) => candidateUrl.endsWith(path))
    ? "common_path"
    : "html_link";
}

function normalizeWebUrl(
  input: string | null | undefined,
): { canonicalUrl: string; host: string } | null {
  if (!input) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }

  const defaultPort = url.protocol === "http:" ? "80" : "443";
  if (url.port && url.port !== defaultPort) {
    return null;
  }

  url.hash = "";
  if (url.port === defaultPort) {
    url.port = "";
  }
  url.hostname = url.hostname.toLowerCase();

  const retained = Array.from(url.searchParams.entries()).filter(([name]) =>
    !TRACKING_QUERY_PARAMS.has(name) &&
    !TRACKING_QUERY_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
  url.search = "";
  for (const [name, value] of retained) {
    url.searchParams.append(name, value);
  }

  const canonicalUrl = url.toString();
  const host = url.host.trim();
  if (!host || canonicalUrl.length > MAX_URL_CHARS) {
    return null;
  }

  return { canonicalUrl, host };
}

class RefreshFailure extends Error {
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly noFeed: boolean;

  constructor(
    message: string,
    input: {
      retryable?: boolean;
      httpStatus?: number | null;
      noFeed?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "RefreshFailure";
    this.retryable = input.retryable ?? false;
    this.httpStatus = input.httpStatus ?? null;
    this.noFeed = input.noFeed ?? false;
  }

  static feed(
    message: string,
    input: { retryable?: boolean; httpStatus?: number | null } = {},
  ): RefreshFailure {
    return new RefreshFailure(message, input);
  }

  static noFeed(message: string): RefreshFailure {
    return new RefreshFailure(message, { noFeed: true, retryable: false });
  }

  static fromUnknown(error: unknown): RefreshFailure {
    if (error instanceof RefreshFailure) {
      return error;
    }

    const maybeObject = error as {
      message?: string;
      retryable?: boolean;
      httpStatus?: number;
    } | null;

    return new RefreshFailure(
      trimText(
        maybeObject?.message ?? String(error),
        MAX_ERROR_MESSAGE_CHARS,
      ) ??
        "Source refresh failed",
      {
        retryable: maybeObject?.retryable ?? false,
        httpStatus: maybeObject?.httpStatus ?? null,
      },
    );
  }
}
