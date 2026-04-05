import { detectContentRoute } from "./detect.ts";
import type { FetchDocumentResult, ParserRecoveryDecision } from "./model.ts";
import type { StoredRecoverySnapshot } from "./recovery_quality.ts";

const ESCALATION_REASONS = new Set([
  "missing-parser-diagnostics",
  "missing-selected-candidate",
  "article-empty-or-too-short",
  "article-too-few-blocks",
  "article-low-quality-score",
]);

export function shouldEscalateToRenderedRecovery(input: {
  fetched: Pick<FetchDocumentResult, "host" | "html">;
  current: StoredRecoverySnapshot;
  recoveryDecision: ParserRecoveryDecision | null;
  rendererConfigured: boolean;
}): boolean {
  if (!input.rendererConfigured || input.current.sourceKind !== "article") {
    return false;
  }

  const decision = input.recoveryDecision ?? input.current.parserRecovery;
  if (!decision?.shouldRecover || decision.priority !== "high") {
    return false;
  }

  if (!decision.reasons.some((reason) => ESCALATION_REASONS.has(reason))) {
    return false;
  }

  const route = detectContentRoute(input.fetched);
  if (route === "x-thread" || route === "archive-snapshot") {
    return false;
  }

  return looksJsHeavyDocument(input.fetched.html);
}

function looksJsHeavyDocument(html: string): boolean {
  const signals = [
    /id=["']__next["']/i,
    /\b__NEXT_DATA__\b/i,
    /\bself\.__next_f\.push\b/i,
    /\bwindow\.__NUXT__\b/i,
    /\bnuxt\b/i,
    /\bapplication\/json\b/i,
    /\bdata-reactroot\b/i,
    /\bhydration\b/i,
  ];
  const signalCount = signals.filter((pattern) => pattern.test(html)).length;
  const paragraphCount = (html.match(/<p\b/gi) ?? []).length;
  const scriptCount = (html.match(/<script\b/gi) ?? []).length;

  return signalCount >= 2 || (scriptCount >= 12 && paragraphCount <= 6);
}
