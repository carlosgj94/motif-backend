import { chromium } from "playwright";

import { HttpError } from "./errors.mjs";
import { shouldAbortRequest } from "./route_policy.mjs";
import { Semaphore } from "./semaphore.mjs";

export function createRenderer(config) {
  const semaphore = new Semaphore(config.maxConcurrency);
  let browserPromise = null;

  async function renderDocument(input) {
    const release = await semaphore.acquire();
    try {
      const browser = await getBrowser();
      const context = await browser.newContext({
        ignoreHTTPSErrors: false,
        javaScriptEnabled: true,
      });
      const page = await context.newPage();
      const timeoutMs = clampTimeout(
        input.timeoutMs,
        config.defaultTimeoutMs,
        config.maxTimeoutMs,
      );

      await page.route("**/*", (route) => {
        if (shouldAbortRequest(route.request().url(), route.request().resourceType())) {
          return route.abort();
        }

        return route.continue();
      });

      page.setDefaultNavigationTimeout(timeoutMs);
      page.setDefaultTimeout(timeoutMs);

      let response;
      try {
        response = await page.goto(input.url, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
        if (input.waitUntil && input.waitUntil !== "domcontentloaded") {
          await page.waitForLoadState(input.waitUntil, {
            timeout: timeoutMs,
          });
        }
      } catch (error) {
        throw new HttpError(504, `render navigation failed: ${errorMessage(error)}`);
      }

      const html = await page.content();
      if (Buffer.byteLength(html, "utf8") > config.maxHtmlBytes) {
        throw new HttpError(413, "rendered html exceeded size limit");
      }

      const result = {
        resolvedUrl: page.url(),
        status: response?.status() ?? 200,
        html,
      };

      await context.close();
      return result;
    } finally {
      release();
    }
  }

  async function close() {
    if (!browserPromise) {
      return;
    }

    const browser = await browserPromise;
    browserPromise = null;
    await browser.close();
  }

  async function getBrowser() {
    if (!browserPromise) {
      browserPromise = chromium.launch({
        headless: true,
        args: [
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-sandbox",
        ],
      });
    }

    return await browserPromise;
  }

  return {
    renderDocument,
    close,
  };
}

function clampTimeout(value, fallback, maxValue) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, maxValue);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
