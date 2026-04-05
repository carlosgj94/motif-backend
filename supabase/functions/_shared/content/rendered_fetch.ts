import {
  maxRenderedResponseBytes,
  renderedFetchTimeoutMs,
  safeEnvGet,
} from "./config.ts";
import { readResponseText } from "./fetch.ts";
import type { FetchDocumentResult } from "./model.ts";
import { ProcessingFailure } from "./model.ts";

export interface RenderedFetchOptions {
  rendererUrl?: string | null;
  rendererSecret?: string | null;
  fetchImpl?: typeof fetch;
}

interface RendererResponsePayload {
  resolvedUrl?: unknown;
  status?: unknown;
  html?: unknown;
  originalUrl?: unknown;
}

export function isRenderedFetchConfigured(
  options: Pick<RenderedFetchOptions, "rendererUrl" | "rendererSecret"> = {},
): boolean {
  return Boolean(resolveRendererUrl(options) && resolveRendererSecret(options));
}

export async function fetchRenderedDocument(
  targetUrl: string,
  options: RenderedFetchOptions = {},
): Promise<FetchDocumentResult> {
  const rendererUrl = resolveRendererUrl(options);
  const rendererSecret = resolveRendererSecret(options);
  if (!rendererUrl || !rendererSecret) {
    throw ProcessingFailure.fetch(
      "Rendered recovery is not configured",
      {
        retryable: false,
      },
    );
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(rendererUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-content-renderer-secret": rendererSecret,
      },
      body: JSON.stringify({
        url: targetUrl,
        waitUntil: "networkidle",
        timeoutMs: renderedFetchTimeoutMs,
      }),
      signal: AbortSignal.timeout(renderedFetchTimeoutMs),
    });
  } catch (error) {
    throw ProcessingFailure.fetch("Rendered recovery request failed", {
      retryable: true,
      cause: error,
    });
  }

  if (!response.ok) {
    throw ProcessingFailure.fetch(
      `Rendered recovery returned HTTP ${response.status}`,
      {
        httpStatus: response.status,
        retryable: response.status >= 500 || response.status === 429,
      },
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw ProcessingFailure.fetch(
      "Rendered recovery did not return JSON content",
      {
        httpStatus: response.status,
        retryable: false,
      },
    );
  }

  const payload = parseRendererPayload(
    await readResponseText(
      response,
      maxRenderedResponseBytes,
      "Rendered recovery response",
    ),
    response.status,
  );
  const resolvedUrl = normalizeUrlString(payload.resolvedUrl) ?? targetUrl;
  const host = safeHost(resolvedUrl);
  const html = normalizeHtmlString(payload.html);

  if (!host) {
    throw ProcessingFailure.fetch(
      "Rendered recovery resolved URL host was invalid",
      {
        httpStatus: response.status,
        retryable: false,
      },
    );
  }
  if (!html) {
    throw ProcessingFailure.fetch(
      "Rendered recovery returned an empty HTML document",
      {
        httpStatus: response.status,
        retryable: false,
      },
    );
  }

  return {
    resolvedUrl,
    host,
    html,
    contentType: "text/html; charset=utf-8",
    status: normalizeStatus(payload.status) ?? 200,
    fetchedAt: new Date().toISOString(),
    originalUrl: normalizeUrlString(payload.originalUrl),
    etag: null,
    lastModified: null,
    notModified: false,
  };
}

function resolveRendererUrl(
  options: Pick<RenderedFetchOptions, "rendererUrl">,
): string | null {
  const candidate = options.rendererUrl ?? safeEnvGet("CONTENT_RENDERER_URL");
  return normalizeUrlString(candidate);
}

function resolveRendererSecret(
  options: Pick<RenderedFetchOptions, "rendererSecret">,
): string | null {
  const candidate = options.rendererSecret ??
    safeEnvGet("CONTENT_RENDERER_SECRET");
  const trimmed = candidate?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function parseRendererPayload(
  raw: string,
  httpStatus: number,
): RendererResponsePayload {
  try {
    return JSON.parse(raw) as RendererResponsePayload;
  } catch (error) {
    throw ProcessingFailure.fetch(
      "Rendered recovery returned invalid JSON",
      {
        httpStatus,
        retryable: false,
        cause: error,
      },
    );
  }
}

function normalizeStatus(value: unknown): number | null {
  return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599
    ? value
    : null;
}

function normalizeHtmlString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeUrlString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
