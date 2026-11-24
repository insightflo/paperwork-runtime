/**
 * [CI-REDUCE 2026-11-13] scripts/ci-scope.sh 트리거 행렬 시험.
 *
 * 왜: pr.yml 은 이 스크립트의 출력만 소비한다. 판정이 틀리면 (a) 전체 스위트가 영영 돌지 않아
 *   병합 파이프라인이 CI 판정 근거를 못 찾거나(과소 실행), (b) 줄이려던 전량 실행이 그대로 돌아
 *   비용 절감이 사라진다(과대 실행). 그래서 워크플로 YAML 이 아니라 **실제 스크립트**를 실행해
 *   이벤트 조합마다 기대 출력을 고정한다.
 *
 * Stage 3 P0a 계약: ci-full 은 one-shot — EVENT_ACTION=labeled ∧ EVENT_LABEL≈ci-full 만
 *   full=true·consume_label=true. 라벨이 PR 에 남아 있어도 후속 synchronize/무관 labeled 는 fast 만.
 *   rust_changed 는 fail-closed — 증명 목록(RUST_CHANGED_FILE_LIST)이 깨끗할 때만 false 이며,
 *   rust_changed=true 이면 docs_only 도 강제 false(rs→md 리네임 우회 차단).
 *
 * 검증하지 않는 것: GitHub payload 형태, 워크플로 `if:` 문법(actionlint), 실제 잡 기동(CI 증거 필요).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../../../scripts/ci-scope.sh");
const sandbox = mkdtempSync(join(tmpdir(), "ci-scope-"));

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

let fileSeq = 0;
/** 파일 목록 픽스처를 만들고 경로를 돌려준다. null 이면 목록 자체를 주지 않는다(모르는 상태 → fail-closed). */
function writeList(files: string[] | null): string | undefined {
  if (files === null) return undefined;
  fileSeq += 1;
  const path = join(sandbox, `list-${fileSeq}.txt`);
  writeFileSync(path, files.map((f) => `${f}\n`).join(""));
  return path;
}

type Scope = { fast: string; heavy: string; full: string; docs_only: string; consume_label: string; rust_changed: string; reason: string };

function runScope(input: {
  eventName?: string; action?: string; eventLabel?: string; draft?: string;
  labels?: string; inputScope?: string; changed?: string[] | null; rustChanged?: string[] | null;
}): Scope {
  const changedPath = writeList(input.changed === undefined ? ["server/src/index.ts"] : input.changed);
  const rustPath = writeList(input.rustChanged === undefined ? null : input.rustChanged);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", EVENT_NAME: input.eventName ?? "pull_request",
    EVENT_ACTION: input.action ?? "synchronize", EVENT_LABEL: input.eventLabel ?? "",
    PR_DRAFT: input.draft ?? "false", PR_LABELS: input.labels ?? "",
    INPUT_SCOPE: input.inputScope ?? "", CI_FULL_LABEL: "ci-full",
  };
  if (changedPath !== undefined) env.CHANGED_FILE_LIST = changedPath;
  if (rustPath !== undefined) env.RUST_CHANGED_FILE_LIST = rustPath;
  const stdout = execFileSync("/bin/bash", [SCRIPT], { env, encoding: "utf8" });
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out as Scope;
}

/** Rust 무관이 증명된 TS-only diff — rust_changed=false 가 되려면 이 목록이 필요하다. */
const TS_ONLY = ["server/src/index.ts", "ui/src/App.tsx"];

