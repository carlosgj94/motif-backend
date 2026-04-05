import type { FaviconResult, ParserRecoveryDecision } from "./model.ts";

export interface ClaimedRecoveryRow {
  id: string;
  canonical_url: string;
  resolved_url: string | null;
  host: string;
  source_kind: string | null;
  title: string | null;
  excerpt: string | null;
  author: string | null;
  published_at: string | null;
  language_code: string | null;
  site_name: string | null;
  cover_image_url: string | null;
  favicon_bytes: string | null;
  favicon_mime_type: string | null;
  favicon_source_url: string | null;
  favicon_fetched_at: string | null;
  parsed_document: Record<string, unknown> | null;
  parser_name: string | null;
  parser_version: string | null;
  parser_quality_score: number | null;
  parser_recovery: ParserRecoveryDecision | null;
  parser_recovery_status: string;
  parser_recovery_stage: string | null;
  fetch_etag: string | null;
  fetch_last_modified: string | null;
  parser_recovery_attempt_count: number;
}

export function faviconFromClaim(
  claimed: Pick<
    ClaimedRecoveryRow,
    | "favicon_bytes"
    | "favicon_mime_type"
    | "favicon_source_url"
    | "favicon_fetched_at"
    | "resolved_url"
    | "canonical_url"
  >,
): FaviconResult | null {
  if (!claimed.favicon_bytes || !claimed.favicon_mime_type) {
    return null;
  }

  return {
    byteaHex: claimed.favicon_bytes,
    mimeType: claimed.favicon_mime_type,
    sourceUrl: claimed.favicon_source_url ?? claimed.resolved_url ??
      claimed.canonical_url,
    fetchedAt: claimed.favicon_fetched_at ?? new Date().toISOString(),
  };
}

export function normalizeRetryCount(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.trunc(value)
    : 0;
}
