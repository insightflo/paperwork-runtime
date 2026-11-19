export type PrehydratedBundleEntry = {
  label: string;
  path?: string;
  sha256?: string;
  truncated?: boolean;
  content: string;
};

export type PrehydratedBundleInput = {
  compactContract?: PrehydratedBundleEntry;
  entries?: PrehydratedBundleEntry[];
  doNotRereadPaths?: string[];
  maxTotalChars?: number;
};

const HEADER = "- Pre-hydrated step input bundle (already loaded below; DO NOT re-read these files via read/bash unless you are editing them or need an omitted section):";
const PATHS_PREFIX = "- Already-loaded paths (skip read/cat/sed): ";
const TRUNCATED = "\n...[truncated]";
const MAX_ENTRY_CHARS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "") : undefined;
}

function readPath(value: unknown): string | undefined {
  const path = cleanText(value)?.trim();
  return path && !path.includes("\n") ? path : undefined;
}

export function buildPrehydratedBundleBriefLines(value: unknown): string[] {
  const bundle = asRecord(value);
  if (!bundle) return [];

  const max = bundle.maxTotalChars;
  const budget = typeof max === "number" && Number.isFinite(max)
    ? Math.min(48_000, Math.max(1_000, Math.floor(max)))
    : 24_000;
  const entries = Array.isArray(bundle.entries) ? bundle.entries.slice(0, 12) : [];
  const lines = [HEADER];
  const paths = new Set<string>();
  let remaining = budget - HEADER.length;
  const pathCost = (path: string | undefined) => path && !paths.has(path)
    ? path.length + (paths.size === 0 ? 1 + PATHS_PREFIX.length : 2)
    : 0;

  for (const value of [bundle.compactContract, ...entries]) {
    const entry = asRecord(value);
    const label = cleanText(entry?.label)?.replace(/\n/g, " ").trim();
    if (!label || typeof entry?.content !== "string") continue;

    const path = readPath(entry.path);
    const heading = `### ${label}${path ? ` (${path})` : ""}`;
    // Reserve the footer space before spending the budget on this excerpt.
    const footerCost = pathCost(path);
    const available = remaining - heading.length - 2 - footerCost;
    if (available < 0) break;

    const content = cleanText(entry.content)!;
    const limit = Math.min(MAX_ENTRY_CHARS, available);
    const clipped = entry.truncated === true || content.length > limit;
    if (clipped && limit < TRUNCATED.length) break;
    const excerpt = clipped ? content.slice(0, limit - TRUNCATED.length) + TRUNCATED : content;
    lines.push(`${heading}\n${excerpt}`);
    if (path) paths.add(path);
    remaining -= heading.length + 2 + excerpt.length + footerCost;
  }

  if (Array.isArray(bundle.doNotRereadPaths)) {
    for (const value of bundle.doNotRereadPaths) {
      const path = readPath(value);
      const cost = pathCost(path);
      if (!path || cost > remaining) continue;
      paths.add(path);
      remaining -= cost;
    }
  }
  if (paths.size > 0) lines.push(PATHS_PREFIX + [...paths].join(", "));
  return lines.length > 1 ? lines : [];
}
