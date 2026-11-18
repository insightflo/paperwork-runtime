// server/src/__tests__/qa-remediation-file-owner-rust-parity.test.ts
//
// C5 — Rust file-owner(paperclip-qa-file-owner)가 Python helper(qa-remediation-file-owner.py)와
//   동일 계약을 지키는지 실제 프로세스·파일시스템으로 검증한다. beforeAll 에서 cargo build --release 로
//   최신 이진을 보장한다(콜드 CI 러너 포함). FS·커널·프로세스 mock 없음 — 종료 관측, 양성 lock_wait
//   대기(마감은 실패 감지용), 자식·임시 디렉터리 전량 정리 규칙은 qa-remediation-file-owner.test.ts 와 동일.

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import {
  QaRemediationFileOwner,
  QaRemediationFileOwnerError,
  runGuardedPublication,
  type FileOwnerPublishItem,
} from "../services/workflow/control-flow/qa-remediation-file-owner.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const helperPath = fileURLToPath(new URL("../services/workflow/control-flow/qa-remediation-file-owner.py", import.meta.url));
const rustBin = join(repoRoot, "crates/qa-file-owner/target/release/paperclip-qa-file-owner");
const BEFORE = "before bytes\n";
const AFTER = "after bytes\n";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const owners = new Set<QaRemediationFileOwner>();
const begins: Promise<QaRemediationFileOwner>[] = [];
const children = new Set<ChildProcess>();
const workspaces: string[] = [];

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin, ["build", "--release", "--manifest-path", join(repoRoot, "crates/qa-file-owner/Cargo.toml")], { encoding: "utf8" });
}, 120_000);

const reapChildren = () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  children.clear();
};

afterEach(async () => {
  const stop = async () => (await Promise.allSettled([...owners].map((owner) => owner.abort())))
    .flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  const failures = await stop();
  owners.clear();
  for (const result of await Promise.allSettled(begins.splice(0))) if (result.status === "fulfilled") owners.add(result.value);
  failures.push(...await stop());
  owners.clear();
  reapChildren();
  if (failures.length) throw new AggregateError(failures, "failed to stop an owned helper");
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  reapChildren();
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(fileMode = 0o600): { dir: string; lockRoot: string; file: string } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "c5-rust-parity-"));
  const lockRoot = join(dir, "guards");
  mkdirSync(lockRoot, { mode: 0o700 });
  const file = join(dir, "target.txt");
  writeFileSync(file, BEFORE, { mode: fileMode });
  workspaces.push(dir);
  return { dir, lockRoot, file };
}

function item(target: string, before: string, after: string): FileOwnerPublishItem {
  return {
    target,
    beforeSha256: sha(before), beforeSize: Buffer.byteLength(before),
    afterSha256: sha(after), afterSize: Buffer.byteLength(after),
    bytesB64: Buffer.from(after, "utf8").toString("base64"),
  };
}

const begin = (lockRoot: string, targets: readonly string[], onEvent?: (event: { readonly type: "lock_wait"; readonly target: string }) => void) => {
  const tracked = QaRemediationFileOwner.begin({ lockRoot, targets, pythonCommand: rustBin, helperPath, onEvent })
    .then((owner) => { owners.add(owner); return owner; });
  begins.push(tracked);
  return tracked;
};

function eventSink() {
  const seen: string[] = [];
  let resolve!: (value: string[]) => void;
  const promise = new Promise<string[]>((settled) => { resolve = settled; });
  return { promise, seen, push: (target: string) => { seen.push(target); resolve(seen); } };
}

/** 마감은 실패 감지용일 뿐 — 기다림의 근거는 양성 이벤트 자체다(임의 sleep 아님). */
const waitFor = <T>(promise: Promise<T>, what: string, deadlineMs = 15_000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), deadlineMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });

/** raw 프로토콜 프로브 — stdio close 관측 후 출력 파싱. python·rust 동일 호출 경로. */
async function raw(command: string, args: readonly string[], lines: readonly string[]) {
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", (error) => reject(new Error(`raw spawn failed: ${error.message}`)));
    child.on("close", (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { output += chunk; });
  for (const line of lines) child.stdin!.write(line);
  const exit = await closed;
  const frames = output.trim() ? output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  return { exit, frames };
}

it("runtime capability 은 rust 이진을 configured 로 보고하고 begin + close 를 정상 완료한다", async () => {
  const { lockRoot, file } = workspace();
  const runtime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: rustBin });
  const capability = await runtime.capability;
  expect(capability.status).toBe("configured");
  if (capability.status !== "configured") throw capability.error;
  expect(capability.pythonCommand).toBe(rustBin);
  const owner = await runtime.begin([file]);
  owners.add(owner);
  expect(await owner.close()).toEqual({ code: 0, signal: null });
});

it("runGuardedPublication 은 원자 게시·mode 보존·guard 유지·held 미기록을 재현한다", async () => {
  const { dir, lockRoot, file } = workspace(0o755);
  const grant = { revalidateAuthority: async () => ({ authorized: true }) };
  const published = await runGuardedPublication({
    lockRoot, targets: [file], pythonCommand: rustBin, helperPath,
    items: [item(file, BEFORE, AFTER)], ...grant,
  });
  if (published.outcome !== "published") throw new Error(`expected published, got ${published.outcome}`);
  expect(published.files[0]?.status).toBe("applied");
  expect(published.helperExit).toEqual({ code: 0, signal: null });
  expect(readFileSync(file, "utf8")).toBe(AFTER);
  expect(statSync(file).mode & 0o777).toBe(0o755);  // 원본 mode 보존
  const held = await runGuardedPublication({
    lockRoot, targets: [file], pythonCommand: rustBin, helperPath,
    items: [item(file, "wrong before\n", "never\n")], ...grant,
  });
  if (held.outcome !== "held") throw new Error(`expected held, got ${held.outcome}`);
  expect(held.files[0]?.status).toBe("mismatch_held");
  expect(held.files[0]?.observedSha256).toBe(sha(AFTER));  // 실측 증거
  expect(held.helperExit).toEqual({ code: 0, signal: null });
  expect(readFileSync(file, "utf8")).toBe(AFTER);  // 불일치는 절대 덮어쓰지 않는다
  expect(readdirSync(lockRoot)).toHaveLength(1);  // guard 파일은 절대 unlink 되지 않는다
  expect(readdirSync(dir).filter((name) => name.startsWith(".c5pub-"))).toEqual([]);  // temp 잔존물 없음
});

