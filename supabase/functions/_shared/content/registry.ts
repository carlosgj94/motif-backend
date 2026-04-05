import { processArchiveSnapshot } from "./adapters/archive_snapshot.ts";
import { processBloombergArticle } from "./adapters/bloomberg_article.ts";
import { processGenericArticle } from "./adapters/generic_article.ts";
import { processLiveBlog } from "./adapters/live_blog.ts";
import { processSubstackArticle } from "./adapters/substack_article.ts";
import { processXThread } from "./adapters/x_thread.ts";
import { type ContentRouteId, detectContentRoute } from "./detect.ts";
import type {
  FetchDocumentResult,
  ParseFetchedDocumentOptions,
  ProcessedContent,
} from "./model.ts";

type ContentRouteHandler = (
  fetched: FetchDocumentResult,
  options?: ParseFetchedDocumentOptions,
) => Promise<ProcessedContent>;

const ROUTE_HANDLERS: Record<ContentRouteId, ContentRouteHandler> = {
  "generic-article": processGenericArticle,
  "archive-snapshot": processArchiveSnapshot,
  "x-thread": processXThread,
  "live-blog": processLiveBlog,
  "bloomberg-article": processBloombergArticle,
  "substack-article": processSubstackArticle,
};

export async function parseFetchedDocumentWithRegistry(
  fetched: FetchDocumentResult,
  options: ParseFetchedDocumentOptions = {},
): Promise<ProcessedContent> {
  const route = detectContentRoute(fetched);
  return await ROUTE_HANDLERS[route](fetched, options);
}
