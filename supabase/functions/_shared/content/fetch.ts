import {
  archiveMirrorHosts,
  httpTimeoutMs,
  maxHtmlBytes,
  maxRedirects,
  USER_AGENT,
} from "./config.ts";
import { isArchiveHost } from "./detect.ts";
import {
  type DnsRecordType,
  type FetchImpl,
  type FetchDocumentResult,
  type NetworkPolicy,
  ProcessingFailure,
  type ResolveDnsFn,
} from "./model.ts";

const DNS_OVER_HTTPS_URL = "https://cloudflare-dns.com/dns-query";

export async function fetchDocument(
  url: string,
  policy: NetworkPolicy = {},
  conditional: {
    etag?: string | null;
    lastModified?: string | null;
  } = {},
): Promise<FetchDocumentResult> {
  const archiveCandidates = buildArchiveMirrorCandidates(url);
  let lastArchiveResponse:
    | { response: Response; resolvedUrl: string }
    | null = null;
  let lastArchiveFailure: ProcessingFailure | null = null;

  for (let index = 0; index < archiveCandidates.length; index += 1) {
    const candidateUrl = archiveCandidates[index];
    const hasFallbackCandidate = index < archiveCandidates.length - 1;

    try {
      const { response, resolvedUrl } = await performValidatedFetch(
        candidateUrl,
        {
          policy,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          headers: buildConditionalHeaders(conditional),
          maxRedirects,
        },
      );

      if (
        hasFallbackCandidate &&
        response.status === 429 &&
        isArchiveHost(safeHost(resolvedUrl) ?? "")
      ) {
        lastArchiveResponse = { response, resolvedUrl };
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      const resolvedHost = safeHost(resolvedUrl);
      if (!resolvedHost) {
        throw ProcessingFailure.fetch("Resolved URL host was invalid", {
          httpStatus: response.status,
          retryable: false,
        });
      }

      if (response.status === 304) {
        return {
          resolvedUrl,
          host: resolvedHost,
          html: "",
          status: response.status,
          fetchedAt: new Date().toISOString(),
          originalUrl: extractOriginalUrlFromLinkHeaderValue(
            isArchiveHost(resolvedHost) ? response.headers.get("link") : null,
          ),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          notModified: true,
        };
      }

      if (!response.ok) {
        throw ProcessingFailure.fetch(
          `Source URL returned HTTP ${response.status}`,
          {
            httpStatus: response.status,
            retryable: response.status === 429 || response.status >= 500,
          },
        );
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ??
        "";
      if (!contentType.includes("html")) {
        throw ProcessingFailure.fetch(
          "Source URL did not return HTML content",
          {
            httpStatus: response.status,
            retryable: false,
          },
        );
      }

      const html = await readResponseText(
        response,
        maxHtmlBytes,
        "Source HTML body",
      );

      return {
        resolvedUrl,
        host: resolvedHost,
        html,
        status: response.status,
        fetchedAt: new Date().toISOString(),
        originalUrl: extractOriginalUrlFromLinkHeaderValue(
          isArchiveHost(resolvedHost) ? response.headers.get("link") : null,
        ),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        notModified: false,
      };
    } catch (error) {
      if (
        hasFallbackCandidate &&
        error instanceof ProcessingFailure &&
        error.stage === "fetch" &&
        error.retryable
      ) {
        lastArchiveFailure = error;
        continue;
      }

      throw error;
    }
  }

  if (lastArchiveResponse) {
    const { response } = lastArchiveResponse;
    throw ProcessingFailure.fetch(
      `Source URL returned HTTP ${response.status}`,
      {
        httpStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }
  if (lastArchiveFailure) {
    throw lastArchiveFailure;
  }

  throw ProcessingFailure.fetch("Request to source URL failed", {
    retryable: true,
  });
}

function buildConditionalHeaders(input: {
  etag?: string | null;
  lastModified?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input.etag) {
    headers["if-none-match"] = input.etag;
  }
  if (input.lastModified) {
    headers["if-modified-since"] = input.lastModified;
  }

  return headers;
}

export async function performValidatedFetch(
  initialUrl: string,
  input: {
    policy?: NetworkPolicy;
    accept?: string;
    headers?: Record<string, string>;
    maxRedirects: number;
    trustedHosts?: Set<string>;
  },
): Promise<{ response: Response; resolvedUrl: string }> {
  const fetchImpl = input.policy?.fetchImpl ?? fetch;
  const resolveDns = input.policy?.resolveDns ?? resolvePublicDns;
  let currentUrl = initialUrl;

  for (
    let redirectCount = 0;
    redirectCount <= input.maxRedirects;
    redirectCount += 1
  ) {
    const validated = await validateFetchTargetUrl(currentUrl, {
      resolveDns,
      trustedHosts: input.trustedHosts,
    });

    let response: Response;
    try {
      const headers = new Headers(input.headers ?? {});
      if (input.accept && !headers.has("accept")) {
        headers.set("accept", input.accept);
      }
      if (!headers.has("user-agent")) {
        headers.set("user-agent", USER_AGENT);
      }
      response = await fetchImpl(validated.url, {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(httpTimeoutMs),
      });
    } catch (error) {
      throw ProcessingFailure.fetch("Request to source URL failed", {
        retryable: true,
        cause: error,
      });
    }

    if (!isRedirectStatus(response.status)) {
      return { response, resolvedUrl: validated.url };
    }

    if (redirectCount === input.maxRedirects) {
      throw ProcessingFailure.fetch("Source URL redirected too many times", {
        httpStatus: response.status,
        retryable: false,
      });
    }

    const location = response.headers.get("location");
    const nextUrl = resolveUrl(validated.url, location);
    if (!nextUrl) {
      throw ProcessingFailure.fetch(
        "Source URL redirect location was invalid",
        {
          httpStatus: response.status,
          retryable: false,
        },
      );
    }

    currentUrl = nextUrl;
  }

  throw ProcessingFailure.fetch("Source URL redirected too many times", {
    retryable: false,
  });
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  bodyLabel: string,
): Promise<string> {
  const bytes = await readResponseBytes(response, maxBytes, bodyLabel);
  try {
    return new TextDecoder().decode(bytes);
  } catch (error) {
    throw ProcessingFailure.fetch(`${bodyLabel} could not be decoded`, {
      httpStatus: response.status,
      retryable: false,
      cause: error,
    });
  }
}

export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  bodyLabel: string,
): Promise<Uint8Array> {
  const contentLength = parseContentLength(
    response.headers.get("content-length"),
  );
  if (contentLength !== null && contentLength > maxBytes) {
    throw ProcessingFailure.fetch(`${bodyLabel} exceeded the size limit`, {
      httpStatus: response.status,
      retryable: false,
    });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw ProcessingFailure.fetch(`${bodyLabel} exceeded the size limit`, {
        httpStatus: response.status,
        retryable: false,
      });
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

interface ValidateFetchTargetOptions {
  resolveDns?: ResolveDnsFn;
  trustedHosts?: Set<string>;
}

export async function validateFetchTargetUrl(
  url: string,
  options: ValidateFetchTargetOptions = {},
): Promise<{ url: string; host: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw ProcessingFailure.fetch("Source URL was invalid", {
      retryable: false,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw ProcessingFailure.fetch("Source URL must use http or https", {
      retryable: false,
    });
  }

  if (parsed.username || parsed.password) {
    throw ProcessingFailure.fetch(
      "Source URL must not include username or password",
      {
        retryable: false,
      },
    );
  }

  const defaultPort = parsed.protocol === "http:" ? "80" : "443";
  if (parsed.port && parsed.port !== defaultPort) {
    throw ProcessingFailure.fetch("Source URL must use the default port", {
      retryable: false,
    });
  }

  parsed.hash = "";
  if (parsed.port === defaultPort) {
    parsed.port = "";
  }

  const host = normalizeHostValue(parsed.hostname);
  if (!host) {
    throw ProcessingFailure.fetch("Source URL must include a host", {
      retryable: false,
    });
  }

  if (
    options.trustedHosts && options.trustedHosts.size > 0 &&
    !options.trustedHosts.has(host)
  ) {
    throw ProcessingFailure.fetch("Source URL host is not allowed", {
      retryable: false,
    });
  }

  if (!options.trustedHosts?.has(host) && isDisallowedHostname(host)) {
    throw ProcessingFailure.fetch("Source URL host is not allowed", {
      retryable: false,
    });
  }

  if (isIpLiteral(host)) {
    if (!isPublicIpLiteral(host)) {
      throw ProcessingFailure.fetch(
        "Source URL host must resolve to a public address",
        {
          retryable: false,
        },
      );
    }

    return { url: parsed.toString(), host };
  }

  await validateResolvedHost(host, options.resolveDns ?? resolvePublicDns);
  return { url: parsed.toString(), host };
}

export function isDisallowedHostname(host: string): boolean {
  const normalized = normalizeHostValue(host);
  if (!normalized) {
    return true;
  }

  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  return !normalized.includes(".") && !isIpLiteral(normalized);
}

export function isPublicIpLiteral(host: string): boolean {
  const normalized = normalizeHostValue(host);
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isPublicIpv4(ipv4);
  }

  const ipv6 = parseIpv6(normalized);
  if (ipv6) {
    return isPublicIpv6(ipv6);
  }

  return false;
}

function extractOriginalUrlFromLinkHeaderValue(
  value: string | null,
): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/<([^>]+)>\s*;\s*rel="original"/i);
  return match?.[1] ?? null;
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308;
}

function resolveUrl(
  baseUrl: string,
  maybeUrl: string | null | undefined,
): string | null {
  if (!maybeUrl) {
    return null;
  }

  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

async function validateResolvedHost(
  host: string,
  resolveDns: ResolveDnsFn,
): Promise<void> {
  const resolvedAddresses = new Set<string>();

  for (const recordType of ["A", "AAAA"] as const) {
    try {
      const results = await resolveDns(host, recordType);
      for (const result of results) {
        resolvedAddresses.add(normalizeHostValue(result));
      }
    } catch (error) {
      if (isDnsNoDataError(error)) {
        continue;
      }

      throw ProcessingFailure.fetch("Source URL host could not be resolved", {
        retryable: true,
        cause: error,
      });
    }
  }

  if (resolvedAddresses.size === 0) {
    throw ProcessingFailure.fetch("Source URL host could not be resolved", {
      retryable: false,
    });
  }

  for (const address of resolvedAddresses) {
    if (!isPublicIpLiteral(address)) {
      throw ProcessingFailure.fetch(
        "Source URL host must resolve to a public address",
        {
          retryable: false,
        },
      );
    }
  }
}

async function resolvePublicDns(
  hostname: string,
  recordType: DnsRecordType,
): Promise<string[]> {
  try {
    return await Deno.resolveDns(hostname, recordType) as string[];
  } catch (error) {
    if (isDnsNoDataError(error)) {
      return [];
    }

    return await resolveDnsOverHttps(hostname, recordType);
  }
}

export async function resolveDnsOverHttps(
  hostname: string,
  recordType: DnsRecordType,
  fetchImpl: FetchImpl = fetch,
): Promise<string[]> {
  const endpoint = new URL(DNS_OVER_HTTPS_URL);
  endpoint.searchParams.set("name", hostname);
  endpoint.searchParams.set("type", recordType);

  let response: Response;
  try {
    response = await fetchImpl(endpoint.toString(), {
      headers: {
        accept: "application/dns-json",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
  } catch (error) {
    throw new Error(
      `DNS-over-HTTPS lookup failed for ${hostname}: ${String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `DNS-over-HTTPS lookup failed for ${hostname} with HTTP ${response.status}`,
    );
  }

  return parseDnsOverHttpsAnswers(await response.json(), recordType);
}

export function parseDnsOverHttpsAnswers(
  payload: unknown,
  recordType: DnsRecordType,
): string[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("DNS-over-HTTPS response was invalid");
  }

  const response = payload as {
    Status?: unknown;
    Answer?: unknown;
  };
  if (typeof response.Status === "number" && response.Status !== 0) {
    if (response.Status === 3) {
      return [];
    }

    throw new Error(
      `DNS-over-HTTPS lookup failed with status ${response.Status}`,
    );
  }

  if (!Array.isArray(response.Answer)) {
    return [];
  }

  const expectedType = recordType === "A" ? 1 : 28;
  return response.Answer.flatMap((answer) => {
    if (!answer || typeof answer !== "object") {
      return [];
    }

    const record = answer as {
      type?: unknown;
      data?: unknown;
    };
    if (record.type !== expectedType || typeof record.data !== "string") {
      return [];
    }

    return [record.data];
  });
}

function isDnsNoDataError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();
  return message.includes("no data") ||
    message.includes("nodata") ||
    message.includes("not found") ||
    message.includes("nxdomain");
}

function normalizeHostValue(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return null;
  }

  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return parts;
}

function isPublicIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) {
    return false;
  }

  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }

  if (a === 169 && b === 254) {
    return false;
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }

  if (a === 192 && b === 168) {
    return false;
  }

  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return false;
  }

  if (a === 198 && (b === 18 || b === 19)) {
    return false;
  }

  if (a === 198 && b === 51 && c === 100) {
    return false;
  }

  if (a === 203 && b === 0 && c === 113) {
    return false;
  }

  if (a >= 224 || a >= 240) {
    return false;
  }

  return true;
}

function parseIpv6(host: string): number[] | null {
  let normalized = host.trim().toLowerCase();
  if (!normalized.includes(":")) {
    return null;
  }

  if (normalized.includes("%")) {
    return null;
  }

  let ipv4Tail: number[] | null = null;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) {
      return null;
    }

    ipv4Tail = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4Tail) {
      return null;
    }

    normalized = `${normalized.slice(0, lastColon)}:${
      ((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16)
    }:${((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16)}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":").filter(Boolean)
    : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(":").filter(Boolean)
    : [];
  const missing = 8 - (left.length + right.length);
  if ((doubleColonParts.length === 1 && left.length !== 8) || missing < 0) {
    return null;
  }

  const parts = [
    ...left,
    ...Array.from(
      { length: doubleColonParts.length === 2 ? missing : 0 },
      () => "0",
    ),
    ...right,
  ];
  if (parts.length !== 8) {
    return null;
  }

  const parsed = parts.map((part) => Number.parseInt(part, 16));
  if (
    parsed.some((part, index) =>
      !/^[0-9a-f]{1,4}$/i.test(parts[index]) || !Number.isInteger(part) ||
      part < 0 || part > 0xffff
    )
  ) {
    return null;
  }

  return parsed;
}

function isPublicIpv6(parts: number[]): boolean {
  const allZero = parts.every((part) => part === 0);
  if (allZero) {
    return false;
  }

  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) {
    return false;
  }

  if ((parts[0] & 0xfe00) === 0xfc00) {
    return false;
  }

  if ((parts[0] & 0xffc0) === 0xfe80) {
    return false;
  }

  if ((parts[0] & 0xff00) === 0xff00) {
    return false;
  }

  if (parts[0] === 0x2001 && parts[1] === 0x0db8) {
    return false;
  }

  if (parts[0] === 0x2001 && parts[1] === 0x0002 && parts[2] === 0x0000) {
    return false;
  }

  const isIpv4Mapped = parts[0] === 0 &&
    parts[1] === 0 &&
    parts[2] === 0 &&
    parts[3] === 0 &&
    parts[4] === 0 &&
    parts[5] === 0xffff;
  if (isIpv4Mapped) {
    const ipv4 = [
      parts[6] >> 8,
      parts[6] & 0xff,
      parts[7] >> 8,
      parts[7] & 0xff,
    ];
    return isPublicIpv4(ipv4);
  }

  return true;
}

function safeHost(url: string): string | null {
  try {
    return normalizeHostValue(new URL(url).hostname);
  } catch {
    return null;
  }
}

function buildArchiveMirrorCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }

  const normalizedHost = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!isArchiveHost(normalizedHost)) {
    return [url];
  }

  return [
    url,
    ...archiveMirrorHosts
      .filter((host) => host !== normalizedHost)
      .map((host) => {
        const nextUrl = new URL(parsed.toString());
        nextUrl.hostname = host;
        return nextUrl.toString();
      }),
  ];
}
