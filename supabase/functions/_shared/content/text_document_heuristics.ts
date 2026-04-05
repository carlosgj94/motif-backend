import type { ParsedBlock } from "./model.ts";
import { summarizeBlocks, trimText } from "./normalize.ts";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const GIST_RAW_RE = /^\/([^/]+)\/([0-9a-f]+)\/raw(?:\/[^/]+)?(?:\/([^/]+))?$/i;
const RAW_GITHUB_RE = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;

interface TextDocumentFrontmatter {
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  languageCode: string | null;
}

export interface ParsedTextDocumentContent {
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  languageCode: string | null;
  siteName: string | null;
  sourceDiscoveryUrl: string | null;
  blocks: ParsedBlock[];
  strategyId: string;
}

export function parseTextDocumentContent(input: {
  raw: string;
  resolvedUrl: string;
  host: string;
}): ParsedTextDocumentContent {
  const normalizedRaw = normalizeRawText(input.raw);
  const { frontmatter, body } = extractFrontmatter(normalizedRaw);
  const leadingTitle = frontmatter.title ?? extractLeadingHeadingTitle(body);
  const blocks = buildTextDocumentBlocks(body, {
    suppressLeadingTitle: leadingTitle,
  });
  const title = trimText(
    leadingTitle ?? inferTitleFromBlocks(blocks) ??
      inferTitleFromUrl(input.resolvedUrl),
    512,
  );
  const excerpt = trimText(
    frontmatter.excerpt ?? summarizeBlocks(blocks),
    1024,
  );

  return {
    title,
    author: frontmatter.author,
    publishedAt: frontmatter.publishedAt,
    excerpt,
    languageCode: frontmatter.languageCode,
    siteName: inferTextDocumentSiteName(input.host),
    sourceDiscoveryUrl: inferTextDocumentSourceDiscoveryUrl(input.resolvedUrl),
    blocks,
    strategyId: looksLikeMarkdownDocument(normalizedRaw)
      ? "markdown-text"
      : "plain-text",
  };
}

export function deriveTextDocumentCandidateScore(input: {
  wordCount: number;
  blockCount: number;
  title: string | null;
  excerpt: string | null;
  blocks: ParsedBlock[];
}): number {
  let score = 0;
  score += Math.min(220, Math.round(input.wordCount / 4));
  score += Math.min(48, input.blockCount * 4);
  if (input.title) {
    score += 24;
  }
  if (input.excerpt) {
    score += 12;
  }
  if (input.blocks.some((block) => block.type === "heading")) {
    score += 10;
  }
  if (input.blocks.some((block) => block.type === "list")) {
    score += 10;
  }
  if (input.blocks.some((block) => block.type === "code")) {
    score += 12;
  }

  return Math.max(0, Math.min(320, score));
}

function buildTextDocumentBlocks(
  raw: string,
  options: { suppressLeadingTitle: string | null },
): ParsedBlock[] {
  const lines = raw.split("\n");
  const blocks: ParsedBlock[] = [];
  const paragraphLines: string[] = [];
  const quoteLines: string[] = [];
  let listStyle: "bulleted" | "numbered" | null = null;
  let listItems: string[] = [];
  let inCodeBlock = false;
  let codeFence = "";
  let codeLanguage: string | null = null;
  const codeLines: string[] = [];
  let suppressedTitle = false;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const text = normalizeInlineText(paragraphLines.join(" "));
    paragraphLines.length = 0;
    if (text) {
      blocks.push({ type: "paragraph", text });
    }
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) {
      return;
    }

    const text = normalizeInlineText(quoteLines.join(" "));
    quoteLines.length = 0;
    if (text) {
      blocks.push({ type: "quote", text });
    }
  };

  const flushList = () => {
    if (!listStyle || listItems.length === 0) {
      listStyle = null;
      listItems = [];
      return;
    }

    blocks.push({
      type: "list",
      style: listStyle,
      items: listItems.map((item) => normalizeInlineText(item)).filter(Boolean),
    });
    listStyle = null;
    listItems = [];
  };

  const flushCode = () => {
    if (!inCodeBlock) {
      return;
    }

    inCodeBlock = false;
    const text = codeLines.join("\n").trimEnd();
    codeLines.length = 0;
    if (text) {
      blocks.push({
        type: "code",
        language: codeLanguage,
        text,
      });
    }
    codeFence = "";
    codeLanguage = null;
  };

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (inCodeBlock) {
      if (trimmed.trimStart().startsWith(codeFence)) {
        flushCode();
      } else {
        codeLines.push(trimmed);
      }
      continue;
    }

    const fenceMatch = trimmed.match(/^\s*(```+|~~~+)\s*([^`]*)$/);
    if (fenceMatch) {
      flushParagraph();
      flushQuote();
      flushList();
      inCodeBlock = true;
      codeFence = fenceMatch[1];
      codeLanguage = trimNullable(fenceMatch[2]) ?? null;
      continue;
    }

    if (!trimmed.trim()) {
      flushParagraph();
      flushQuote();
      flushList();
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      flushList();
      continue;
    }

    const headingMatch = trimmed.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushQuote();
      flushList();
      const level = headingMatch[1].length;
      const text = normalizeInlineText(headingMatch[2]);
      if (!text) {
        continue;
      }
      if (
        !suppressedTitle &&
        level === 1 &&
        options.suppressLeadingTitle &&
        normalizeComparableTitle(text) ===
          normalizeComparableTitle(options.suppressLeadingTitle)
      ) {
        suppressedTitle = true;
        continue;
      }
      if (!suppressedTitle && level === 1 && blocks.length === 0) {
        suppressedTitle = true;
        continue;
      }
      blocks.push({ type: "heading", level, text });
      continue;
    }

    const quoteMatch = trimmed.match(/^\s{0,3}>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    const unorderedMatch = trimmed.match(/^\s{0,3}[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      flushQuote();
      if (listStyle && listStyle !== "bulleted") {
        flushList();
      }
      listStyle = "bulleted";
      listItems.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = trimmed.match(/^\s{0,3}\d+[.)]\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      flushQuote();
      if (listStyle && listStyle !== "numbered") {
        flushList();
      }
      listStyle = "numbered";
      listItems.push(orderedMatch[1]);
      continue;
    }

    flushQuote();
    flushList();
    paragraphLines.push(trimmed.trim());
  }

  flushParagraph();
  flushQuote();
  flushList();
  flushCode();

  return blocks;
}

