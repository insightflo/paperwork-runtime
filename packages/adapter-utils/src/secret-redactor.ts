const SECRET_LABEL =
  "[A-Za-z0-9_.-]{0,64}(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|signing[_-]?key)[A-Za-z0-9_.-]{0,64}";
const BEARER_SECRET = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const AUTH_HEADER_SECRET = /(authorization["']?\s*[=:]+\s*)(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(["']?(?:${SECRET_LABEL})["']?\s*[=:]+\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)`,
  "giu",
);
const JSON_BARE_KEY = /("keys?"\s*:\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/giu;
const KNOWN_SECRET_PREFIXES =
  /(?<![A-Za-z0-9_-])(?:(?:sk-ant|sk-|sk_|xai-|ghp_|gho_|ghu_|ghr_|ghs_|github_pat_|AKIA|xox[abeoprs]-|xapp-|glpat-|rk_live_|rk_test_)[A-Za-z0-9._-]{8,}|whsec_[A-Za-z0-9+/=._-]{8,}|AIza[A-Za-z0-9_-]{30,}|(?:npm|hf|gsk)_[A-Za-z0-9]{30,}|ASIA[A-Z0-9]{16}(?![A-Za-z0-9]))/g;
const JSON_WEB_TOKEN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[\s\S]{0,16384}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|(?:\\[rn]|\s)*[A-Za-z0-9+/=]{16,}[\s\S]*$)/gu;
const COOKIE_HEADER =
  /(\bcookie["']?\s*:\s*["']?)[^\s=;,"'\\]{1,256}=(?:\\.|"[^"\r\n\\]{0,4096}"(?=;|[ \t]*(?:[\r\n]|$))|[^\r\n"'\\])*/giu;
const QUERY_SECRET =
  /([?&](?:key|code|ticket|sig)=)(?!\[redacted\])(?=[^&#\s"'<>)\]]{0,256}\d)[^&#\s"'<>)\]]{8,}/giu;
const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/giu;
const SECRET_KEY = new RegExp(`^(?:${SECRET_LABEL}|keys?)$`, "iu");
const HEADER_KEY = /^headers$/iu;

const MIN_REGISTERED_SECRET_LENGTH = 8;
const MAX_EMBEDDED_SCANS = 16;
const MAX_CONVERSION_DEPTH = 32;
const UNSCANNED = "[redacted-unscanned]";
const UNSERIALIZABLE = "[unserializable]";
const HOST = 1;
const RULE_WORD =
  /password|passwd|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|signing[_-]?key|bearer|basic|digest|headers|keys?/iu;
const TOKEN_CHARACTER = /[A-Za-z0-9._~+/@%-]/u;
const URL_HOST = /(?<![A-Za-z0-9+.-])(https?:\/\/(?:[^\s/?#@]*@)?)([\p{L}\p{N}.-]+)/giu;
const VALUE_MARKER = "__paperclip_registered_value__";
const LABEL_MARKER = "__paperclip_registered_secret_authorization";
const MARKERS = new RegExp(`${VALUE_MARKER}|${LABEL_MARKER}`, "gu");

const registeredSecrets = new Set<string>();
let registeredSecretPattern: RegExp | null = null;

function uriEncoded(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}

export function registerRuntimeSecrets(values: Iterable<string>, options: { allowShort?: boolean } = {}): void {
  const before = registeredSecrets.size;
  for (const value of values) {
    if (!value || (!options.allowShort && value.length < MIN_REGISTERED_SECRET_LENGTH)) continue;
    for (const form of [value, JSON.stringify(value).slice(1, -1), uriEncoded(value)]) {
      if (form !== null && form.length > 0) registeredSecrets.add(form);
    }
  }
  if (registeredSecrets.size === before) return;
  const alternatives = [...registeredSecrets]
    .sort((a, b) => b.length - a.length)
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  registeredSecretPattern = alternatives.length > 0 ? new RegExp(alternatives.join("|"), "gu") : null;
}

export function clearRegisteredRuntimeSecretsForTests(): void {
  registeredSecrets.clear();
  registeredSecretPattern = null;
}

function urlHosts(value: string): Uint8Array {
  const flags = new Uint8Array(value.length);
  for (const match of value.matchAll(URL_HOST)) {
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    flags.fill(HOST, start, start + (match[2]?.length ?? 0));
  }
  return flags;
}

function markRegisteredSecrets(value: string): string {
  const pattern = registeredSecretPattern;
  if (!pattern) return value;
  pattern.lastIndex = 0;
  const ranges: Array<{ start: number; end: number }> = [];
  let hosts: Uint8Array | null | undefined;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    let start = match.index;
    let end = start + match[0].length;
    if (hosts === undefined) hosts = value.includes("://") ? urlHosts(value) : null;
    if (hosts?.subarray(start, end).every((flag) => flag === HOST)) continue;
    const prev = ranges.at(-1);
    const floor = prev?.end ?? 0;
    while (start > floor && !hosts?.[start - 1] && TOKEN_CHARACTER.test(value.charAt(start - 1))) start -= 1;
    if (prev && end <= prev.end) continue;
    while (end < value.length && !hosts?.[end] && TOKEN_CHARACTER.test(value.charAt(end))) end += 1;
    if (prev && start <= prev.end) prev.end = end;
    else ranges.push({ start, end });
  }
  if (ranges.length === 0) return value;
  let out = "";
  let cursor = 0;
  for (const { start, end } of ranges) {
    out += value.slice(cursor, start) + (RULE_WORD.test(value.slice(start, end)) ? LABEL_MARKER : VALUE_MARKER);
    cursor = end;
  }
  return out + value.slice(cursor);
}

function redactAssignedValue(_m: string, label: string, val: string): string {
  const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : "";
  return `${label}${quote}[redacted]${quote}`;
}

function applyTextRules(value: string, emails: boolean): string {
  const redacted = value
    .replace(PEM_PRIVATE_KEY, "[redacted]")
    .replace(COOKIE_HEADER, "$1[redacted]")
    .replace(AUTH_HEADER_SECRET, "$1[redacted]")
    .replace(BEARER_SECRET, "[redacted]")
    .replace(CREDENTIAL_ASSIGNMENT, redactAssignedValue)
    .replace(JSON_BARE_KEY, redactAssignedValue)
    .replace(QUERY_SECRET, "$1[redacted]")
    .replace(KNOWN_SECRET_PREFIXES, "[redacted]")
    .replace(JSON_WEB_TOKEN, "[redacted]");
  return emails ? redacted.replace(EMAIL, "[redacted-email]") : redacted;
}

function startsLikeJson(value: string, start: number): boolean {
  const limit = Math.min(value.length, start + 128);
  for (let i = start + 1; i < limit; i += 1) {
    const ch = value[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "{" || ch === "[") continue;
    return ch === '"';
  }
  return false;
}

function findBalancedEnd(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function redactHeaderStrings(value: unknown): unknown {
  if (typeof value === "string") return "[redacted]";
  if (Array.isArray(value)) return value.map(redactHeaderStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactHeaderStrings(v)]));
  }
  return value;
}

function convertJsonValue(value: unknown, seen: Set<object>, emails: boolean, depth = 0): unknown {
  if (typeof value === "string") return redactCore(value, emails, false);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    if (depth >= MAX_CONVERSION_DEPTH) return "[too deep]";
    seen.add(value);
    return value.map((item) => convertJsonValue(item, seen, emails, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    if (depth >= MAX_CONVERSION_DEPTH) return "[too deep]";
    seen.add(value);
    try {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
        const safeKey = redactCore(key, emails, false);
        if (SECRET_KEY.test(key)) return [safeKey, "[redacted]"];
        const converted = convertJsonValue(entry, seen, emails, depth + 1);
        return [safeKey, HEADER_KEY.test(key) && entry !== null && typeof entry === "object" ? redactHeaderStrings(converted) : converted];
      }));
    } catch { return UNSERIALIZABLE; }
  }
  return String(value);
}

function unchangedKeyCount(parsed: unknown, converted: unknown): number {
  if (parsed === null || typeof parsed !== "object") return parsed === converted ? 0 : -1;
  if (converted === null || typeof converted !== "object" || Array.isArray(parsed) !== Array.isArray(converted)) return -1;
  const a = Object.entries(parsed);
  const b = Object.entries(converted);
  if (a.length !== b.length) return -1;
  let count = Array.isArray(parsed) ? 0 : a.length;
  for (const [idx, [k, v]] of a.entries()) {
    const [ck, cv] = b[idx] ?? [];
    const inner = k === ck ? unchangedKeyCount(v, cv) : -1;
    if (inner < 0) return -1;
    count += inner;
  }
  return count;
}

function writtenKeyCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '"') continue;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    let next = i + 1;
    while (text[next] === " " || text[next] === "\t" || text[next] === "\n" || text[next] === "\r") next += 1;
    if (text[next] === ":") count += 1;
  }
  return count;
}

function parseRedactedJson(candidate: string, emails: boolean): string | null {
  try {
    const parsed = JSON.parse(candidate);
    const converted = convertJsonValue(parsed, new Set<object>(), emails);
    if (unchangedKeyCount(parsed, converted) === writtenKeyCount(candidate)) return candidate;
    return JSON.stringify(converted) ?? null;
  } catch {
    return null;
  }
}

export function redactEmbeddedJson(value: string, options: { emails?: boolean; keepUnscanned?: boolean } = {}): string {
  const emails = options.emails ?? false;
  const keepUnscanned = options.keepUnscanned ?? false;
  let result = "";
  let index = 0;
  let scans = 0;
  while (index < value.length) {
    let start = -1;
    for (let i = index; i < value.length; i += 1) {
      if (value[i] === "{" || value[i] === "[") {
        start = i;
        break;
      }
    }
    if (start < 0) break;
    if (!startsLikeJson(value, start)) {
      let next = start + 1;
      while (value[next] === "{" || value[next] === "[") next += 1;
      result += value.slice(index, next);
      index = next;
      continue;
    }
    if (scans >= MAX_EMBEDDED_SCANS) {
      return keepUnscanned ? result + value.slice(index) : `${result}${value.slice(index, start)}${UNSCANNED}`;
    }
    scans += 1;
    const end = findBalancedEnd(value, start);
    if (end < 0) return `${result}${value.slice(index, start)}${UNSCANNED}`;
    const parsed = parseRedactedJson(value.slice(start, end), emails);
    if (parsed === null) {
      result += value.slice(index, start) + UNSCANNED;
      index = end;
      continue;
    }
    result += value.slice(index, start) + parsed;
    index = end;
  }
  return result + value.slice(index);
}

function redactCore(value: string, emails: boolean, keepUnscanned: boolean): string {
  const marked = markRegisteredSecrets(value);
  const trimmed = marked.trim();
  const wholeJson = trimmed.startsWith("{") || trimmed.startsWith("[") ? parseRedactedJson(trimmed, emails) : null;
  const redacted = wholeJson ?? applyTextRules(redactEmbeddedJson(marked, { emails, keepUnscanned }), emails);
  return marked === value ? redacted : redacted.replace(MARKERS, "[redacted]");
}

export function redactSensitiveText(value: string, options: { emails?: boolean; keepUnscanned?: boolean } = {}): string {
  return redactCore(value, options.emails ?? false, options.keepUnscanned ?? false);
}

export function redactBeforeTruncate(
  value: string,
  maxChars: number,
  options: { emails?: boolean; keepUnscanned?: boolean } = {},
): string {
  const redacted = redactSensitiveText(value, options);
  if (maxChars <= 0) return "";
  if (redacted.length <= maxChars) return redacted;
  const code = redacted.charCodeAt(maxChars - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars;
  return `${redacted.slice(0, end)}…`;
}
