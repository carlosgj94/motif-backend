import test from "node:test";
import assert from "node:assert/strict";

import { shouldAbortRequest } from "../src/route_policy.mjs";

test("allows the main document request", () => {
  assert.equal(
    shouldAbortRequest("https://example.com/post", "document"),
    false,
  );
});

test("blocks low-value heavy asset requests", () => {
  assert.equal(
    shouldAbortRequest("https://example.com/hero.jpg", "image"),
    true,
  );
  assert.equal(
    shouldAbortRequest("https://cdn.example.com/font.woff2", "font"),
    true,
  );
});

test("blocks common analytics and ad hosts", () => {
  assert.equal(
    shouldAbortRequest("https://www.googletagmanager.com/gtm.js", "script"),
    true,
  );
  assert.equal(
    shouldAbortRequest("https://cdn.segment.com/analytics.js", "script"),
    true,
  );
});

test("keeps ordinary scripts and stylesheets", () => {
  assert.equal(
    shouldAbortRequest("https://example.com/app.js", "script"),
    false,
  );
  assert.equal(
    shouldAbortRequest("https://example.com/site.css", "stylesheet"),
    false,
  );
});
