import type { ParsedBlock, SourceKind } from "./model.ts";

export type CompactContentKind = SourceKind;

export type CompactContentBlock =
  | { t: "h"; l: number; x: string }
  | { t: "p"; x: string }
  | { t: "q"; x: string }
  | { t: "l"; o: boolean; i: string[] }
  | { t: "c"; x: string; lang?: string };

export interface CompactContentBody {
  kind: CompactContentKind;
  blocks: CompactContentBlock[];
}

const textEncoder = new TextEncoder();

export function buildCompactContentBody(
  parsedDocument: Record<string, unknown>,
  fallbackSourceKind: SourceKind | null = null,
): CompactContentBody | null {
  const parsedBlocks = Array.isArray(parsedDocument.blocks)
    ? parsedDocument.blocks
    : null;
  if (!parsedBlocks) {
    return null;
  }

  const blocks: CompactContentBlock[] = [];
  for (const value of parsedBlocks) {
    appendCompactContentBlocks(value, blocks);
  }

  if (blocks.length === 0) {
    return null;
  }

  const kind = parseCompactBodyKind(parsedDocument.kind) ??
    (isCompactBodyKind(fallbackSourceKind) ? fallbackSourceKind : "article");

  return { kind, blocks };
}

export function measureCompactContentBodyBytes(
  parsedDocument: Record<string, unknown>,
  fallbackSourceKind: SourceKind | null = null,
): number | null {
  const compact = buildCompactContentBody(parsedDocument, fallbackSourceKind);
  if (!compact) {
    return null;
  }

  return textEncoder.encode(JSON.stringify(compact)).byteLength;
}

function appendCompactContentBlocks(
  value: unknown,
  out: CompactContentBlock[],
): void {
  const block = objectValue(value);
  const blockType = stringValue(block?.type);
  if (!block || !blockType) {
    return;
  }

  switch (blockType) {
    case "heading": {
      const text = trimNonEmptyString(block.text);
      if (!text) {
        return;
      }

      out.push({
        t: "h",
        l: clampHeadingLevel(numberValue(block.level) ?? 2),
        x: text,
      });
      return;
    }
    case "paragraph": {
      const text = trimNonEmptyString(block.text);
      if (!text) {
        return;
      }

      out.push({ t: "p", x: text });
      return;
    }
    case "quote": {
      const text = trimNonEmptyString(block.text);
      if (!text) {
        return;
      }

      out.push({ t: "q", x: text });
      return;
    }
    case "list": {
      const items = arrayValue(block.items)
        .map((item) => trimNonEmptyString(item))
        .filter((item): item is string => !!item);
      if (items.length === 0) {
        return;
      }

      out.push({
        t: "l",
        o: stringValue(block.style) === "numbered",
        i: items,
      });
      return;
    }
    case "code": {
      const text = trimNonEmptyString(block.text);
      if (!text) {
        return;
      }

      const language = trimNonEmptyString(block.language);
      out.push(
        language ? { t: "c", x: text, lang: language } : { t: "c", x: text },
      );
      return;
    }
    case "thread_post":
      appendThreadPostBlocks(block, out);
      return;
    default:
      return;
  }
}

function appendThreadPostBlocks(
  block: Record<string, unknown>,
  out: CompactContentBlock[],
): void {
  const heading = buildThreadPostHeading(block);
  if (heading) {
    out.push({ t: "h", l: 3, x: heading });
  }

  const text = trimNonEmptyString(block.text);
  if (!text) {
    return;
  }

  out.push({ t: "p", x: text });
}

function buildThreadPostHeading(
  block: Record<string, unknown>,
): string | null {
  const displayName = trimNonEmptyString(block.display_name);
  const authorHandle = trimNonEmptyString(block.author_handle)
    ?.replace(/^@/, "") ?? null;

  if (displayName && authorHandle) {
    return displayName.trimStart().replace(/^@/, "").toLowerCase() ===
        authorHandle.toLowerCase()
      ? displayName
      : `${displayName} (@${authorHandle})`;
  }

  if (displayName) {
    return displayName;
  }

  if (authorHandle) {
    return `@${authorHandle}`;
  }

  return null;
}

function parseCompactBodyKind(value: unknown): CompactContentKind | null {
  return isCompactBodyKind(value) ? value : null;
}

function isCompactBodyKind(value: unknown): value is CompactContentKind {
  return value === "article" || value === "thread" || value === "post";
}

function clampHeadingLevel(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), 6);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
