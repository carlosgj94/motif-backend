const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "texttrack",
  "object",
  "beacon",
]);

const BLOCKED_HOST_SNIPPETS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.net",
  "facebook.com/tr",
  "segment.io",
  "segment.com",
  "hotjar.com",
  "clarity.ms",
  "ads-twitter.com",
];

export function shouldAbortRequest(url, resourceType) {
  if (resourceType === "document") {
    return false;
  }

  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
    return true;
  }

  const normalizedUrl = String(url ?? "").toLowerCase();
  return BLOCKED_HOST_SNIPPETS.some((snippet) =>
    normalizedUrl.includes(snippet)
  );
}
