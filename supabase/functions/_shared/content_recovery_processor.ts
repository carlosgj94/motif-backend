import { createClient } from "npm:@supabase/supabase-js@2.58.0";

import {
  envNumber,
  MAX_AUTHOR_CHARS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_LANGUAGE_CODE_CHARS,
  MAX_SITE_NAME_CHARS,
  MAX_TITLE_CHARS,
  safeEnvGet,
} from "./content/config.ts";
import { fetchDocument } from "./content/fetch.ts";
import type {
  ParserRecoveryDecision,
  ProcessedContent,
} from "./content/model.ts";
import { ProcessingFailure } from "./content/model.ts";
import {
  deriveParserQualityScore,
  prepareParserDiagnosticsForStorage,
} from "./content/diagnostics.ts";
import { prepareParserRecoveryForStorage } from "./content/recovery.ts";
import {
  type ClaimedRecoveryRow,
  faviconFromClaim,
  normalizeRetryCount,
} from "./content/recovery_worker_shared.ts";
import { shouldEscalateToRenderedRecovery } from "./content/rendered_recovery_gate.ts";
import { isRenderedFetchConfigured } from "./content/rendered_fetch.ts";
import { runStaticRecovery } from "./content/static_recovery.ts";
import { trimText, trimUrl } from "./content/normalize.ts";
import {
  enqueueContentRenderRecovery,
  invokeContentRenderRecoveryProcessor,
} from "./content_render_recovery_processor.ts";

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
const DEFAULT_STALE_AFTER_SECONDS = 900;
const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_ENQUEUE_DUE_LIMIT = 50;
const RETRY_DELAYS_SECONDS = [300, 1800];

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

interface BatchResult {
  enqueued_due: number;
  dequeued: number;
  processed: number;
  recovered: number;
  dismissed: number;
  escalated: number;
  retried: number;
  failed: number;
  skipped: number;
  archived: number;
}

let supabaseClient: ReturnType<typeof createClient<any>> | null = null;

const batchSize = envNumber(
  "CONTENT_RECOVERY_BATCH_SIZE",
  DEFAULT_BATCH_SIZE,
);
const visibilityTimeoutSeconds = envNumber(
  "CONTENT_RECOVERY_VISIBILITY_TIMEOUT_SECONDS",
  DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
);
const staleAfterSeconds = envNumber(
  "CONTENT_RECOVERY_STALE_AFTER_SECONDS",
  DEFAULT_STALE_AFTER_SECONDS,
);
const maxRetries = envNumber(
  "CONTENT_RECOVERY_RETRY_LIMIT",
  DEFAULT_RETRY_LIMIT,
);
const enqueueDueLimit = envNumber(
  "CONTENT_RECOVERY_ENQUEUE_LIMIT",
  DEFAULT_ENQUEUE_DUE_LIMIT,
);

function getSupabase(): ReturnType<typeof createClient<any>> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = safeEnvGet("SUPABASE_URL");
  const serviceRoleKey = safeEnvGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for content recovery",
    );
  }

  supabaseClient = createClient<any>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseClient;
}

export async function processContentRecoveryBatch(): Promise<BatchResult> {
  const supabase = getSupabase();
  const result: BatchResult = {
    enqueued_due: 0,
    dequeued: 0,
    processed: 0,
    recovered: 0,
    dismissed: 0,
    escalated: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    archived: 0,
  };

  const { data: enqueuedDue, error: enqueueDueError } = await supabase.rpc(
    "enqueue_due_content_recoveries",
    {
      p_limit: enqueueDueLimit,
    },
  );
  if (enqueueDueError) {
    throw new Error(
      `Failed to enqueue due content recoveries: ${enqueueDueError.message}`,
    );
  }
  result.enqueued_due = Number.isFinite(enqueuedDue) ? Number(enqueuedDue) : 0;

  const { data, error } = await supabase.rpc("dequeue_content_recovery", {
    p_batch_size: batchSize,
    p_visibility_timeout_seconds: visibilityTimeoutSeconds,
  });
  if (error) {
    throw new Error(`Failed to read content recovery queue: ${error.message}`);
  }

  const queueMessages = (data ?? []) as QueueMessageRow[];
  result.dequeued = queueMessages.length;

  for (const queueMessage of queueMessages) {
    try {
      await processQueueMessage(queueMessage, result);
    } catch (error) {
      result.failed += 1;
      console.error("content recovery message failed unexpectedly", {
        msgId: queueMessage.msg_id,
        error,
      });
    }
  }

  return result;
}

