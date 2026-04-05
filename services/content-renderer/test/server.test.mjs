import test from "node:test";
import assert from "node:assert/strict";

import { dispatchRendererRequest } from "../src/server.mjs";

test("health endpoint is public", async () => {
  const response = await dispatchRendererRequest({
    method: "GET",
    url: "/health",
    headers: {},
    bodyText: "",
  }, createContext());

  assert.deepEqual(response, {
    status: 200,
    payload: { ok: true },
  });
});

test("render endpoint requires the shared secret", async () => {
  await assert.rejects(
    dispatchRendererRequest({
      method: "POST",
      url: "/render",
      headers: {
        "content-type": "application/json",
      },
      bodyText: JSON.stringify({
        url: "https://example.com/post",
      }),
    }, createContext()),
    /renderer secret was invalid/,
  );
});

test("render endpoint validates and forwards normalized requests", async () => {
  const seen = [];
  const response = await dispatchRendererRequest({
    method: "POST",
    url: "/render",
    headers: {
      "content-type": "application/json",
      "x-content-renderer-secret": "test-secret",
    },
    bodyText: JSON.stringify({
      url: "https://example.com/post#section",
      waitUntil: "load",
      timeoutMs: 12000,
    }),
  }, createContext({
    validateTargetUrl: async (url) => {
      seen.push({ stage: "validate", url });
      return {
        url: "https://example.com/post",
        host: "example.com",
      };
    },
    renderer: {
      async renderDocument(input) {
        seen.push({ stage: "render", input });
        return {
          resolvedUrl: input.url,
          status: 200,
          html: "<html><body><article>ok</article></body></html>",
        };
      },
    },
  }));

  assert.deepEqual(response, {
    status: 200,
    payload: {
      resolvedUrl: "https://example.com/post",
      status: 200,
      html: "<html><body><article>ok</article></body></html>",
    },
  });
  assert.deepEqual(seen, [
    {
      stage: "validate",
      url: "https://example.com/post#section",
    },
    {
      stage: "render",
      input: {
        url: "https://example.com/post",
        waitUntil: "load",
        timeoutMs: 12000,
      },
    },
  ]);
});

function createContext({
  renderer = {
    async renderDocument(input) {
      return {
        resolvedUrl: input.url,
        status: 200,
        html: "<html></html>",
      };
    },
  },
  validateTargetUrl = async (url) => ({
    url,
    host: "example.com",
  }),
} = {}) {
  return {
    config: {
      secret: "test-secret",
      maxRequestBytes: 16 * 1024,
      maxHtmlBytes: 3 * 1024 * 1024,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 45_000,
      maxConcurrency: 1,
      allowedHosts: new Set(),
    },
    renderer,
    validateTargetUrl,
    logger: {
      error() {},
    },
  };
}
