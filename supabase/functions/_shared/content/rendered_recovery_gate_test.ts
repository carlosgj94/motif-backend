import { shouldEscalateToRenderedRecovery } from "./rendered_recovery_gate.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("shouldEscalateToRenderedRecovery targets high-priority js-heavy article failures", () => {
  const shouldEscalate = shouldEscalateToRenderedRecovery({
    fetched: {
      host: "example.com",
      html:
        '<html><body><div id="__next"></div><script>self.__next_f.push([1,"hydration"])</script><script type="application/json">{}</script></body></html>',
    },
    current: {
      sourceKind: "article",
      parsedDocument: {
        version: 1,
        kind: "article",
        blocks: [{ type: "paragraph", text: "Short body" }],
      },
      parserQualityScore: 4,
      parserRecovery: {
        shouldRecover: true,
        priority: "high",
        qualityScore: 4,
        route: "generic-article",
        selectedStrategyId: "fallback-container",
        reasons: ["article-empty-or-too-short"],
      },
    },
    recoveryDecision: {
      shouldRecover: true,
      priority: "high",
      qualityScore: 6,
      route: "generic-article",
      selectedStrategyId: "fallback-container",
      reasons: ["article-empty-or-too-short"],
    },
    rendererConfigured: true,
  });

  assert(shouldEscalate, "expected escalation to rendered recovery");
});

Deno.test("shouldEscalateToRenderedRecovery skips unsupported routes and low-priority failures", () => {
  const shouldEscalate = shouldEscalateToRenderedRecovery({
    fetched: {
      host: "x.com",
      html: "<html><body><article><p>Hello</p></article></body></html>",
    },
    current: {
      sourceKind: "post",
      parsedDocument: null,
      parserQualityScore: 3,
      parserRecovery: null,
    },
    recoveryDecision: {
      shouldRecover: true,
      priority: "low",
      qualityScore: 3,
      route: "x-thread",
      selectedStrategyId: "oembed",
      reasons: ["post-low-quality-score"],
    },
    rendererConfigured: true,
  });

  assert(!shouldEscalate, "expected no rendered escalation");
});
