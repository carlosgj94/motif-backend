const DEFAULT_BIND_ADDR = "0.0.0.0";
const DEFAULT_PORT = 8788;
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;
const DEFAULT_MAX_HTML_BYTES = 3 * 1024 * 1024;
const DEFAULT_DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_CONCURRENCY = 2;

export function loadConfig(env = process.env) {
  const secret = (env.CONTENT_RENDERER_SECRET ?? "").trim();
  if (!secret) {
    throw new Error("CONTENT_RENDERER_SECRET must be set");
  }

  return {
    bindAddr: (env.CONTENT_RENDERER_BIND_ADDR ?? DEFAULT_BIND_ADDR).trim() ||
      DEFAULT_BIND_ADDR,
    port: parsePositiveInt(
      env.CONTENT_RENDERER_PORT ?? env.PORT,
      DEFAULT_PORT,
    ),
    secret,
    maxRequestBytes: parsePositiveInt(
      env.CONTENT_RENDERER_MAX_REQUEST_BYTES,
      DEFAULT_MAX_REQUEST_BYTES,
    ),
    maxHtmlBytes: parsePositiveInt(
      env.CONTENT_RENDERER_MAX_HTML_BYTES,
      DEFAULT_MAX_HTML_BYTES,
    ),
    defaultTimeoutMs: parsePositiveInt(
      env.CONTENT_RENDERER_DEFAULT_TIMEOUT_MS,
      DEFAULT_DEFAULT_TIMEOUT_MS,
    ),
    maxTimeoutMs: parsePositiveInt(
      env.CONTENT_RENDERER_MAX_TIMEOUT_MS,
      DEFAULT_MAX_TIMEOUT_MS,
    ),
    maxConcurrency: parsePositiveInt(
      env.CONTENT_RENDERER_MAX_CONCURRENCY,
      DEFAULT_MAX_CONCURRENCY,
    ),
    allowedHosts: parseCsvSet(env.CONTENT_RENDERER_ALLOWED_HOSTS),
  };
}

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsvSet(rawValue) {
  return new Set(
    (rawValue ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}