export async function enqueueContentRecovery(
  contentId: string,
  trigger: "save" | "retry" | "cron" = "save",
  delaySeconds = 0,
  retryCount = 0,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("enqueue_content_recovery", {
    p_content_id: contentId,
    p_trigger: trigger,
    p_delay_seconds: delaySeconds,
    p_retry_count: retryCount,
  });
  if (error) {
    throw new Error(
      `Failed to enqueue content recovery for ${contentId}: ${error.message}`,
    );
  }
}

export async function invokeContentRecoveryProcessor(payload: {
  content_id?: string;
  trigger?: string;
} = {}): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc(
    "invoke_content_recovery_processor",
    {
      p_payload: payload,
    },
  );
  if (error) {
    throw new Error(
      `Failed to invoke content recovery processor: ${error.message}`,
    );
  }

  if (data === null) {
    console.warn(
      "content recovery processor invoke skipped because required Vault secrets are missing",
      payload,
    );
  }
}

async function processQueueMessage(
  queueMessage: QueueMessageRow,
  result: BatchResult,
): Promise<void> {
  const contentId = queueMessage.message?.content_id;
  if (!contentId) {
    await archiveQueueMessage(queueMessage.msg_id);
    result.archived += 1;
    result.skipped += 1;
    return;
  }

  const claimed = await claimRecovery(contentId);
  if (!claimed) {
    await archiveQueueMessage(queueMessage.msg_id);
    result.archived += 1;
    result.skipped += 1;
    return;
  }

  const retryCount = normalizeRetryCount(queueMessage.message?.retry_count);

  try {
    const fetched = await fetchDocument(
      claimed.resolved_url ?? claimed.canonical_url,
    );
    const recovery = await runStaticRecovery({
      fetched,
      current: {
        sourceKind: claimed.source_kind,
        parsedDocument: claimed.parsed_document,
        parserQualityScore: claimed.parser_quality_score,
        parserRecovery: claimed.parser_recovery,
      },
    });

    const escalationDecision = recovery.kind === "persist"
      ? recovery.recoveryDecision
      : recovery.recoveryDecision;
    const shouldEscalate = shouldEscalateToRenderedRecovery({
      fetched,
      current: {
        sourceKind: claimed.source_kind,
        parsedDocument: claimed.parsed_document,
        parserQualityScore: claimed.parser_quality_score,
        parserRecovery: claimed.parser_recovery,
      },
      recoveryDecision: escalationDecision,
      rendererConfigured: isRenderedFetchConfigured(),
    });

    if (recovery.kind === "persist") {
      const nextStatus =
        shouldEscalate && recovery.recoveryStatus === "dismissed"
          ? "needed"
          : recovery.recoveryStatus;
      const nextStage =
        shouldEscalate && recovery.recoveryStatus === "dismissed"
          ? "rendered"
          : "static";
      await persistRecoveredContent(claimed, fetched, recovery.processed, {
        parserRecoveryStatus: nextStatus,
        parserRecoveryStage: nextStage,
        parserRecovery: recovery.recoveryDecision,
      });
      if (nextStatus === "succeeded") {
        result.recovered += 1;
      } else if (nextStatus === "needed") {
        await enqueueRenderedEscalation(claimed.id);
        result.escalated += 1;
      } else {
        result.dismissed += 1;
      }
    } else {
      if (shouldEscalate) {
        await persistRecoveryEscalated(claimed.id, recovery.recoveryDecision);
        await enqueueRenderedEscalation(claimed.id);
        result.escalated += 1;
      } else {
        await persistRecoveryDismissed(
          claimed.id,
          recovery.recoveryDecision,
          recovery.reason,
        );
        result.dismissed += 1;
      }
    }

    result.processed += 1;
  } catch (error) {
    const failure = ProcessingFailure.fromUnknown(error);
    await persistRecoveryFailure(claimed.id, failure);

    if (failure.retryable && retryCount < maxRetries) {
      const retryDelaySeconds = RETRY_DELAYS_SECONDS[
        Math.min(retryCount, RETRY_DELAYS_SECONDS.length - 1)
      ];
      await enqueueContentRecovery(
        claimed.id,
        "retry",
        retryDelaySeconds,
        retryCount + 1,
      );
      result.retried += 1;
    } else {
      result.failed += 1;
    }
  }

  await archiveQueueMessage(queueMessage.msg_id);
  result.archived += 1;
}

async function claimRecovery(
  contentId: string,
): Promise<ClaimedRecoveryRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("claim_content_recovery", {
    p_content_id: contentId,
    p_stale_after_seconds: staleAfterSeconds,
  });
  if (error) {
    throw new Error(
      `Failed to claim content recovery ${contentId}: ${error.message}`,
    );
  }

  return ((data ?? []) as ClaimedRecoveryRow[])[0] ?? null;
}

