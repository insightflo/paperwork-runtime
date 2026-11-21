/**
 * [목적] schedule-core-client 동기 시임의 cron.ts wiring 검증.
 *   - 게이트 OFF(PAPERCLIP_SCHEDULE_CORE_BIN 미설정) → 스폰 없는 TS 경로가 기존과 동일.
 *   - 설정 + 실 release bin → parse/validate/next-run 이 유효·무효·윤년·경계 전 케이스에서
 *     TS 결과와 동일(메시지는 정확 일치).
 *   - 고장 bin(비JSON/non-zero/없는 경로/상대경로) → 던지지 않고 조용히 TS 로 폴백.
 *   - lone surrogate 입력은 위임 전 검출돼 TS 원문 동작을 유지한다(U+FFFD 치환 없음).
 *   - non-finite Date 는 위임하지 않고 TS 본문을 관측한다(canned marker 미관측으로 증명).
 *   전수 parity 는 schedule-core-stage1-parity.test.ts 가 담당한다(범위 밖).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextCronTickFromExpression, parseCron, validateCron } from "../services/cron.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/schedule-core/target/release/paperclip-schedule-core");
const ENV = "PAPERCLIP_SCHEDULE_CORE_BIN";

let dir: string;
let cannedBin: string;
let cannedInvalidBin: string;
let garbageBin: string;
let failingBin: string;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

/** canned 응답은 전부 TS 결과와 다른 rust-arm marker — Rust 팔 실행을 증명한다. */
const CANNED_SCRIPT = `cat >/dev/null
case "$1" in
  parse) echo '{"ok":true,"parsed":{"minutes":[1],"hours":[2],"daysOfMonth":[3],"months":[4],"daysOfWeek":[5]}}' ;;
  validate) echo '{"valid":true,"error":null}' ;;
  next-run) echo '{"ok":true,"nextMs":1234567890123}' ;;
esac`;

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/schedule-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "schedule-core-wiring-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  cannedInvalidBin = await writeBin(
    "canned-invalid",
    'cat >/dev/null; echo \'{"valid":false,"error":"rust-arm-invalid"}\'',
  );
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  failingBin = await writeBin("failing", "cat >/dev/null; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv(ENV, ""); // 게이트 OFF — TS 팔(테스트 기본 상태)
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 게이트를 닫고 TS 본문 기준값을 계산한다(위임 중이어도 참조값은 항상 TS 여야 한다). */
function tsArm<T>(fn: () => T): T {
  const prev = process.env[ENV];
  delete process.env[ENV];
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
}

function thrownMessage(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

const VALID_EXPRESSIONS: string[] = [
  "* * * * *",
  "0 0 * * *",
  "*/15 */6 */2 */3 */2",
  "45,5,5 */15 1-7 1,4 0-6",
  "1e2,5 * * * *", // parseInt("1e2") = 1
  "07,08 * * * *",
  "  *\t*  * * *  ", // trim + tab separator
  "\uFEFF5 * * * *", // BOM is JS whitespace -> parseInt 5
];

const INVALID_EXPRESSIONS: string[] = [
  "",
  "* * *",
  "60 * * * *",
  "*/0 * * * *",
  "1-0 * * * *",
  "-5 * * * *",
  "a,,2 * * * *",
  "99999999999999999999 * * * *", // f64 반올림 메시지
  "1234567890123456789012 * * * *", // >= 1e21 -> e+21 메시지
  "\u00855 * * * *", // NEL is not JS whitespace -> parseInt NaN
  "z * * * *",
  "* * * * MON",
];

const NEXT_RUN_CASES: Array<{ expr: string; afterMs: number }> = [
  { expr: "* * * * *", afterMs: 1736937045678 }, // 초+ms 롤포워드
  { expr: "* * * * *", afterMs: 1000.5 }, // TimeClip truncation
  { expr: "*/15 * * * *", afterMs: 1736935600000 },
  { expr: "0 0 * * *", afterMs: 1767206370000 }, // 연도 경계
  { expr: "0 0 * * *", afterMs: -30000 }, // pre-epoch
  { expr: "59 10 * * *", afterMs: 1736938770000 }, // hour roll 다음날
  { expr: "0 0 29 2 *", afterMs: 1735689600000 }, // 윤년 2028-02-29
  { expr: "0 0 29 2 *", afterMs: 3981484860000 }, // 2100 비윤년 → 2104-02-29
  { expr: "0 0 30 2 *", afterMs: 1735689600000 }, // 불가능 일정 → 탐색 한도 null
];

describe("schedule-core wiring", () => {
  it("unset gate runs the TS arm with pinned values", () => {
    expect(parseCron("45,5,5 */15 1-7 1,4 0-6")).toEqual({
      minutes: [5, 45],
      hours: [0, 15],
      daysOfMonth: [1, 2, 3, 4, 5, 6, 7],
      months: [1, 4],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(validateCron("* * * * *")).toBeNull();
    expect(validateCron("60 * * * *")).toBe("Value 60 out of range [0–59] for cron minute field");
    expect(nextCronTickFromExpression("*/15 * * * *", new Date(1736935600000)))
      .toEqual(new Date(1736936100000));
  });

  it("canned bin proves the Rust arm runs and its shapes route through", () => {
    vi.stubEnv(ENV, cannedBin);
    expect(parseCron("* * * * *")).toEqual({
      minutes: [1], hours: [2], daysOfMonth: [3], months: [4], daysOfWeek: [5],
    });
    expect(validateCron("* * * * *")).toBeNull(); // valid marker → null(유효 채널)
    expect(nextCronTickFromExpression("* * * * *", new Date(0)))
      .toEqual(new Date(1234567890123));
    vi.stubEnv(ENV, cannedInvalidBin);
    expect(validateCron("* * * * *")).toBe("rust-arm-invalid"); // 무효 메시지도 그대로 흐른다
  });

  it("live Rust arm matches the TS arm on valid expressions", () => {
    vi.stubEnv(ENV, rustBin);
    for (const expr of VALID_EXPRESSIONS) {
      expect(parseCron(expr), expr).toEqual(tsArm(() => parseCron(expr)));
      expect(validateCron(expr), expr).toBeNull();
    }
  });

  it("live Rust arm matches the TS arm on invalid expressions (exact messages)", () => {
    vi.stubEnv(ENV, rustBin);
    for (const expr of INVALID_EXPRESSIONS) {
      const tsError = tsArm(() => validateCron(expr));
      expect(tsError, expr).not.toBeNull();
      expect(validateCron(expr), expr).toBe(tsError); // 무효 메시지 정확 일치
      expect(thrownMessage(() => parseCron(expr)), expr).toBe(tsError); // Rust 팔 → TS throw
      expect(thrownMessage(() => tsArm(() => parseCron(expr))), expr).toBe(tsError);
    }
  });

  it("live Rust arm matches the TS arm on next-run leap/boundary/impossible cases", () => {
    vi.stubEnv(ENV, rustBin);
    for (const { expr, afterMs } of NEXT_RUN_CASES) {
      const tsNext = tsArm(() => nextCronTickFromExpression(expr, new Date(afterMs)));
      const rustNext = nextCronTickFromExpression(expr, new Date(afterMs));
      expect(rustNext?.getTime() ?? null, `${expr} @ ${afterMs}`).toBe(tsNext?.getTime() ?? null);
    }
  });

  it("non-JSON stdout falls back to TS silently for all three entries", () => {
    vi.stubEnv(ENV, garbageBin);
    expect(parseCron("* * * * *")).toEqual(tsArm(() => parseCron("* * * * *")));
    expect(validateCron("60 * * * *")).toBe("Value 60 out of range [0–59] for cron minute field");
    expect(nextCronTickFromExpression("*/15 * * * *", new Date(1736935600000)))
      .toEqual(new Date(1736936100000));
  });

  it("non-zero exit falls back to TS without throwing", () => {
    vi.stubEnv(ENV, failingBin);
    expect(thrownMessage(() => parseCron("* * * * *"))).toBeNull();
    expect(parseCron("* * * * *")).toEqual(tsArm(() => parseCron("* * * * *")));
    expect(validateCron("* * * * *")).toBeNull();
    expect(nextCronTickFromExpression("* * * * *", new Date(1000.5))?.getTime()).toBe(60000);
  });

  it("missing binary path falls back to TS via the spawn-error arm", () => {
    vi.stubEnv(ENV, path.join(dir, "does-not-exist"));
    expect(thrownMessage(() => parseCron("* * * * *"))).toBeNull();
    expect(parseCron("* * * * *")).toEqual(tsArm(() => parseCron("* * * * *")));
    expect(validateCron("1-0 * * * *")).not.toBeNull();
    expect(nextCronTickFromExpression("* * * * *", new Date(1000.5))?.getTime()).toBe(60000);
  });

  it("relative env path keeps the gate closed silently", () => {
    vi.stubEnv(ENV, "relative/bin");
    expect(parseCron("*/15 * * * *")).toEqual(tsArm(() => parseCron("*/15 * * * *")));
    expect(validateCron("* * * * *")).toBeNull();
    expect(nextCronTickFromExpression("* * * * *", new Date(0))?.getTime()).toBe(60000);
  });

  it("lone surrogate input keeps the exact TS arm (no U+FFFD substitution)", () => {
    vi.stubEnv(ENV, rustBin);
    const expr = "\uD800 * * * *";
    const tsError = tsArm(() => validateCron(expr));
    expect(tsError).toBe('Invalid value "\uD800" in cron minute field');
    expect(validateCron(expr)).toBe(tsError); // 치환됐다면 "\uFFFD" 메시지로 어긋난다
    expect(thrownMessage(() => parseCron(expr))).toBe(tsError);
  });

  it("non-finite Date input skips delegation and rides the TS arm", () => {
    // cannedBin 위임 시 marker Date(1234567890123)가 관측될 것 — null 관측은 미위임 증명이다.
    vi.stubEnv(ENV, cannedBin);
    expect(nextCronTickFromExpression("* * * * *", new Date(NaN))).toBeNull();
  });
});
