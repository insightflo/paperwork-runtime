/**
 * Stage 4.A differential parity: crates/schedule-core (Rust stdin/stdout JSON
 * CLI) vs server/src/services/cron.ts (authoritative TS). Every case feeds the
 * same inputs to both implementations and requires identical outputs — parsed
 * field sets, exact thrown error messages, next-run epochs, and the deliberate
 * non-Vixie DOM-AND-DOW semantics the TS implementation keeps.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { nextCronTickFromExpression, parseCron, validateCron } from "../services/cron.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/schedule-core/target/release/paperclip-schedule-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/schedule-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 240_000);

type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
function tsOutcome(fn: () => unknown): Outcome {
  try {
    return { threw: false, value: fn() };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}
// Rust contract: domain errors exit 1 with the TS message on stderr.
function rustOutcome(subcommand: string, payload: unknown): Outcome {
  const res = spawnSync(rustBin, [subcommand], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}

// validateCron(null|message) vs {valid,error}; parseCron(throw|ParsedCron) vs
// exit1|{ok,parsed:{minutes,hours,daysOfMonth,months,daysOfWeek}}.
function expectParseParity(expression: string): void {
  const tsError = validateCron(expression);
  const rv = rustOutcome("validate", { expression });
  if (rv.threw) throw new Error(`validate spawned error: ${rv.error}`);
  expect(rv.value).toEqual({ valid: tsError === null, error: tsError });
  const t = tsOutcome(() => parseCron(expression));
  const r = rustOutcome("parse", { expression });
  if (t.threw !== r.threw) {
    throw new Error(`parse throw mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (t.threw && r.threw) {
    expect(r.error).toBe(t.error); // exact message parity (en dash included)
  } else if (!r.threw) {
    expect((r.value as { parsed: unknown }).parsed).toEqual(t.value);
  }
}

// nextCronTickFromExpression(Date|null) vs {ok,nextMs:number|null}; returns the
// shared epoch so callers can pin wall-clock expectations.
function expectNextRunParity(expression: string, afterMs: number): number | null {
  const t = tsOutcome(() => nextCronTickFromExpression(expression, new Date(afterMs)));
  const r = rustOutcome("next-run", { expression, afterMs });
  if (t.threw !== r.threw) {
    throw new Error(`next-run throw mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (t.threw && r.threw) {
    expect(r.error).toBe(t.error);
    return null;
  }
  const rustMs = (r.value as { nextMs: number | null }).nextMs;
  const tsMs = t.value === null ? null : (t.value as Date).getTime();
  expect(rustMs).toBe(tsMs);
  return tsMs;
}

const VALID_EXPRESSIONS: string[] = [
  "* * * * *",
  "0 0 * * *",
  "59 23 31 12 6",
  "*/15 */6 */2 */3 */2",
  "45,5,5 */15 1-7 1,4 0-6",
  "0-30/5 9-17/2 1,15,28 3-9/3 1-5",
  "10/15 1 1 1 1",
  "1e2,5 * * * *", // parseInt("1e2") = 1
  "+5 * * * *", // parseInt("+5") = 5
  "0x10 * * * *", // radix-10 stops at 'x'
  "07,08 * * * *",
  "1.5,2 * * * *", // parseInt("1.5") = 1
  "1-2-3 * * * *", // destructure keeps [a,b]
  "5/2/3 * * * *", // step "2/3" -> parseInt = 2
  "1-2abc/5 * * * *", // parseInt("2abc") = 2
  "*/5x * * * *", // step "5x" -> parseInt = 5
  "* * * * 0",
  "  *\t*  * * *  ", // trim + tab separator
  "\uFEFF5 * * * *", // BOM is JS whitespace -> parseInt 5
];

const INVALID_EXPRESSIONS: string[] = [
  "",
  "   ",
  "* * *",
  "* * * * * *",
  "60 * * * *",
  "* 24 * * *",
  "* * 0 * *",
  "* * 32 * *",
  "* * * 0 *",
  "* * * 13 *",
  "* * * * 7",
  "1-0 * * * *",
  "-5 * * * *",
  "*/0 * * * *",
  "*/-3 * * * *",
  "*/abc * * * *",
  "a,,2 * * * *",
  "1,,2 * * * *",
  "x-y * * * *",
  "6-0/2 * * * *", // step over empty range -> Empty result
  "/5 * * * *", // empty step base
  "99999999999999999999 * * * *", // f64 rounds to 1e20 in the message
  "9223372036854775808 * * * *", // 2^63 prints shortest round-trip ...776000
  "12345678901234567890 * * * *", // 17+ sig digits print shortest ...567000
  "1234567890123456789012 * * * *", // >= 1e21 -> e+21 message
  "\u00855 * * * *", // NEL is not JS whitespace -> parseInt NaN
  "5,\u00856 * * * *", // NEL after comma -> NaN element
  "*/\u00855 * * * *", // NEL step -> NaN
  "z * * * *",
  "* * * * MON",
];

