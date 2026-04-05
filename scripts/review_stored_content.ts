import {
  createClient,
  type SupabaseClient,
} from "npm:@supabase/supabase-js@2.58.0";

import { buildCompactContentBody } from "../supabase/functions/_shared/content/compact_body.ts";
import type {
  ParserDiagnostics,
  ParserRecoveryDecision,
} from "../supabase/functions/_shared/content/model.ts";

interface StoredContentRow {
  id: string;
  canonical_url: string;
  resolved_url: string | null;
  host: string;
  site_name: string | null;
  source_kind: string | null;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  published_at: string | null;
  parsed_at: string | null;
  fetch_etag: string | null;
  fetch_last_modified: string | null;
  parser_name: string | null;
  parser_version: string | null;
  parser_quality_score: number | null;
  parser_recovery: ParserRecoveryDecision | null;
  parser_recovery_status: string | null;
  parser_recovery_stage: string | null;
  parser_recovery_requested_at: string | null;
  parser_recovery_attempt_count: number | null;
  parser_recovery_last_attempt_at: string | null;
  parser_recovery_completed_at: string | null;
  parser_recovery_last_error: string | null;
  parser_diagnostics: ParserDiagnostics | null;
  parsed_document: Record<string, unknown> | null;
}

function usage(): never {
  console.error(
    "usage: deno run --config supabase/functions/deno.json --allow-env --allow-net scripts/review_stored_content.ts <content-id-or-url>",
  );
  Deno.exit(1);
}

const query = Deno.args[0]?.trim() ?? "";
if (!query) {
  usage();
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to review stored content",
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const data = await findStoredContentRow(supabase, query);
if (!data) {
  throw new Error(`No stored content row matched ${query}`);
}

const diagnostics = data.parser_diagnostics;
const compact = data.parsed_document
  ? buildCompactContentBody(
    data.parsed_document,
    parseSourceKind(data.source_kind),
  )
  : null;

console.log(`Content: ${data.id}`);
console.log(`Canonical URL: ${data.canonical_url}`);
console.log(`Resolved URL: ${data.resolved_url ?? "n/a"}`);
console.log(`Host: ${data.host}`);
console.log(`Title: ${data.title ?? "n/a"}`);
console.log(`Author: ${data.author ?? "n/a"}`);
console.log(`Excerpt: ${data.excerpt ?? "n/a"}`);
console.log(`Published: ${data.published_at ?? "n/a"}`);
console.log(`Parsed At: ${data.parsed_at ?? "n/a"}`);
console.log(`ETag: ${data.fetch_etag ?? "n/a"}`);
console.log(`Last Modified: ${data.fetch_last_modified ?? "n/a"}`);
console.log(
  `Parser: ${data.parser_name ?? "n/a"}@${data.parser_version ?? "n/a"}`,
);
console.log(`Parser Quality: ${data.parser_quality_score ?? "n/a"}`);
console.log(`Recovery Status: ${data.parser_recovery_status ?? "n/a"}`);
console.log(`Recovery Stage: ${data.parser_recovery_stage ?? "n/a"}`);
console.log(
  `Recovery Requested At: ${data.parser_recovery_requested_at ?? "n/a"}`,
);
console.log(
  `Recovery Attempt Count: ${data.parser_recovery_attempt_count ?? "n/a"}`,
);
console.log(
  `Recovery Last Attempt At: ${data.parser_recovery_last_attempt_at ?? "n/a"}`,
);
console.log(
  `Recovery Completed At: ${data.parser_recovery_completed_at ?? "n/a"}`,
);
console.log(`Recovery Last Error: ${data.parser_recovery_last_error ?? "n/a"}`);
if (data.parser_recovery) {
  console.log(
    `Recovery Reasons: ${data.parser_recovery.reasons.join(", ") || "none"}`,
  );
  console.log(`Recovery Priority: ${data.parser_recovery.priority ?? "n/a"}`);
}
console.log(`Strategy: ${diagnostics?.selectedStrategyId ?? "n/a"}`);

if (diagnostics) {
  const compactBytes = diagnostics.bytes.compactBodyBytes ?? 0;
  const compactBudget = diagnostics.bytes.compactBodyBudgetBytes ?? 0;
  console.log(
    `Bytes: parsed=${diagnostics.bytes.parsedDocumentBytes}/${diagnostics.bytes.parsedDocumentBudgetBytes} (${
      formatRatio(diagnostics.bytes.parsedDocumentBudgetRatio)
    }) compact=${compactBytes}/${compactBudget} (${
      formatRatio(diagnostics.bytes.compactBodyBudgetRatio)
    })`,
  );
  console.log(
    `Warnings: ${
      diagnostics.warnings.length > 0 ? diagnostics.warnings.join(", ") : "none"
    }`,
  );

  if (diagnostics.candidates.length > 0) {
    console.log("\nCandidates:");
    for (const candidate of diagnostics.candidates) {
      const marker = candidate.selected ? "*" : "-";
      const score = candidate.totalScore ?? candidate.qualityScore;
      console.log(
        `${marker} ${candidate.id} score=${
          score ?? "n/a"
        } blocks=${candidate.blockCount} words=${candidate.wordCount} compact_bytes=${
          candidate.compactBodyBytes ?? "n/a"
        } notes=${candidate.notes.join("|") || "none"}`,
      );
    }
  }
} else {
  console.log("Diagnostics: none");
}

if (compact) {
  console.log("\nFirst compact blocks:");
  for (const [index, block] of compact.blocks.slice(0, 12).entries()) {
    console.log(
      `${String(index + 1).padStart(2, " ")}. ${summarizeCompactBlock(block)}`,
    );
  }
}

function parseSourceKind(
  value: string | null,
): "article" | "thread" | "post" | undefined {
  switch (value) {
    case "article":
    case "thread":
    case "post":
      return value;
    default:
      return undefined;
  }
}

function summarizeCompactBlock(
  block: NonNullable<typeof compact>["blocks"][number],
): string {
  switch (block.t) {
    case "h":
      return `[h${block.l}] ${block.x}`;
    case "p":
      return `[p] ${block.x}`;
    case "q":
      return `[q] ${block.x}`;
    case "l":
      return `[list] ${block.i.join(" | ")}`;
    case "c":
      return `[code${block.lang ? `:${block.lang}` : ""}] ${block.x}`;
  }
}

function formatRatio(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}

async function findStoredContentRow(
  supabase: SupabaseClient,
  query: string,
): Promise<StoredContentRow | null> {
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(query);
  if (isUuid) {
    return await fetchStoredContentRow(supabase, "id", query);
  }

  return await fetchStoredContentRow(supabase, "canonical_url", query) ??
    await fetchStoredContentRow(supabase, "resolved_url", query);
}

async function fetchStoredContentRow(
  supabase: SupabaseClient,
  column: "id" | "canonical_url" | "resolved_url",
  value: string,
): Promise<StoredContentRow | null> {
  const { data, error } = await supabase
    .from("content")
    .select(
      "id, canonical_url, resolved_url, host, site_name, source_kind, title, excerpt, author, published_at, parsed_at, fetch_etag, fetch_last_modified, parser_name, parser_version, parser_quality_score, parser_recovery, parser_recovery_status, parser_recovery_stage, parser_recovery_requested_at, parser_recovery_attempt_count, parser_recovery_last_attempt_at, parser_recovery_completed_at, parser_recovery_last_error, parser_diagnostics, parsed_document",
    )
    .eq(column, value)
    .limit(1)
    .maybeSingle<StoredContentRow>();

  if (error) {
    throw new Error(`Failed to load content row: ${error.message}`);
  }

  return data;
}
