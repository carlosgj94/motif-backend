import { createClient } from "npm:@supabase/supabase-js@2.58.0";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_DELAYS_SECONDS = [60, 300, 1800];

interface QueuePayload {
  user_id?: string | null;
  content_id?: string | null;
  source_id?: string | null;
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
  dequeued: number;
  processed: number;
  retried: number;
  failed: number;
  skipped: number;
  archived: number;
}

let supabaseClient: ReturnType<typeof createClient<any>> | null = null;

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

function getSupabase(): ReturnType<typeof createClient<any>> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = safeEnvGet("SUPABASE_URL");
  const serviceRoleKey = safeEnvGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for recommendation processing",
    );
  }

  supabaseClient = createClient<any>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseClient;
}

const batchSize = envNumber(
  "RECOMMENDATION_REFRESH_BATCH_SIZE",
  DEFAULT_BATCH_SIZE,
);
const visibilityTimeoutSeconds = envNumber(
  "RECOMMENDATION_REFRESH_VISIBILITY_TIMEOUT_SECONDS",
  DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
);
const maxRetries = envNumber(
  "RECOMMENDATION_REFRESH_RETRY_LIMIT",
  DEFAULT_MAX_RETRIES,
);

export async function processRecommendationBatch(): Promise<BatchResult> {
  const supabase = getSupabase();
  const result: BatchResult = {
    dequeued: 0,
    processed: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    archived: 0,
  };

  const { data, error } = await supabase.rpc("dequeue_recommendation_refresh", {
    p_batch_size: batchSize,
    p_visibility_timeout_seconds: visibilityTimeoutSeconds,
  });
  if (error) {
    throw new Error(`Failed to read recommendation queue: ${error.message}`);
  }

  const messages = (data ?? []) as QueueMessageRow[];
  result.dequeued = messages.length;

  for (const message of messages) {
    try {
      await processQueueMessage(supabase, message, result);
    } catch (error) {
      result.failed += 1;
      console.error("recommendation processing message failed unexpectedly", {
        msgId: message.msg_id,
        error,
      });
    }
  }

  return result;
}

async function processQueueMessage(
  supabase: ReturnType<typeof createClient<any>>,
  message: QueueMessageRow,
  result: BatchResult,
): Promise<void> {
  const payload = message.message ?? {};
  if (!payload.user_id && !payload.content_id && !payload.source_id) {
    await archiveMessage(supabase, message.msg_id);
    result.archived += 1;
    result.skipped += 1;
    return;
  }

  try {
    const { error } = await supabase.rpc("refresh_recommendation_state", {
      p_user_id: payload.user_id ?? null,
      p_content_id: payload.content_id ?? null,
      p_source_id: payload.source_id ?? null,
    });
    if (error) {
      throw new Error(error.message);
    }

    result.processed += 1;
  } catch (error) {
    const retryCount = payload.retry_count ?? 0;
    if (retryCount < maxRetries) {
      const delay = RETRY_DELAYS_SECONDS[
        Math.min(retryCount, RETRY_DELAYS_SECONDS.length - 1)
      ] ??
        RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
      const { error: retryError } = await supabase.rpc(
        "enqueue_recommendation_refresh",
        {
          p_user_id: payload.user_id ?? null,
          p_content_id: payload.content_id ?? null,
          p_source_id: payload.source_id ?? null,
          p_trigger: "retry",
          p_delay_seconds: delay,
          p_retry_count: retryCount + 1,
        },
      );
      if (retryError) {
        throw new Error(
          `Failed to enqueue recommendation retry: ${retryError.message}`,
        );
      }
      result.retried += 1;
    } else {
      result.failed += 1;
      console.error("recommendation refresh exhausted retries", {
        msgId: message.msg_id,
        payload,
        error,
      });
    }
  } finally {
    await archiveMessage(supabase, message.msg_id);
    result.archived += 1;
  }
}

async function archiveMessage(
  supabase: ReturnType<typeof createClient<any>>,
  msgId: number,
): Promise<void> {
  const { error } = await supabase.rpc("archive_recommendation_refresh", {
    p_msg_id: msgId,
  });
  if (error) {
    throw new Error(
      `Failed to archive recommendation queue message ${msgId}: ${error.message}`,
    );
  }
}
