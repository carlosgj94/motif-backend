import http from "node:http";
import { timingSafeEqual } from "node:crypto";

import { HttpError } from "./errors.mjs";
import { validateRenderTargetUrl } from "./url_policy.mjs";

const ALLOWED_WAIT_UNTIL = new Set([
  "domcontentloaded",
  "load",
  "networkidle",
]);

export function createRendererServer({
  config,
  renderer,
  logger = console,
  validateTargetUrl = validateRenderTargetUrl,
}) {
  if (!config) {
    throw new Error("config is required");
  }
  if (!renderer || typeof renderer.renderDocument !== "function") {
    throw new Error("renderer.renderDocument is required");
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response, {
      config,
      renderer,
      logger,
      validateTargetUrl,
    }).catch((error) => {
      logServerError(logger, error);
      sendError(response, error);
    });
  });

  // Keep the public surface narrow; this service only accepts small JSON
  // requests and can close idle connections aggressively.
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return {
    server,
    start() {
      return startServer(server, config);
    },
    close() {
      return closeServer(server);
    },
  };
}

async function handleRequest(request, response, context) {
  const result = await dispatchRendererRequest({
    method: request.method,
    url: request.url,
    headers: request.headers,
    bodyText: await readRequestBody(
      request,
      context.config.maxRequestBytes,
    ),
  }, context);
  sendJson(response, result.status, result.payload);
}

export async function dispatchRendererRequest(request, context) {
  if (request.method === "GET" && request.url === "/health") {
    return {
      status: 200,
      payload: { ok: true },
    };
  }

  if (request.method === "POST" && request.url === "/render") {
    ensureAuthorizedHeaders(request.headers, context.config.secret);

    const body = parseJsonBody(
      request.bodyText,
      request.headers,
      context.config.maxRequestBytes,
    );
    const normalized = normalizeRenderRequest(body);
    const target = await context.validateTargetUrl(normalized.url, {
      allowedHosts: context.config.allowedHosts,
    });

    return {
      status: 200,
      payload: await context.renderer.renderDocument({
        url: target.url,
        waitUntil: normalized.waitUntil,
        timeoutMs: normalized.timeoutMs,
      }),
    };
  }

  return {
    status: 404,
    payload: { error: "not_found" },
  };
}

function ensureAuthorizedHeaders(headers, expectedSecret) {
  const providedSecret = headers["x-content-renderer-secret"];
  const provided = Array.isArray(providedSecret)
    ? providedSecret[0] ?? ""
    : providedSecret ?? "";
  if (!secretsEqual(provided, expectedSecret)) {
    throw new HttpError(401, "renderer secret was invalid");
  }
}

async function readRequestBody(request, maxRequestBytes) {
  const contentLength = Number.parseInt(
    String(request.headers["content-length"] ?? ""),
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    throw new HttpError(413, "request body exceeded size limit");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxRequestBytes) {
      throw new HttpError(413, "request body exceeded size limit");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return "";
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(bodyText, headers, maxRequestBytes) {
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "request content type must be application/json");
  }
  if (!bodyText) {
    throw new HttpError(400, "request body must not be empty");
  }
  if (Buffer.byteLength(bodyText, "utf8") > maxRequestBytes) {
    throw new HttpError(413, "request body exceeded size limit");
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

function normalizeRenderRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }

  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!url) {
    throw new HttpError(400, "url is required");
  }

  const waitUntil = normalizeWaitUntil(value.waitUntil);
  const timeoutMs = normalizeTimeoutMs(value.timeoutMs);

  return {
    url,
    waitUntil,
    timeoutMs,
  };
}

function normalizeWaitUntil(value) {
  if (value == null) {
    return "networkidle";
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "waitUntil must be a string");
  }

  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_WAIT_UNTIL.has(normalized)) {
    throw new HttpError(
      400,
      "waitUntil must be one of domcontentloaded, load, or networkidle",
    );
  }

  return normalized;
}

function normalizeTimeoutMs(value) {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, "timeoutMs must be a positive integer");
  }

  return value;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }

  if (error instanceof HttpError) {
    sendJson(response, error.status, {
      error: "request_failed",
      message: error.message,
    });
    return;
  }

  sendJson(response, 500, {
    error: "internal_error",
    message: "unexpected renderer failure",
  });
}

function secretsEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual), "utf8");
  const expectedBuffer = Buffer.from(String(expected), "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

async function startServer(server, config) {
  return await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.bindAddr);
  });
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function logServerError(logger, error) {
  if (!(error instanceof HttpError)) {
    logger.error?.("[content-renderer] unexpected error", error);
  }
}
