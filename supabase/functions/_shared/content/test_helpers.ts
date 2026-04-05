import type {
  FetchDocumentResult,
  ParseFetchedDocumentOptions,
  ProcessedContent,
} from "../content_processor.ts";
import { xPostFromOEmbedPayload } from "./normalize.ts";
import { xPostFromSyndicationPayload } from "./x_syndication.ts";

export interface ContentFixtureContext {
  resolvedUrl: string;
  status: number;
  fetchedAt: string;
  originalUrl: string | null;
}

export interface LoadedContentFixture {
  id: string;
  provider: string;
  name: string;
  html: string;
  context: ContentFixtureContext;
  expectedParsed: Record<string, unknown>;
  expectedCompact: Record<string, unknown>;
  xOEmbedPayload: unknown | null;
  xSyndicationPayload: unknown | null;
}

export interface ContentFixtureRef {
  provider: string;
  name: string;
}

export function fixtureRootUrl(): URL {
  return new URL("../../../../tests/fixtures/content/", import.meta.url);
}

function fixtureDirUrl(provider: string, name: string): URL {
  return new URL(`${provider}/${name}/`, fixtureRootUrl());
}

async function readFixtureJson(
  provider: string,
  name: string,
  fileName: string,
): Promise<unknown> {
  const url = new URL(fileName, fixtureDirUrl(provider, name));
  return JSON.parse(await Deno.readTextFile(url));
}

async function readOptionalFixtureJson(
  provider: string,
  name: string,
  fileName: string,
): Promise<unknown | null> {
  try {
    return await readFixtureJson(provider, name, fileName);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

export async function loadContentFixture(
  provider: string,
  name: string,
): Promise<LoadedContentFixture> {
  const dir = fixtureDirUrl(provider, name);
  const context = await readFixtureJson(
    provider,
    name,
    "headers.json",
  ) as unknown as ContentFixtureContext;

  return {
    id: `${provider}/${name}`,
    provider,
    name,
    html: await Deno.readTextFile(new URL("raw.html", dir)),
    context,
    expectedParsed: await readFixtureJson(
      provider,
      name,
      "expected.parsed.json",
    ) as Record<string, unknown>,
    expectedCompact: await readFixtureJson(
      provider,
      name,
      "expected.compact.json",
    ) as Record<string, unknown>,
    xOEmbedPayload: await readOptionalFixtureJson(
      provider,
      name,
      "x_oembed.json",
    ),
    xSyndicationPayload: await readOptionalFixtureJson(
      provider,
      name,
      "x_syndication.json",
    ),
  };
}

export async function listContentFixtures(): Promise<ContentFixtureRef[]> {
  const fixtures: ContentFixtureRef[] = [];

  for await (const providerEntry of Deno.readDir(fixtureRootUrl())) {
    if (!providerEntry.isDirectory) {
      continue;
    }

    const provider = providerEntry.name;
    const providerUrl = new URL(`${provider}/`, fixtureRootUrl());
    for await (const fixtureEntry of Deno.readDir(providerUrl)) {
      if (!fixtureEntry.isDirectory) {
        continue;
      }

      fixtures.push({
        provider,
        name: fixtureEntry.name,
      });
    }
  }

  return fixtures.sort((left, right) =>
    left.provider.localeCompare(right.provider) ||
    left.name.localeCompare(right.name)
  );
}

export function buildFetchedDocumentResult(
  fixture: LoadedContentFixture,
): FetchDocumentResult {
  return {
    resolvedUrl: fixture.context.resolvedUrl,
    host: new URL(fixture.context.resolvedUrl).hostname.toLowerCase(),
    html: fixture.html,
    status: fixture.context.status,
    fetchedAt: fixture.context.fetchedAt,
    originalUrl: fixture.context.originalUrl,
    etag: null,
    lastModified: null,
    notModified: false,
  };
}

export function buildFixtureParseOptions(
  fixture: LoadedContentFixture,
): ParseFetchedDocumentOptions {
  return {
    faviconFetcher: async () => null,
    xOEmbedFetcher: async (resolvedUrl) =>
      fixture.xOEmbedPayload
        ? xPostFromOEmbedPayload(fixture.xOEmbedPayload, resolvedUrl)
        : null,
    xSyndicationFetcher: async (resolvedUrl) =>
      fixture.xSyndicationPayload
        ? xPostFromSyndicationPayload(fixture.xSyndicationPayload, resolvedUrl)
        : null,
  };
}

export function toComparableProcessedContent(
  processed: ProcessedContent,
): Record<string, unknown> {
  return {
    sourceKind: processed.sourceKind,
    title: processed.title,
    excerpt: processed.excerpt,
    author: processed.author,
    publishedAt: processed.publishedAt,
    languageCode: processed.languageCode,
    siteName: processed.siteName,
    coverImageUrl: processed.coverImageUrl,
    parsedDocument: processed.parsedDocument,
  };
}