const NEXT_RUN_CASES: Array<{ expr: string; afterMs: number }> = [
  { expr: "* * * * *", afterMs: 1736937045678 }, // seconds + ms roll forward
  { expr: "* * * * *", afterMs: 1000.5 }, // TimeClip truncation
  { expr: "*/15 * * * *", afterMs: 1736935600000 },
  { expr: "0 0 * * *", afterMs: 1767206370000 }, // year boundary
  { expr: "0 0 * * *", afterMs: -30000 }, // pre-epoch
  { expr: "59 10 * * *", afterMs: 1736938770000 }, // next day via hour roll
  { expr: "0 0 1 1 *", afterMs: 1767225600000 },
  { expr: "*/7 */5 * * *", afterMs: 1736937045678 },
  { expr: "30 8 * 6 5", afterMs: 1735689600000 }, // Fridays in June only
  { expr: "0 9 * * 1-5", afterMs: 1763816400000 }, // weekday gate over a Saturday
  { expr: "5,35 9,18 1,15 * *", afterMs: 1735689600000 }, // list combos
  { expr: "0-30/6 12 * * *", afterMs: 1736937045678 }, // range step
  { expr: "0 0 * 2 *", afterMs: 1735689600000 }, // February daily midnights
  { expr: "0 0 29 2 *", afterMs: -100000 }, // pre-epoch leap -> 1972-02-29
  { expr: "60 * * * *", afterMs: 1735689600000 }, // throws identical range error
  { expr: "* * * *", afterMs: 1735689600000 }, // throws identical field-count error
];

describe("paperclip-schedule-core stage 4.A parity", () => {
  it.each(VALID_EXPRESSIONS)("validate+parse parity (valid): %s", (expr) => {
    expectParseParity(expr);
  });

  it.each(INVALID_EXPRESSIONS)("validate+parse parity (invalid): %s", (expr) => {
    expect(validateCron(expr)).not.toBeNull();
    expectParseParity(expr);
  });

  it.each(NEXT_RUN_CASES)("next-run parity: $expr @ $afterMs", ({ expr, afterMs }) => {
    expectNextRunParity(expr, afterMs);
  });

  it("keeps non-Vixie DOM-AND-DOW semantics — both fields must match", () => {
    // Vixie OR semantics would fire on the next Monday (2025-11-24) after
    // 2025-11-21; AND semantics must wait for a 15th that is a Monday.
    const monday15 = expectNextRunParity("0 9 15 * 1", 1763683200000);
    expect(new Date(monday15!).toISOString()).toBe("2025-12-15T09:00:00.000Z");
    // Friday the 13th: day-of-week 5 AND day-of-month 13 simultaneously.
    const friday13 = expectNextRunParity("0 12 13 * 5", 1735689600000);
    expect(new Date(friday13!).toISOString()).toBe("2025-06-13T12:00:00.000Z");
    // 31st that is also a Sunday — skips every other 31st and Sunday.
    const sunday31 = expectNextRunParity("0 0 31 * 0", 1735689600000);
    const d = new Date(sunday31!);
    expect(d.getUTCDate()).toBe(31);
    expect(d.getUTCDay()).toBe(0);
    expect(d.toISOString()).toBe("2025-08-31T00:00:00.000Z");
  });

  it("honors leap-year Feb 29 and skips non-leap centuries", () => {
    expect(expectNextRunParity("0 0 29 2 *", 1735689600000)).toBe(1835395200000); // 2028-02-29
    expect(expectNextRunParity("0 0 29 2 *", 3981484860000)).toBe(4233686400000); // 2104-02-29 (2100 not leap)
  });

  it("returns null at the search cap for impossible schedules", () => {
    expect(expectNextRunParity("0 0 30 2 *", 1735689600000)).toBeNull(); // Feb 30 never exists
    expect(expectNextRunParity("0 0 31 4 *", 1735689600000)).toBeNull(); // Apr 31 never exists
  });
});
