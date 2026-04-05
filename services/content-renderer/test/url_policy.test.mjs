import test from "node:test";
import assert from "node:assert/strict";

import {
  isPublicIpLiteral,
  validateRenderTargetUrl,
} from "../src/url_policy.mjs";

test("accepts a public https url and strips fragments", async () => {
  const result = await validateRenderTargetUrl("https://example.com/post#intro", {
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => [],
  });

  assert.deepEqual(result, {
    url: "https://example.com/post",
    host: "example.com",
  });
});

test("rejects localhost and private destinations", async () => {
  await assert.rejects(
    validateRenderTargetUrl("http://localhost/post"),
    /host is not allowed/,
  );

  await assert.rejects(
    validateRenderTargetUrl("https://10.0.0.5/post"),
    /public address/,
  );
});

test("rejects non-default ports and credentials", async () => {
  await assert.rejects(
    validateRenderTargetUrl("https://example.com:8443/post"),
    /default port/,
  );
  await assert.rejects(
    validateRenderTargetUrl("https://user:pass@example.com/post"),
    /must not include credentials/,
  );
});

test("respects an explicit host allowlist", async () => {
  await assert.rejects(
    validateRenderTargetUrl("https://example.com/post", {
      allowedHosts: new Set(["allowed.example"]),
      resolve4: async () => ["93.184.216.34"],
      resolve6: async () => [],
    }),
    /renderer policy/,
  );
});

test("public ip helper rejects private ranges", () => {
  assert.equal(isPublicIpLiteral("93.184.216.34"), true);
  assert.equal(isPublicIpLiteral("192.168.1.10"), false);
  assert.equal(isPublicIpLiteral("2001:4860:4860::8888"), true);
  assert.equal(isPublicIpLiteral("fd00::1"), false);
});
