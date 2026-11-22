// [파일 목적] 완료 미션의 실제 문서 산출물(content.json, .md, .txt, preview_url)에서
//   제목·요약·핵심 블록 내용·태그·출처 URL을 추출하고, 이미지/중간점검/자동 보일러플레이트를 제외한다.
// [외부 연결] server/src/services/knowledge/kb-auto-compile.ts.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_DOC_BYTES = 256 * 1024;
const MAX_HIGHLIGHTS = 8;
const MAX_EXTRA_TAGS = 8;
const BOILERPLATE_RE = /^created automatically for workflow run:/i;
const IGNORED_ASSET_RE = /\.(png|jpe?g|webp|gif|svg|ico|mp4|mov|webm|mp3|wav|pdf|zip)$/i;
const IGNORED_PRECHECK_RE = /(?:^|\/)security-precheck\.json$/i;

export interface MissionWorkProductRow {
  type: string;
  title: string;
  summary: string | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ExtractedMissionFacts {
  titleOverride?: string;
  url: string | null;
  highlights: string[];
  extraTags: string[];
}

function cleanLine(raw: unknown, maxLen = 240): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!s || s.length < 3 || BOILERPLATE_RE.test(s)) return null;
  return s.slice(0, maxLen);
}

function isIgnoredWorkProduct(wp: MissionWorkProductRow): boolean {
  const filePath = typeof wp.metadata?.path === "string" ? wp.metadata.path : "";
  if (IGNORED_ASSET_RE.test(wp.title) || IGNORED_ASSET_RE.test(filePath)) return true;
  if (IGNORED_PRECHECK_RE.test(wp.title) || IGNORED_PRECHECK_RE.test(filePath)) return true;
  return false;
}

function extractFromJsonDoc(parsed: unknown): {
  title?: string;
  url?: string;
  highlights: string[];
  tags: string[];
} {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { highlights: [], tags: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const highlights: string[] = [];
  const tags: string[] = [];
  const title = cleanLine(obj.title, 160) ?? undefined;
  let url: string | undefined;

  const summary = cleanLine(obj.summary, 240);
  if (summary) highlights.push(summary);

  if (Array.isArray(obj.tags)) {
    for (const t of obj.tags) {
      const clean = cleanLine(t, 40);
      if (clean) tags.push(clean);
    }
  }

  if (Array.isArray(obj.blocks)) {
    for (const block of obj.blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const candidates = [b.heading, b.title, b.text, b.body, b.description, b.alt];
      for (const c of candidates) {
        const line = cleanLine(c, 220);
        if (line && highlights.length < MAX_HIGHLIGHTS) highlights.push(line);
      }
      if (Array.isArray(b.items)) {
        for (const item of b.items.slice(0, 3)) {
          const line = cleanLine(typeof item === "string" ? item : (item as Record<string, unknown>)?.text ?? (item as Record<string, unknown>)?.title, 200);
          if (line && highlights.length < MAX_HIGHLIGHTS) highlights.push(line);
        }
      }
      if (highlights.length >= MAX_HIGHLIGHTS) break;
    }
  }

  if (Array.isArray(obj.sources)) {
    for (const src of obj.sources.slice(0, 3)) {
      if (!src || typeof src !== "object") continue;
      const s = src as Record<string, unknown>;
      const srcUrl = typeof s.url === "string" && /^https?:\/\//i.test(s.url.trim()) ? s.url.trim() : null;
      if (srcUrl && !url) url = srcUrl;
      const srcTitle = cleanLine(s.title, 80);
      if (srcUrl && highlights.length < MAX_HIGHLIGHTS) {
        highlights.push(srcTitle ? `${srcTitle}: ${srcUrl}` : srcUrl);
      }
    }
  }

  return { title, url, highlights, tags };
}

function extractFromMarkdownDoc(raw: string): { title?: string; highlights: string[] } {
  let title: string | undefined;
  const highlights: string[] = [];
  let inFence = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed) continue;
    if (!title && trimmed.startsWith("# ")) {
      title = cleanLine(trimmed.slice(2), 160) ?? undefined;
      continue;
    }
    const stripped = trimmed.replace(/^(?:#{2,6}\s+|[-*•]\s+|\d+\.\s+)/, "");
    const line = cleanLine(stripped, 220);
    if (line && highlights.length < MAX_HIGHLIGHTS) highlights.push(line);
    if (highlights.length >= MAX_HIGHLIGHTS) break;
  }
  return { title, highlights };
}

async function readLocalDocumentSafe(filePath: string): Promise<string | null> {
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) return null;
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0 || info.size > MAX_DOC_BYTES) return null;
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function mergeDedupedTags(baseTags: string[], extraTags: string[], maxTags = 10): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...baseTags, ...extraTags]) {
    const clean = cleanLine(raw, 40);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxTags) break;
  }
  return out;
}

export async function extractMissionDocumentFacts(
  workProducts: MissionWorkProductRow[],
  missionDescription?: string | null,
): Promise<ExtractedMissionFacts> {
  let titleOverride: string | undefined;
  let url: string | null = workProducts.find((w) => w.url && /^https?:\/\//i.test(w.url))?.url ?? null;
  const highlights: string[] = [];
  const extraTags: string[] = [];

  const desc = cleanLine(missionDescription, 240);
  if (desc) highlights.push(desc);

  const filtered = workProducts.filter((wp) => !isIgnoredWorkProduct(wp));
  const prioritized = [
    ...filtered.filter((w) => w.type === "document" || w.type === "preview_url"),
    ...filtered.filter((w) => w.type !== "document" && w.type !== "preview_url"),
  ];

  for (const wp of prioritized) {
    const filePath = typeof wp.metadata?.path === "string" ? wp.metadata.path : null;
    if (filePath && (/\.(json|md|markdown|txt)$/i.test(filePath) || wp.type === "document")) {
      const content = await readLocalDocumentSafe(filePath);
      if (content) {
        if (filePath.toLowerCase().endsWith(".json")) {
          try {
            const parsed = extractFromJsonDoc(JSON.parse(content));
            if (parsed.title && !titleOverride) titleOverride = parsed.title;
            if (parsed.url && !url) url = parsed.url;
            highlights.push(...parsed.highlights);
            extraTags.push(...parsed.tags);
            continue;
          } catch {
            // fall through to summary check
          }
        } else {
          const parsed = extractFromMarkdownDoc(content);
          if (parsed.title && !titleOverride) titleOverride = parsed.title;
          highlights.push(...parsed.highlights);
          continue;
        }
      }
    }
    const wpSummary = cleanLine(wp.summary, 220);
    if (wpSummary) highlights.push(`${wp.title}: ${wpSummary}`);
  }

  const dedupedHighlights: string[] = [];
  const seenH = new Set<string>();
  for (const h of highlights) {
    const key = h.toLowerCase();
    if (seenH.has(key)) continue;
    seenH.add(key);
    dedupedHighlights.push(h);
    if (dedupedHighlights.length >= MAX_HIGHLIGHTS) break;
  }

  return {
    titleOverride,
    url,
    highlights: dedupedHighlights,
    extraTags: mergeDedupedTags([], extraTags, MAX_EXTRA_TAGS),
  };
}
