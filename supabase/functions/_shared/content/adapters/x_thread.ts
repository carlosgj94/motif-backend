import {
  MAX_AUTHOR_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_LANGUAGE_CODE_CHARS,
  MAX_TITLE_CHARS,
  PARSED_DOCUMENT_VERSION,
  PARSER_VERSION,
} from "../config.ts";
import { buildParserDiagnostics } from "../diagnostics.ts";
import type {
  FetchDocumentResult,
  ParseFetchedDocumentOptions,
  ProcessedContent,
} from "../model.ts";
import { ProcessingFailure } from "../model.ts";
import {
  buildBaseUpdate,
  collectMetadata,
  deriveParsedDocumentMetrics,
  enforceParsedDocumentSizeLimit,
  parseDocument,
  sanitizeParsedBlocks,
  trimText,
  trimUrl,
} from "../normalize.ts";
import { selectBestXContent } from "../x_content_heuristics.ts";

const PARSER_NAME = "x-content";

export async function processXThread(
  fetched: FetchDocumentResult,
  options: ParseFetchedDocumentOptions = {},
): Promise<ProcessedContent> {
  const document = parseDocument(fetched.html);
  const metadata = collectMetadata(document);
  const favicon =
    await options.faviconFetcher?.(document, fetched.resolvedUrl) ?? null;
  let selected = selectBestXContent({
    document,
    resolvedUrl: fetched.resolvedUrl,
    metadata,
  });
  let syndicatedPost = null;
  if (!selected || selected.sourceKind === "post") {
    syndicatedPost = await options.xSyndicationFetcher?.(fetched.resolvedUrl) ??
      null;
    if (syndicatedPost) {
      selected = selectBestXContent({
        document,
        resolvedUrl: fetched.resolvedUrl,
        metadata,
        syndicatedPost,
      }) ?? selected;
    }
  }
  if (!selected) {
    const fromOEmbed = await options.xOEmbedFetcher?.(fetched.resolvedUrl) ??
      null;
    if (fromOEmbed) {
      selected = selectBestXContent({
        document,
        resolvedUrl: fetched.resolvedUrl,
        metadata: {
          ...metadata,
          description: metadata.description ?? fromOEmbed.text,
          coverImageUrl: metadata.coverImageUrl ?? fromOEmbed.media[0]?.url ??
            null,
        },
        oEmbedPost: fromOEmbed,
        syndicatedPost,
      }) ?? {
        sourceKind: "post",
        title: fromOEmbed.text,
        excerpt: fromOEmbed.text,
        author: fromOEmbed.display_name ?? fromOEmbed.author_handle ?? null,
        publishedAt: fromOEmbed.published_at ?? metadata.publishedAt,
        coverImageUrl: trimUrl(
          fromOEmbed.media.find((item) => item.kind === "image")?.url ??
            metadata.coverImageUrl,
        ),
        blocks: [fromOEmbed],
      };
    }
  }

  const title = trimText(
    selected?.title ?? metadata.title ?? null,
    MAX_TITLE_CHARS,
  );
  const excerpt = trimText(
    selected?.excerpt ?? metadata.description ?? null,
    MAX_EXCERPT_CHARS,
  );
  const author = trimText(
    selected?.author ?? null,
    MAX_AUTHOR_CHARS,
  );
  const sourceKind = selected?.sourceKind ?? "post";
  const publishedAt = selected?.publishedAt ?? metadata.publishedAt;
  const languageCode = trimText(metadata.languageCode, MAX_LANGUAGE_CODE_CHARS);
  const coverImageUrl = trimUrl(
    selected?.coverImageUrl ?? metadata.coverImageUrl,
  );
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

  if (!selected || selected.blocks.length === 0) {
    throw ProcessingFailure.parse(
      "Could not recover post or thread content from X",
      {
        httpStatus: fetched.status,
        retryable: false,
        partialUpdate: baseUpdate,
      },
    );
  }

  const sanitizedBlocks = sanitizeParsedBlocks(selected.blocks);
  if (sanitizedBlocks.length === 0) {
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
    version: PARSED_DOCUMENT_VERSION,
    kind: sourceKind,
    title,
    byline: author,
    published_at: publishedAt,
    language_code: languageCode,
    blocks: sanitizedBlocks,
  }, baseUpdate);
  const metrics = deriveParsedDocumentMetrics(parsedDocument);
  const parserDiagnostics = buildParserDiagnostics({
    route: PARSER_NAME,
    parserName: PARSER_NAME,
    selectedStrategyId: selected ? `${selected.sourceKind}-selection` : null,
    parsedDocument,
    sourceKind,
    candidates: selected
      ? [{
        id: `${selected.sourceKind}-selection`,
        selected: true,
        qualityScore: null,
        totalScore: null,
        blocks: sanitizedBlocks,
        sourceKind,
        notes: [
          syndicatedPost ? "syndication-available" : "syndication-absent",
          sourceKind,
        ],
      }]
      : [],
  });

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
    sourceDiscoveryUrl: null,
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
    parserDiagnostics,
  };
}