async function persistRecoveredContent(
  claimed: ClaimedRecoveryRow,
  fetched: {
    status: number;
    fetchedAt: string;
    etag: string | null;
    lastModified: string | null;
    resolvedUrl: string;
    host: string;
  },
  processed: ProcessedContent,
  input: {
    parserRecoveryStatus: "succeeded" | "dismissed" | "needed";
    parserRecoveryStage: "static" | "rendered";
    parserRecovery: ParserRecoveryDecision | null;
  },
): Promise<void> {
  const supabase = getSupabase();
  const favicon = processed.favicon ?? faviconFromClaim(claimed);
  const payload: Record<string, unknown> = {
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
    favicon_bytes: favicon?.byteaHex ?? null,
    favicon_mime_type: trimText(favicon?.mimeType ?? null, 128),
    favicon_source_url: trimUrl(favicon?.sourceUrl ?? null),
    favicon_fetched_at: favicon?.fetchedAt ?? null,
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
    parser_recovery: prepareParserRecoveryForStorage(
      input.parserRecovery ?? {
        shouldRecover: false,
        priority: null,
        qualityScore: null,
        route: null,
        selectedStrategyId: null,
        reasons: [],
      },
    ),
    parser_recovery_status: input.parserRecoveryStatus,
    parser_recovery_stage: input.parserRecoveryStage,
    parser_recovery_completed_at: new Date().toISOString(),
    parser_recovery_last_error: null,
    fetch_status: "succeeded",
    parse_status: "succeeded",
    last_fetch_error: null,
    last_parse_error: null,
    last_http_status: fetched.status,
    last_successful_fetch_at: fetched.fetchedAt,
  };

  if (input.parserRecoveryStatus === "succeeded") {
    payload.parser_recovery = null;
    payload.parser_recovery_requested_at = null;
  } else if (input.parserRecoveryStatus === "needed") {
    payload.parser_recovery_requested_at = new Date().toISOString();
    payload.parser_recovery_completed_at = null;
  }

  const { error } = await supabase.from("content").update(payload).eq(
    "id",
    claimed.id,
  );
  if (error) {
    throw new Error(
      `Failed to persist recovered content ${claimed.id}: ${error.message}`,
    );
  }
}

async function persistRecoveryDismissed(
  contentId: string,
  decision: ParserRecoveryDecision | null,
  _reason: string,
): Promise<void> {
  const supabase = getSupabase();
  const payload = {
    parser_recovery: decision
      ? prepareParserRecoveryForStorage(decision)
      : null,
    parser_recovery_status: "dismissed",
    parser_recovery_stage: "static",
    parser_recovery_completed_at: new Date().toISOString(),
    parser_recovery_last_error: null,
  };

  const { error } = await supabase.from("content").update(payload).eq(
    "id",
    contentId,
  );
  if (error) {
    throw new Error(
      `Failed to persist recovery dismissal ${contentId}: ${error.message}`,
    );
  }
}

async function persistRecoveryFailure(
  contentId: string,
  failure: ProcessingFailure,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("content").update({
    parser_recovery_status: "failed",
    parser_recovery_completed_at: null,
    parser_recovery_last_error: trimText(
      failure.message,
      MAX_ERROR_MESSAGE_CHARS,
    ),
  }).eq("id", contentId);

  if (error) {
    throw new Error(
      `Failed to persist content recovery failure ${contentId}: ${error.message}`,
    );
  }
}

async function persistRecoveryEscalated(
  contentId: string,
  decision: ParserRecoveryDecision | null,
): Promise<void> {
  const supabase = getSupabase();
  const payload = {
    parser_recovery: decision
      ? prepareParserRecoveryForStorage(decision)
      : null,
    parser_recovery_status: "needed",
    parser_recovery_stage: "rendered",
    parser_recovery_requested_at: new Date().toISOString(),
    parser_recovery_completed_at: null,
    parser_recovery_last_error: null,
  };

  const { error } = await supabase.from("content").update(payload).eq(
    "id",
    contentId,
  );
  if (error) {
    throw new Error(
      `Failed to persist recovery escalation ${contentId}: ${error.message}`,
    );
  }
}

async function enqueueRenderedEscalation(contentId: string): Promise<void> {
  await enqueueContentRenderRecovery(contentId, "escalate");
  await invokeContentRenderRecoveryProcessor({
    content_id: contentId,
    trigger: "escalate",
  });
}

async function archiveQueueMessage(msgId: number): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("archive_content_recovery", {
    p_msg_id: msgId,
  });
  if (error) {
    throw new Error(
      `Failed to archive content recovery queue message ${msgId}: ${error.message}`,
    );
  }
}