function normalizeRawText(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

function extractFrontmatter(raw: string): {
  frontmatter: TextDocumentFrontmatter;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return {
      frontmatter: {
        title: null,
        author: null,
        publishedAt: null,
        excerpt: null,
        languageCode: null,
      },
      body: raw,
    };
  }

  const values = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!entry) {
      continue;
    }
    values.set(entry[1].trim().toLowerCase(), stripMatchingQuotes(entry[2]));
  }

  return {
    frontmatter: {
      title: trimNullable(values.get("title")),
      author: trimNullable(values.get("author")),
      publishedAt: trimNullable(
        values.get("published") ?? values.get("date") ?? values.get("created"),
      ),
      excerpt: trimNullable(
        values.get("description") ?? values.get("excerpt") ??
          values.get("summary"),
      ),
      languageCode: trimNullable(
        values.get("lang") ?? values.get("language"),
      ),
    },
    body: raw.slice(match[0].length).trim(),
  };
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeInlineText(value: string): string {
  return collapseWhitespace(
    value
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/\\([\\`*_{}\[\]()#+.!-])/g, "$1"),
  );
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inferTitleFromBlocks(blocks: ParsedBlock[]): string | null {
  const heading = blocks.find((block) => block.type === "heading");
  return heading && heading.type === "heading" ? heading.text : null;
}

function extractLeadingHeadingTitle(raw: string): string | null {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^#\s+(.*)$/);
    return match ? normalizeInlineText(match[1]) : null;
  }

  return null;
}

function inferTitleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const fileName = segments[segments.length - 1];
    if (!fileName) {
      return null;
    }

    const withoutExtension = fileName.replace(
      /\.(md|markdown|txt|text|rst)$/i,
      "",
    );
    const decoded = decodeURIComponent(withoutExtension).replace(/[-_]+/g, " ");
    return collapseWhitespace(decoded) || null;
  } catch {
    return null;
  }
}

function inferTextDocumentSiteName(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized === "gist.githubusercontent.com") {
    return "GitHub Gist";
  }
  if (normalized === "raw.githubusercontent.com") {
    return "GitHub";
  }

  return host.replace(/^www\./i, "");
}

function inferTextDocumentSourceDiscoveryUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "gist.githubusercontent.com") {
      const match = parsed.pathname.match(GIST_RAW_RE);
      if (match) {
        return `https://gist.github.com/${match[1]}/${match[2]}`;
      }
    }

    if (host === "raw.githubusercontent.com") {
      const match = parsed.pathname.match(RAW_GITHUB_RE);
      if (match) {
        return `https://github.com/${match[1]}/${match[2]}/blob/${match[3]}/${
          match[4]
        }`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeComparableTitle(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

function looksLikeMarkdownDocument(raw: string): boolean {
  return /^\s*#\s+/m.test(raw) ||
    /^\s*[-*+]\s+/m.test(raw) ||
    /^\s*\d+[.)]\s+/m.test(raw) ||
    /^\s*```/m.test(raw);
}

function trimNullable(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
