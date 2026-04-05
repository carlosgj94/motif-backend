import { createClient } from "npm:@supabase/supabase-js@2.58.0";

import type { ParserRecoveryDecision } from "../supabase/functions/_shared/content/model.ts";

interface StoredRecoveryRow {
  id: string;
  canonical_url: string;
  host: string;
  title: string | null;
  parsed_at: string | null;
  parser_name: string | null;
  parser_version: string | null;
  parser_quality_score: number | null;
  parser_recovery_status: string | null;
  parser_recovery_stage: string | null;
  parser_recovery_requested_at: string | null;
  parser_recovery_attempt_count: number | null;
  parser_recovery_last_attempt_at: string | null;
  parser_recovery_completed_at: string | null;
  parser_recovery_last_error: string | null;
  parser_recovery: ParserRecoveryDecision | null;
}

function usage(): never {
  console.error(
    "usage: deno run --config supabase/functions/deno.json --allow-env --allow-net scripts/report_parser_recovery_candidates.ts [limit]",
  );
  Deno.exit(1);
}

const rawLimit = Deno.args[0]?.trim() ?? "50";
const limit = Number.parseInt(rawLimit, 10);
if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
  usage();
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to report parser recovery candidates",
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const { data, error } = await supabase
  .from("content")
  .select(
    "id, canonical_url, host, title, parsed_at, parser_name, parser_version, parser_quality_score, parser_recovery_status, parser_recovery_stage, parser_recovery_requested_at, parser_recovery_attempt_count, parser_recovery_last_attempt_at, parser_recovery_completed_at, parser_recovery_last_error, parser_recovery",
  )
  .eq("parser_recovery_status", "needed")
  .order("parser_recovery_requested_at", {
    ascending: false,
    nullsFirst: false,
  })
  .limit(limit)
  .returns<StoredRecoveryRow[]>();

if (error) {
  throw new Error(
    `Failed to load parser recovery candidates: ${error.message}`,
  );
}

const priorityCounts = new Map<string, number>();
for (const row of data ?? []) {
  const priority = row.parser_recovery?.priority ?? "unknown";
  priorityCounts.set(priority, (priorityCounts.get(priority) ?? 0) + 1);
}

console.log(JSON.stringify(
  {
    generatedAt: new Date().toISOString(),
    rowCount: (data ?? []).length,
    priorityCounts: Object.fromEntries(
      [...priorityCounts.entries()].sort((left, right) => right[1] - left[1]),
    ),
    rows: (data ?? []).map((row) => ({
      id: row.id,
      canonicalUrl: row.canonical_url,
      host: row.host,
      title: row.title,
      parsedAt: row.parsed_at,
      parser: row.parser_name && row.parser_version
        ? `${row.parser_name}@${row.parser_version}`
        : row.parser_name,
      parserQualityScore: row.parser_quality_score,
      recoveryStatus: row.parser_recovery_status,
      recoveryStage: row.parser_recovery_stage,
      recoveryRequestedAt: row.parser_recovery_requested_at,
      recoveryAttemptCount: row.parser_recovery_attempt_count,
      recoveryLastAttemptAt: row.parser_recovery_last_attempt_at,
      recoveryCompletedAt: row.parser_recovery_completed_at,
      recoveryLastError: row.parser_recovery_last_error,
      recoveryPriority: row.parser_recovery?.priority ?? null,
      recoveryReasons: row.parser_recovery?.reasons ?? [],
      strategy: row.parser_recovery?.selectedStrategyId ?? null,
      route: row.parser_recovery?.route ?? null,
    })),
  },
  null,
  2,
));
