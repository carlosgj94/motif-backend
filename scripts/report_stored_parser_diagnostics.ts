import { createClient } from "npm:@supabase/supabase-js@2.58.0";

import type {
  ParserDiagnostics,
  ParserRecoveryDecision,
} from "../supabase/functions/_shared/content/model.ts";

interface StoredContentDiagnosticsRow {
  id: string;
  canonical_url: string;
  host: string;
  title: string | null;
  parsed_at: string | null;
  fetch_etag: string | null;
  fetch_last_modified: string | null;
  parser_name: string | null;
  parser_version: string | null;
  parser_quality_score: number | null;
  parser_recovery: ParserRecoveryDecision | null;
  parser_recovery_status: string | null;
  parser_recovery_stage: string | null;
  parser_recovery_last_attempt_at: string | null;
  parser_recovery_completed_at: string | null;
  parser_recovery_last_error: string | null;
  parser_diagnostics: ParserDiagnostics | null;
}

interface StoredDiagnosticsSummary {
  id: string;
  canonicalUrl: string;
  host: string;
  title: string | null;
  parsedAt: string | null;
  fetchEtag: string | null;
  fetchLastModified: string | null;
  parser: string | null;
  parserQualityScore: number | null;
  parserRecoveryStatus: string | null;
  parserRecoveryStage: string | null;
  parserRecoveryReasons: string[];
  parserRecoveryLastAttemptAt: string | null;
  parserRecoveryCompletedAt: string | null;
  parserRecoveryLastError: string | null;
  strategy: string | null;
  parsedBytes: number | null;
  compactBytes: number | null;
  warnings: string[];
  candidateCount: number;
  selectedCandidateScore: number | null;
}

function usage(): never {
  console.error(
    "usage: deno run --config supabase/functions/deno.json --allow-env --allow-net scripts/report_stored_parser_diagnostics.ts [limit]",
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
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to report stored parser diagnostics",
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
    "id, canonical_url, host, title, parsed_at, fetch_etag, fetch_last_modified, parser_name, parser_version, parser_quality_score, parser_recovery, parser_recovery_status, parser_recovery_stage, parser_recovery_last_attempt_at, parser_recovery_completed_at, parser_recovery_last_error, parser_diagnostics",
  )
  .not("parser_diagnostics", "is", null)
  .order("parsed_at", { ascending: false, nullsFirst: false })
  .limit(limit)
  .returns<StoredContentDiagnosticsRow[]>();

if (error) {
  throw new Error(`Failed to load content diagnostics: ${error.message}`);
}

const summaries: StoredDiagnosticsSummary[] = (data ?? []).map((row) => {
  const diagnostics = row.parser_diagnostics;
  const selectedCandidate = diagnostics?.candidates.find((candidate) =>
    candidate.selected
  );

  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    host: row.host,
    title: row.title,
    parsedAt: row.parsed_at,
    fetchEtag: row.fetch_etag,
    fetchLastModified: row.fetch_last_modified,
    parser: row.parser_name && row.parser_version
      ? `${row.parser_name}@${row.parser_version}`
      : row.parser_name,
    parserQualityScore: row.parser_quality_score,
    parserRecoveryStatus: row.parser_recovery_status,
    parserRecoveryStage: row.parser_recovery_stage,
    parserRecoveryReasons: row.parser_recovery?.reasons ?? [],
    parserRecoveryLastAttemptAt: row.parser_recovery_last_attempt_at,
    parserRecoveryCompletedAt: row.parser_recovery_completed_at,
    parserRecoveryLastError: row.parser_recovery_last_error,
    strategy: diagnostics?.selectedStrategyId ?? null,
    parsedBytes: diagnostics?.bytes.parsedDocumentBytes ?? null,
    compactBytes: diagnostics?.bytes.compactBodyBytes ?? null,
    warnings: diagnostics?.warnings ?? [],
    candidateCount: diagnostics?.candidates.length ?? 0,
    selectedCandidateScore: selectedCandidate?.totalScore ??
      selectedCandidate?.qualityScore ?? null,
  };
});

const warningCounts = new Map<string, number>();
for (const summary of summaries) {
  for (const warning of summary.warnings) {
    warningCounts.set(warning, (warningCounts.get(warning) ?? 0) + 1);
  }
}

console.log(JSON.stringify(
  {
    generatedAt: new Date().toISOString(),
    rowCount: summaries.length,
    warningCounts: Object.fromEntries(
      [...warningCounts.entries()].sort((left, right) => right[1] - left[1]),
    ),
    summaries,
  },
  null,
  2,
));
