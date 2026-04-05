export type Document = any;
export type Element = any;

export type ProcessingStage = "fetch" | "parse";
export type SourceKind = "article" | "thread" | "post";

export interface FaviconResult {
  byteaHex: string;
  mimeType: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface ThreadMediaItem {
  kind: "image" | "video";
  url: string;
  alt: string | null;
}

export interface ThreadPostBlock {
  type: "thread_post";
  post_id: string | null;
  author_handle: string | null;
  display_name: string | null;
  published_at: string | null;
  text: string;
  media: ThreadMediaItem[];
}

export interface XSyndicatedArticle {
  articleId: string | null;
  title: string | null;
  previewText: string | null;
  coverImageUrl: string | null;
  url: string | null;
}

export interface XSyndicatedPost {
  postId: string | null;
  authorHandle: string | null;
  displayName: string | null;
  publishedAt: string | null;
  text: string | null;
  media: ThreadMediaItem[];
  noteTweetId: string | null;
  article: XSyndicatedArticle | null;
}

export type ParsedBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; style: "bulleted" | "numbered"; items: string[] }
  | { type: "code"; language: string | null; text: string }
  | { type: "image"; url: string; alt: string | null; caption: string | null }
  | ThreadPostBlock;

export interface ParserByteBudgetDiagnostics {
  parsedDocumentBytes: number;
  parsedDocumentBudgetBytes: number;
  parsedDocumentBudgetRatio: number;
  compactBodyBytes: number | null;
  compactBodyBudgetBytes: number | null;
  compactBodyBudgetRatio: number | null;
}

export interface ParserCandidateDiagnostics {
  id: string;
  selected: boolean;
  qualityScore: number | null;
  totalScore: number | null;
  blockCount: number;
  wordCount: number;
  imageCount: number;
  compactBodyBytes: number | null;
  parsedDocumentBytes: number;
  notes: string[];
}

export interface ParserDiagnostics {
  route: string;
  parserName: string;
  parserVersion: string;
  selectedStrategyId: string | null;
  bytes: ParserByteBudgetDiagnostics;
  candidates: ParserCandidateDiagnostics[];
  warnings: string[];
}

export interface ParserRecoveryDecision {
  shouldRecover: boolean;
  priority: "low" | "high" | null;
  qualityScore: number | null;
  route: string | null;
  selectedStrategyId: string | null;
  reasons: string[];
}

export type ParserRecoveryStage = "static" | "rendered";

export interface ProcessedContent {
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
  sourceDiscoveryUrl: string | null;
  parserName: string;
  parserVersion: string;
  parserDiagnostics: ParserDiagnostics | null;
}

export interface PartialContentUpdate {
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
  fetch_etag?: string | null;
  fetch_last_modified?: string | null;
  last_http_status?: number | null;
  last_successful_fetch_at?: string | null;
}

export interface ArchiveSnapshot {
  sourceUrl: string | null;
  sourceHost: string | null;
  siteName: string | null;
  title: string | null;
  description: string | null;
  author: string | null;
  publishedAt: string | null;
  coverImageUrl: string | null;
  articleHtml: string | null;
}

export interface FetchDocumentResult {
  resolvedUrl: string;
  host: string;
  html: string;
  status: number;
  fetchedAt: string;
  originalUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

export interface ParseFetchedDocumentOptions {
  faviconFetcher?: (
    document: Document,
    resolvedUrl: string,
  ) => Promise<FaviconResult | null>;
  xOEmbedFetcher?: (resolvedUrl: string) => Promise<ThreadPostBlock | null>;
  xSyndicationFetcher?: (
    resolvedUrl: string,
  ) => Promise<XSyndicatedPost | null>;
}

export type DnsRecordType = "A" | "AAAA";
export type ResolveDnsFn = (
  hostname: string,
  recordType: DnsRecordType,
) => Promise<string[]>;
export type FetchImpl = typeof fetch;

export interface NetworkPolicy {
  fetchImpl?: FetchImpl;
  resolveDns?: ResolveDnsFn;
}

export interface ContentMetadata {
  title: string | null;
  description: string | null;
  author: string | null;
  publishedAt: string | null;
  languageCode: string | null;
  coverImageUrl: string | null;
  siteName: string | null;
}

export class ProcessingFailure extends Error {
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
