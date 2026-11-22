// server/src/services/harness-rsi/rrsi-critic.ts
//
// [파일 목적] RRSI 사전-평가 크리틱 (Stage 1, 순수 함수, 결정론적 스크리너).
//   평가·배포 전 후보 diff에서 누출/과적합·비밀 하드코딩을 차단해 런타임 편집이
//   범용(universal)으로 남도록 한다. 오직 추가된(+) 줄만 검사 — 과거 누출을 지우는
//   삭제(-) 줄은 허용한다. 배포/테넌트 특정 패턴은 테스트 파일 외부에서만 차단.
//   차단 대상: 비밀/자격증명, 배포·테넌트 경로/엔터티, 빈 hypothesis, 미등록
//   component, 호출자 제공 extraDenylist.

import { HARNESS_COMPONENTS } from "./rrsi-history.js";

export interface CriticEdit {
  component: string;
  hypothesis: string;
}

export interface CriticObjection {
  code: string;
  detail: string;
}

export interface CriticResult {
  pass: boolean;
  objections: CriticObjection[];
}

const SECRET_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: "private-key-header", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { rule: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/ },
  { rule: "pgpassword", re: /\bPGPASSWORD\s*=\s*\S+/ },
  { rule: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "openai-style-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { rule: "github-pat", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { rule: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    rule: "quoted-secret-assignment",
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|credential)s?\b["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{10,}["']/i,
  },
];

const TENANT_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: "deploy-path", re: /\/srv\/papercompany\// },
  { rule: "tenant-host", re: /\bpapercompany\.showk\.ing\b/ },
  {
    rule: "hardcoded-uuid",
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
  },
];

const KNOWN_COMPONENTS = new Set<string>(HARNESS_COMPONENTS);

/** Test/fixture paths are exempt from tenant patterns (UUID fixtures are legal). */
function isTestFile(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|fixtures?|mocks?)\//i.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)
  );
}

/**
 * Screen a unified diff plus its declared edits. Objection codes:
 * hardcoded-secret, tenant-hardcoding, missing-hypothesis, unknown-component,
 * denylist-match. Details carry file:line and the rule name — never the secret.
 */
export function screenCandidateDiff(input: {
  diff: string;
  edits: CriticEdit[];
  extraDenylist?: RegExp[];
}): CriticResult {
  const objections: CriticObjection[] = [];

  for (const edit of input.edits) {
    if (!edit.hypothesis || !edit.hypothesis.trim()) {
      objections.push({
        code: "missing-hypothesis",
        detail: `edit component=${edit.component} has an empty hypothesis`,
      });
    }
    if (!KNOWN_COMPONENTS.has(edit.component)) {
      objections.push({
        code: "unknown-component",
        detail: `component=${edit.component} is not in HARNESS_COMPONENTS`,
      });
    }
  }

  let currentFile = "";
  let lineNo = 0;
  for (const line of input.diff.split("\n")) {
    lineNo += 1;
    // `+++ <path>` file headers are metadata, not added content; an added line
    // whose payload begins with `++` has no following space and stays scanned.
    if (/^\+\+\+\s/.test(line)) {
      const m = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line.trim());
      currentFile = m?.[1]?.trim() ?? "";
      continue;
    }
    if (!line.startsWith("+")) continue;
    const inTest = isTestFile(currentFile);
    for (const { rule, re } of SECRET_PATTERNS) {
      if (re.test(line)) {
        objections.push({
          code: "hardcoded-secret",
          detail: `${currentFile}:${lineNo} matched ${rule}`,
        });
        break;
      }
    }
    if (!inTest) {
      for (const { rule, re } of TENANT_PATTERNS) {
        if (re.test(line)) {
          objections.push({
            code: "tenant-hardcoding",
            detail: `${currentFile}:${lineNo} matched ${rule}`,
          });
          break;
        }
      }
    }
    for (const re of input.extraDenylist ?? []) {
      if (re.test(line)) {
        objections.push({
          code: "denylist-match",
          detail: `${currentFile}:${lineNo} matched /${re.source}/`,
        });
      }
    }
  }

  return { pass: objections.length === 0, objections };
}