describe("ci-scope.sh trigger matrix", () => {
  it("runs only the light job on a plain push", () => {
    expect(runScope({ action: "synchronize", changed: ["server/src/routes/approvals.ts"], rustChanged: TS_ONLY })).toEqual({
      fast: "true", heavy: "true", full: "false", docs_only: "false",
      consume_label: "false", rust_changed: "false", reason: "push-fast-only",
    });
  });
  it("does not run the full suite on later pushes while the one-shot label lingers", () => {
    // ci-full 소비 후 라벨이 PR 에 남아 있어도 synchronize 는 경량만 돌린다.
    const scope = runScope({ action: "synchronize", labels: "ci-full", rustChanged: TS_ONLY });
    expect(scope.full).toBe("false");
    expect(scope.consume_label).toBe("false");
    expect(scope.reason).toBe("push-fast-only");
  });
  it("opens and reopens like a plain push (no full suite without an explicit signal)", () => {
    for (const action of ["opened", "reopened"]) {
      const scope = runScope({ action });
      expect(scope.full).toBe("false");
      expect(scope.consume_label).toBe("false");
    }
  });
  it("ignores an unrelated labeled event even while ci-full is still on the PR", () => {
    const scope = runScope({ action: "labeled", eventLabel: "bug", labels: "bug, ci-full" });
    expect(scope.full).toBe("false");
    expect(scope.consume_label).toBe("false");
    expect(scope.reason).toBe("push-fast-only");
  });
  it("runs the full suite when the ci-full label is added (one-shot consume)", () => {
    const scope = runScope({ action: "labeled", eventLabel: "ci-full", labels: "ci-full" });
    expect(scope.full).toBe("true");
    expect(scope.heavy).toBe("true");
    expect(scope.consume_label).toBe("true");
    expect(scope.reason).toBe("ci-full-label");
  });
  it("matches the full label case-insensitively like GitHub Actions ==", () => {
    for (const eventLabel of ["ci-full", "CI-FULL", "Ci-Full"]) {
      const scope = runScope({ action: "labeled", eventLabel });
      expect(scope.full).toBe("true");
      expect(scope.consume_label).toBe("true");
    }
  });
  it("ignores labels that merely look like the full label", () => {
    const scope = runScope({ action: "labeled", eventLabel: "ci-full-extra", labels: "ci-full-extra" });
    expect(scope.full).toBe("false");
    expect(scope.consume_label).toBe("false");
    expect(scope.reason).toBe("push-fast-only");
  });
  it("still runs the full suite on a draft when the full label was attached explicitly", () => {
    // 병합 파이프라인은 드래프트 PR 에 라벨을 붙여 전체 스위트를 깨운다. 라벨 규칙이 드래프트보다 앞이다.
    const scope = runScope({ action: "labeled", eventLabel: "ci-full", draft: "true", labels: "ci-full" });
    expect(scope.full).toBe("true");
    expect(scope.consume_label).toBe("true");
  });
  it("runs nothing for draft pull requests", () => {
    expect(runScope({ draft: "true", action: "synchronize" })).toEqual({
      fast: "false", heavy: "false", full: "false", docs_only: "false",
      consume_label: "false", rust_changed: "true", reason: "draft",
    });
  });
  it("runs the full suite when the pull request becomes ready for review", () => {
    const scope = runScope({ action: "ready_for_review", draft: "false" });
    expect(scope.full).toBe("true");
    expect(scope.consume_label).toBe("false");
    expect(scope.reason).toBe("ready_for_review");
  });
  it("skips the heavy steps for docs-only changes", () => {
    const scope = runScope({
      action: "synchronize",
      changed: ["README.md", "docs/onboarding.md", "doc/SPEC.md"],
      rustChanged: ["README.md", "docs/onboarding.md", "doc/SPEC.md"],
    });
    expect(scope).toEqual({
      fast: "true", heavy: "false", full: "false", docs_only: "true",
      consume_label: "false", rust_changed: "false", reason: "push-fast-only+docs-only",
    });
  });
  it("judges docs_only solely from CHANGED_FILE_LIST on code<->doc moves", () => {
    // code->doc 리네임(3-dot 목록은 새 이름만 보임): rust 목록에 구 코드 경로가 있어도 docs_only 는 CHANGED 만 본다.
    const toDoc = runScope({ changed: ["doc/example.md"], rustChanged: ["doc/example.md", "server/old.ts"] });
    expect(toDoc.docs_only).toBe("true");
    expect(toDoc.rust_changed).toBe("false");
    // doc->code 리네임: 새 경로가 코드면 docs_only=false.
    expect(runScope({ changed: ["server/src/x.ts"], rustChanged: ["server/src/x.ts", "doc/old.md"] }).docs_only).toBe("false");
  });
  it("counts doc artifacts under doc/ and docs/ as documentation", () => {
    for (const path of ["docs/docs.json", "docs/flowmap/flowmap.html", "docs/logo.svg", "doc/a/b.png"]) {
      expect(runScope({ changed: [path], rustChanged: [path] }).docs_only).toBe("true");
    }
  });
  it("treats code files under doc/ and docs/ as code (never as docs-only)", () => {
    // 문서로 오인하면 전체 스위트가 돌지 않아 테스트 0회로 병합될 수 있다.
    for (const path of ["doc/scripts/run.sh", "docs/snippet.ts", "docs/schema.py", "doc/migrate.sql"]) {
      const scope = runScope({ changed: [path], rustChanged: [path] });
      expect(scope.docs_only).toBe("false");
      expect(scope.heavy).toBe("true");
    }
  });
  it("treats a single code file among docs as a code change", () => {
    const scope = runScope({ changed: ["README.md", "server/src/index.ts"], rustChanged: TS_ONLY });
    expect(scope.docs_only).toBe("false");
    expect(scope.heavy).toBe("true");
  });
  it("does not treat an unknown change list as docs-only", () => {
    const scope = runScope({ changed: [], rustChanged: [] });
    expect(scope.docs_only).toBe("false");
    expect(scope.heavy).toBe("true");
    expect(scope.rust_changed).toBe("true");
  });
  it("skips the full suite for docs-only changes even with the full label", () => {
    // pr.yml 은 대신 verify-tests-docs-only 잡을 성공으로 남겨 가드에 "전체 스위트 불필요"를 구조화해 알린다.
    const scope = runScope({
      action: "labeled", eventLabel: "ci-full",
      changed: ["README.md", "docs/docs.json"], rustChanged: ["README.md", "docs/docs.json"],
    });
    expect(scope.full).toBe("false");
    expect(scope.heavy).toBe("false");
    expect(scope.reason).toBe("ci-full-label+docs-only");
  });
  it("keeps the lockfile-bot dispatch path on policy only", () => {
    const scope = runScope({ eventName: "workflow_dispatch", action: "", draft: "", changed: ["README.md"], rustChanged: [] });
    expect(scope.fast).toBe("true");
    expect(scope.heavy).toBe("true");
    expect(scope.full).toBe("false");
    expect(scope.consume_label).toBe("false");
    expect(scope.rust_changed).toBe("true");
    expect(scope.reason).toBe("dispatch-policy");
  });
  it("runs the full suite for a manual dispatch with scope=full, even over a docs-only diff", () => {
    for (const changed of [["README.md"], null]) {
      const scope = runScope({ eventName: "workflow_dispatch", action: "", draft: "", inputScope: "full", changed });
      expect(scope.full).toBe("true");
      expect(scope.heavy).toBe("true");
      expect(scope.consume_label).toBe("false");
      expect(scope.rust_changed).toBe("true");
      expect(scope.reason).toBe("dispatch-full");
    }
  });
  it("marks rust_changed=false for a proven non-Rust list", () => {
    expect(runScope({ rustChanged: TS_ONLY }).rust_changed).toBe("false");
  });
  it("marks rust_changed=true when any Rust-path line is present", () => {
    for (const path of [
      "crates/foo/src/lib.rs", "Cargo.toml", "Cargo.lock", ".cargo/config.toml",
      "rust-toolchain.toml", "clippy.toml", ".clippy.toml", "crates/x/build.rs",
      "scripts/build-rust-workspace.sh", ".github/workflows/pr.yml", "scripts/ci-scope.sh",
    ]) {
      expect(runScope({ rustChanged: ["server/src/index.ts", path] }).rust_changed).toBe("true");
    }
  });
  it("marks rust_changed=true for an auto-merged rs rename even when CHANGED shows only the new name", () => {
    // crates/demo/src/example.rs -> fixtures/example.rs: 3-dot CHANGED 는 새 이름만, rust 합집합 목록은 구 경로도 담는다.
    const scope = runScope({ changed: ["fixtures/example.rs"], rustChanged: ["crates/demo/src/example.rs", "fixtures/example.rs"] });
    expect(scope.rust_changed).toBe("true");
    expect(scope.docs_only).toBe("false");
  });
  it("forces docs_only=false when rust_changed even if CHANGED_FILE_LIST is all docs", () => {
    const scope = runScope({ changed: ["doc/example.md"], rustChanged: ["crates/demo/src/example.rs", "doc/example.md"] });
    expect(scope.docs_only).toBe("false");
    expect(scope.rust_changed).toBe("true");
  });
  it("keeps rust_changed=true when the list is missing, empty, blank, or Git-quoted", () => {
    expect(runScope({ rustChanged: null }).rust_changed).toBe("true");
    expect(runScope({ rustChanged: [] }).rust_changed).toBe("true");
    expect(runScope({ rustChanged: ["", "   "] }).rust_changed).toBe("true");
    expect(runScope({ rustChanged: ['"crates/foo.rs"', "server/src/index.ts"] }).rust_changed).toBe("true");
  });
  it("mirrors every key into GITHUB_OUTPUT", () => {
    const outPath = join(sandbox, "github-output");
    writeFileSync(outPath, "");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", EVENT_NAME: "pull_request", EVENT_ACTION: "labeled", EVENT_LABEL: "ci-full",
      PR_DRAFT: "false", PR_LABELS: "", CI_FULL_LABEL: "ci-full",
      CHANGED_FILE_LIST: writeList(["server/src/index.ts"]) as string, GITHUB_OUTPUT: outPath,
    };
    execFileSync("/bin/bash", [SCRIPT], { env, encoding: "utf8" });
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("full=true");
    expect(written).toContain("heavy=true");
    expect(written).toContain("consume_label=true");
    expect(written).toContain("rust_changed=true");
    expect(written).toContain("reason=ci-full-label");
  });
});
// rollout test 1
// rollout test 2