it("동시 begin 은 lock_wait 후 첫 helper 의 close 까지 대기하고 이관 뒤 게시한다", async () => {
  const { lockRoot, file } = workspace();
  const first = await begin(lockRoot, [file]);
  const waits = eventSink();
  const secondPromise = begin(lockRoot, [file], (event) => waits.push(event.target));
  await waitFor(waits.promise, "lock_wait");  // 양성 비차단 경합 신호 — 게시 전에 확보
  expect(await first.close()).toEqual({ code: 0, signal: null });
  const second = await secondPromise;  // close 이후에만 ready
  expect(waits.seen).toEqual([file]);
  const published = await second.publish([item(file, BEFORE, "contender wins\n")]);
  expect(published.outcome).toBe("published");
  expect(readFileSync(file, "utf8")).toBe("contender wins\n");
  expect(await second.close()).toEqual({ code: 0, signal: null });
});

it("자식 실종(SIGKILL)은 커널 flock 을 해제하고 다음 rust owner 가 즉시 획득한다", async () => {
  const { lockRoot, file } = workspace();
  const first = await begin(lockRoot, [file]);
  const abort = await first.abort();  // 자기 helper SIGKILL + 실제 종료 대기
  expect(abort.exit).toEqual({ code: null, signal: "SIGKILL" });  // 실측 종료, 가공 아님
  expect(abort.actualResult).toBe("unknown");
  const second = await begin(lockRoot, [file]);  // 커널이 guard 를 해제했다
  expect(await second.close()).toEqual({ code: 0, signal: null });
  expect(readdirSync(lockRoot)).toHaveLength(1);  // guard 잔존, 잠금만 해제
});

it("래퍼 거부는 Python 과 같은 code 를 실측 종료와 함께 돌려준다", async () => {
  const { dir, lockRoot, file } = workspace();
  const link = join(dir, "link.txt");
  symlinkSync(file, link);
  const refusal = await begin(lockRoot, [link]).then(
    () => { throw new Error("symlinked target unexpectedly began"); },
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(QaRemediationFileOwnerError);
  expect(refusal).toMatchObject({ code: "alias_refused" });
  const owner = await begin(lockRoot, [file]);
  const scoped = await owner.publish([item(join(dir, "outside.txt"), BEFORE, "x\n")]).then(
    () => { throw new Error("out-of-scope publication unexpectedly succeeded"); },
    (error: unknown) => error,
  );
  expect(scoped).toBeInstanceOf(QaRemediationFileOwnerError);
  expect(scoped).toMatchObject({ code: "item_out_of_scope" });
  const exit = (scoped as { exit?: { code: number | null; signal: string | null } | null }).exit;
  expect(exit).toBeDefined();
  expect(exit).not.toBeNull();  // 공개 거부는 관측된 자식 종료를 포함한다
  const next = await begin(lockRoot, [file]);  // 거부된 자식 사망 → guard 해제
  expect(await next.close()).toEqual({ code: 0, signal: null });
});

it("raw JSONL 거부는 python 과 rust 가 exit code·error code·id 를 동일하게 돌려준다", async () => {
  const { lockRoot, file } = workspace();
  const cases: { name: string; lines(): string[]; code: string; id: string | null; prep?(): void }[] = [
    { name: "bad_json", code: "bad_json", id: null, lines: () => ["this is not json\n"] },
    { name: "bad_version", code: "bad_version", id: "bv", lines: () => [`${JSON.stringify({ v: 2, id: "bv", op: "close" })}\n`] },
    { name: "duplicate_targets", code: "duplicate_targets", id: "dt",
      lines: () => [`${JSON.stringify({ v: 1, id: "dt", op: "begin", lockRoot, targets: [file, file] })}\n`] },
    { name: "bad_target", code: "bad_target", id: "bt",
      lines: () => [`${JSON.stringify({ v: 1, id: "bt", op: "begin", lockRoot, targets: ["/a/../b"] })}\n`] },
    { name: "unsafe_guard", code: "unsafe_guard", id: "ug",
      prep: () => { const guard = join(lockRoot, `c5-${sha(file)}.guard`); writeFileSync(guard, "", { mode: 0o600 }); chmodSync(guard, 0o666); },
      lines: () => [`${JSON.stringify({ v: 1, id: "ug", op: "begin", lockRoot, targets: [file] })}\n`] },
  ];
  for (const entry of cases) {
    entry.prep?.();
    const py = await raw("python3", [helperPath], entry.lines());
    const rs = await raw(rustBin, [helperPath], entry.lines());
    for (const probe of [py, rs]) {
      expect(probe.exit.code, entry.name).toBe(2);
      expect(probe.exit.signal, entry.name).toBeNull();
      expect(probe.frames.at(-1), entry.name).toMatchObject({ type: "error", code: entry.code, id: entry.id });
    }
    expect(rs.frames.at(-1)?.code, entry.name).toBe(py.frames.at(-1)?.code);
    expect(rs.frames.at(-1)?.id, entry.name).toBe(py.frames.at(-1)?.id);
  }
});
