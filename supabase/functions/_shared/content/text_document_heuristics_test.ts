import type { ParsedBlock } from "./model.ts";
import {
  deriveTextDocumentCandidateScore,
  parseTextDocumentContent,
} from "./text_document_heuristics.ts";
import { deriveParsedDocumentMetrics } from "./normalize.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("parseTextDocumentContent extracts markdown structure from raw gist content", () => {
  const raw = `
# LLM Wiki

A pattern for building personal knowledge bases using LLMs.

## Operations

- Ingest sources one at a time.
- Query the wiki with citations.

\`\`\`bash
grep "^##" log.md
\`\`\`
  `.trim();

  const result = parseTextDocumentContent({
    raw,
    resolvedUrl:
      "https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw/ac46de1ad27f92b28ac95459c782c07f6b8c964a/llm-wiki.md",
    host: "gist.githubusercontent.com",
  });

  assert(result.title === "LLM Wiki", `unexpected title ${result.title}`);
  assert(
    result.siteName === "GitHub Gist",
    `unexpected site name ${result.siteName}`,
  );
  assert(
    result.sourceDiscoveryUrl ===
      "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f",
    `unexpected discovery url ${result.sourceDiscoveryUrl}`,
  );
  assert(
    result.blocks.length === 4,
    `unexpected block count ${result.blocks.length}`,
  );
  assert(
    result.blocks[0]?.type === "paragraph",
    `expected first block to be paragraph, got ${result.blocks[0]?.type}`,
  );
  assert(
    result.blocks[1]?.type === "heading",
    `expected second block to be heading, got ${result.blocks[1]?.type}`,
  );
  assert(
    result.blocks[2]?.type === "list",
    `expected third block to be list, got ${result.blocks[2]?.type}`,
  );
  assert(
    result.blocks[3]?.type === "code",
    `expected fourth block to be code, got ${result.blocks[3]?.type}`,
  );
});

Deno.test("deriveTextDocumentCandidateScore keeps healthy text documents out of recovery", () => {
  const parsedDocument = {
    kind: "article",
    blocks: [
      {
        type: "paragraph",
        text: "One concise paragraph that still reads well.",
      },
      {
        type: "paragraph",
        text: "A second paragraph gives enough body to avoid recovery noise.",
      },
    ] as ParsedBlock[],
  };
  const metrics = deriveParsedDocumentMetrics(parsedDocument);
  const score = deriveTextDocumentCandidateScore({
    wordCount: metrics.wordCount,
    blockCount: metrics.blockCount,
    title: "Short note",
    excerpt: "One concise paragraph that still reads well.",
    blocks: parsedDocument.blocks,
  });

  assert(score >= 40, `expected healthy text document score, got ${score}`);
});
