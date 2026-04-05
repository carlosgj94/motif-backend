import {
  fetchRenderedDocument,
  isRenderedFetchConfigured,
} from "./rendered_fetch.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("isRenderedFetchConfigured requires url and secret", () => {
  assert(
    isRenderedFetchConfigured({
      rendererUrl: "https://renderer.example.com/render",
      rendererSecret: "secret",
    }),
    "expected renderer configuration to be accepted",
  );
  assert(
    !isRenderedFetchConfigured({
      rendererUrl: "https://renderer.example.com/render",
      rendererSecret: "",
    }),
    "expected missing secret to disable renderer",
  );
});

Deno.test("fetchRenderedDocument parses renderer JSON response", async () => {
  const result = await fetchRenderedDocument("https://example.com/post", {
    rendererUrl: "https://renderer.example.com/render",
    rendererSecret: "secret",
    fetchImpl: async (input, init) => {
      assert(
        input === "https://renderer.example.com/render",
        "expected renderer endpoint request",
      );
      assert(
        init?.headers instanceof Headers || typeof init?.headers === "object",
        "expected headers",
      );
      return new Response(
        JSON.stringify({
          resolvedUrl: "https://example.com/post?view=rendered",
          status: 200,
          html:
            "<html><body><article><p>Rendered article body.</p></article></body></html>",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  assert(
    result.resolvedUrl === "https://example.com/post?view=rendered",
    `unexpected resolved url ${result.resolvedUrl}`,
  );
  assert(result.host === "example.com", `unexpected host ${result.host}`);
  assert(
    result.html.includes("Rendered article body."),
    "expected rendered html body",
  );
});
