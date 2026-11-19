import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearRegisteredRuntimeSecretsForTests,
  redactBeforeTruncate,
  redactEmbeddedJson,
  redactSensitiveText,
  registerRuntimeSecrets,
  setNativeSecretRedactorDriver,
  type NativeSecretRedactorDriver,
} from "@paperclipai/adapter-utils/secret-redactor";
import { redactCurrentUserTextWithNative, resetNativeRedactorForTests } from "../redactor-native.js";
import {
  maskUserNameForLogs,
  redactCurrentUserText,
  redactCurrentUserValue,
} from "../log-redaction.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const libName = process.platform === "darwin"
  ? "libpaperclip_log_redactor.dylib"
  : "libpaperclip_log_redactor.so";
const libPath = path.join(repoRoot, "crates/log-redactor/target/release", libName);
const origLib = process.env.PAPERCLIP_REDACTOR_LIB;

function useJs(): void {
  delete process.env.PAPERCLIP_REDACTOR_LIB;
  resetNativeRedactorForTests();
}
function useNative(): void {
  process.env.PAPERCLIP_REDACTOR_LIB = libPath;
  resetNativeRedactorForTests();
}
// Runs fn once under pure JS, once under the N-API driver; both runs share the
// same assertions so any divergence fails the case outright.
function dual(fn: () => void): void {
  useJs();
  clearRegisteredRuntimeSecretsForTests();
  fn();
  useNative();
  clearRegisteredRuntimeSecretsForTests();
  expect(redactCurrentUserTextWithNative("probe", [], [], "*")).toBe("probe"); // native really live
  fn();
}

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/log-redactor/Cargo.toml")],
    { encoding: "utf8" },
  );
  expect(existsSync(libPath)).toBe(true);
}, 240_000);

afterEach(() => {
  if (origLib === undefined) delete process.env.PAPERCLIP_REDACTOR_LIB;
  else process.env.PAPERCLIP_REDACTOR_LIB = origLib;
  resetNativeRedactorForTests();
  clearRegisteredRuntimeSecretsForTests();
});

describe("paperclip-log-redactor N-API parity", () => {
  it("redacts registered secrets and token boundaries identically", () => {
    dual(() => {
      registerRuntimeSecrets(["x7Kq/9+secret=val", "acme-corp.internal"]);
      expect(redactSensitiveText("token=x7Kq/9+secret=val")).toBe("token=[redacted]");
      expect(redactSensitiveText("encoded=x7Kq%2F9%2Bsecret%3Dval")).toBe("encoded=[redacted]");
      expect(redactSensitiveText('escaped="x7Kq/9+secret=val"')).toBe('escaped="[redacted]"');
      const url = redactSensitiveText("see https://acme-corp.internal/v1 and X-Secret: acme-corp.internal");
      expect(url).toContain("https://acme-corp.internal/v1");
      expect(url).toContain("X-Secret: [redacted]");
      registerRuntimeSecrets(["abc12345"]);
      expect(redactSensitiveText("Authorization: abc12345_extra_tail")).toBe("Authorization: [redacted]");
      // token-boundary edges: concatenated prefixes must not leak
      expect(redactSensitiveText("ASIAABCDEFGHIJKLMNOP")).toBe("[redacted]");
      expect(redactSensitiveText("ASIAABCDEFGHIJKLMNOPx")).toBe("ASIAABCDEFGHIJKLMNOPx");
      expect(redactSensitiveText("ASIAABCDEFGHIJKLMNOPghp_12345678")).toBe("ASIAABCDEFGHIJKLMNOPghp_12345678");
      expect(redactSensitiveText("foo_whsec_12345678/ghp_12345678")).toBe("foo_whsec_12345678/[redacted]");
      expect(redactSensitiveText("a@b.com")).toBe("a@b.com");
      expect(redactSensitiveText("a@b.com", { emails: true })).toBe("[redacted-email]");
    });
  }, 60_000);

  it("pushes pre-init literal secrets verbatim on attach (zero double-URI-encode)", () => {
    useJs();
    registerRuntimeSecrets(["raw%20pre"]); // JS derives raw%2520pre into its literal set
    useNative(); // attach pushes the derived literals verbatim via setRegisteredLiteralSecrets
    expect(redactCurrentUserTextWithNative("probe", [], [], "*")).toBe("probe");
    expect(redactSensitiveText("a=raw%20pre")).toBe("a=[redacted]");
    expect(redactSensitiveText("b=raw%2520pre")).toBe("b=[redacted]"); // derived form forwarded
    expect(redactSensitiveText("c=raw%252520pre")).toBe("c=raw%252520pre"); // NOT double-encoded
    useJs(); // JS fallback stays warm after detach
    expect(redactSensitiveText("a=raw%20pre")).toBe("a=[redacted]");
  }, 60_000);

  it("matches headers, cookies, query secrets, PEM and JWT rules byte-for-byte", () => {
    dual(() => {
      expect(redactSensitiveText('Cookie: a="1"; b="2"\nkeep')).toBe("Cookie: [redacted]\nkeep");
      expect(redactSensitiveText("Authorization: Bearer verysecret1234")).toBe("Authorization: [redacted]");
      expect(redactSensitiveText("https://ex.com?code=1234abcd90&key=[redacted]&sig=abcdefghij")).toBe(
        "https://ex.com?code=[redacted]&key=[redacted]&sig=abcdefghij",
      );
      // QUERY_SECRET digit lookahead boundary: digit within first 256 chars triggers
      expect(redactSensitiveText(`?key=${"a".repeat(255)}1`)).toBe("?key=[redacted]");
      expect(redactSensitiveText(`?key=${"a".repeat(256)}1`)).toBe("?key=[redacted]");
      expect(redactSensitiveText(`?key=${"a".repeat(260)}1`)).toBe(`?key=${"a".repeat(260)}1`);
      expect(redactSensitiveText("-----BEGIN RSA PRIVATE KEY-----\nAAAA1234567890+/=="))
        .toBe("[redacted]");
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sig_part_abc";
      expect(redactSensitiveText(`tok=${jwt}`)).toBe("tok=[redacted]");
      expect(redactSensitiveText('api_key: "hunter2secret"')).toBe('api_key: "[redacted]"');
    });
  }, 60_000);

  it("matches JSON/embedded handling: EC262 key order, floats, surrogates, BOM, scan cap", () => {
    dual(() => {
      expect(redactSensitiveText('{"b":"Bearer 12345678","1":"x"}')).toBe('{"1":"x","b":"[redacted]"}');
      expect(redactSensitiveText('{"10":"Bearer verysecret1234","2":"ok"}')).toBe('{"2":"ok","10":"[redacted]"}');
      expect(redactSensitiveText('{"a":1.0}')).toBe('{"a":1.0}'); // written-form preserved
      expect(redactSensitiveText("abc\ud800def")).toBe("abc\ud800def"); // lone surrogate → native null → JS
      expect(redactSensitiveText('{"a":"\\uD83D"}')).toBe('{"a":"\\uD83D"}');
      expect(redactSensitiveText("\uFEFFtoken=abc12345")).toBe("\uFEFFtoken=[redacted]");
      const nested = 'WARN up={"headers":{"X-Tenant":"secret-t1","X-Region":"kr-1"},"ok":true}';
      const nestedOut = redactSensitiveText(nested);
      expect(nestedOut).toContain('"X-Tenant":"[redacted]"');
      expect(nestedOut).toContain('"ok":true');
      expect(nestedOut).not.toContain("secret-t1");
      const unclosed = 'ERROR failed: {"headers":{"Authorization":"Bearer topsecret123';
      expect(redactSensitiveText(unclosed)).toBe("ERROR failed: [redacted-unscanned]");
      const many = `${Array.from({ length: 17 }, (_, i) => `{"k${i}":"v${i}"}`).join(" ")} {"secret":"tail"}`;
      expect(redactEmbeddedJson(many)).toContain("[redacted-unscanned]");
      expect(redactEmbeddedJson(many)).not.toContain("tail");
      const kept = redactSensitiveText(many, { keepUnscanned: true });
      expect(kept).not.toContain("[redacted-unscanned]");
      expect(kept).not.toContain('"tail"');
      expect(redactSensitiveText(`${"[x] ".repeat(16)}{"headers":{"X-Custom-Auth":"leak-secret-123"}}`, { keepUnscanned: true }))
        .toContain('"X-Custom-Auth":"[redacted]"');
    });
  }, 60_000);

  it("matches current-user masking incl. unicode names, value recursion and truncate slicing", () => {
    dual(() => {
      const opts = {
        userNames: ["김철수", "alice", "paperclipuser"],
        homeDirs: ["/Users/김철수", "/Users/alice", "/home/paperclipuser", "C:\\Users\\paperclipuser"],
      };
      const masked = maskUserNameForLogs("alice");
      expect(masked).toBe("a****");
      const input = [
        "cwd=/Users/alice/app", "home=/home/paperclipuser/workspace",
        "win=C:\\Users\\paperclipuser\\paperclip", "home=/Users/김철수/프로젝트",
        "user alice said alice/p apaperclipuserz stays",
      ].join("\n");
      const out = redactCurrentUserText(input, opts);
      expect(out).toContain(`cwd=/Users/${masked}/app`);
      expect(out).toContain("home=/home/p************/workspace");
      expect(out).toContain("win=C:\\Users\\p************\\paperclip");
      expect(out).toContain(`user ${masked} said ${masked}/p apaperclipuserz stays`);
      expect(out).toContain("/Users/김**/프로젝트");
      expect(redactCurrentUserValue(
        { cwd: "/Users/alice/x", values: ["alice", "/home/paperclipuser/y"], n: 3, ok: null },
        opts,
      )).toEqual({
        cwd: "/Users/a****/x", values: ["a****", "/home/p************/y"], n: 3, ok: null,
      });
      expect(redactCurrentUserText("alice", { enabled: false })).toBe("alice");
      expect(redactBeforeTruncate("abc🚀def", 4)).toBe("abc…");
      const long = `${"a".repeat(40)} Authorization: Bearer verysecretvalue1234567890 ${"b".repeat(40)}`;
      const cut = redactBeforeTruncate(long, 68);
      expect(cut).not.toContain("verysecretvalue");
      expect(cut.endsWith("…")).toBe(true);
    });
  }, 60_000);

  it("falls back gracefully on missing or invalid PAPERCLIP_REDACTOR_LIB", () => {
    process.env.PAPERCLIP_REDACTOR_LIB = "/nonexistent/libpaperclip_log_redactor.dylib";
    expect(() => resetNativeRedactorForTests()).not.toThrow();
    expect(redactSensitiveText("api_key: abc")).toBe("api_key: [redacted]");
    process.env.PAPERCLIP_REDACTOR_LIB = "relative/not-absolute";
    expect(() => resetNativeRedactorForTests()).not.toThrow();
    expect(redactSensitiveText("api_key: abc")).toBe("api_key: [redacted]");
    useNative(); // re-attach to confirm recovery from a poisoned path
    expect(redactCurrentUserTextWithNative("probe", [], [], "*")).toBe("probe");
    expect(redactSensitiveText("api_key: abc")).toBe("api_key: [redacted]");
  }, 60_000);

  it("benchmarks ~2MB mixed NDJSON/JSON stream across both engines", () => {
    const line = `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", stream: "stdout", chunk: `agent log ${"x".repeat(200)} token_hint Authorization: Bearer abcdef1234567890` })}\n`;
    const jsonLine = `${JSON.stringify({ headers: { "X-Auth": "Bearer abc12345678", "X-Ok": "1" }, msg: "m" })}\n`;
    let blob = "";
    let i = 0;
    while (blob.length < 2 * 1024 * 1024) {
      blob += (i += 1) % 7 === 0 ? jsonLine : line;
    }
    useJs();
    const t0 = performance.now();
    const jsOut = redactSensitiveText(blob, { emails: true, keepUnscanned: true });
    const jsMs = performance.now() - t0;
    useNative();
    const t1 = performance.now();
    const rustOut = redactSensitiveText(blob, { emails: true, keepUnscanned: true });
    const rustMs = performance.now() - t1;
    expect(rustOut).toBe(jsOut);
    expect(jsOut).not.toContain("abcdef1234567890");
    console.info(
      `[benchmark] log-redactor 2MB: js_ms=${jsMs.toFixed(2)} rust_ms=${rustMs.toFixed(2)} speedup=${(jsMs / rustMs).toFixed(2)}x`,
    );
  }, 120_000);
});

describe("native driver hardening", () => {
  function makeDriver(overrides: Record<string, unknown> = {}): NativeSecretRedactorDriver {
    return {
      setRegisteredLiteralSecrets: () => {}, registerRuntimeSecrets: () => {}, clearRegisteredRuntimeSecrets: () => {},
      // Sentinels: if a rejected driver ever stays attached, JS output changes to these.
      redactSensitiveText: () => "NATIVE-LEAK", redactEmbeddedJson: () => "NATIVE-LEAK",
      ...overrides,
    } as NativeSecretRedactorDriver;
  }

  it("rejects incomplete or throwing drivers and keeps JS authoritative", () => {
    useJs();
    registerRuntimeSecrets(["hardening-secret-1234"]);
    const probe = "Authorization: hardening-secret-1234";
    expect(redactSensitiveText(probe)).toBe("Authorization: [redacted]");

    setNativeSecretRedactorDriver(makeDriver({ setRegisteredLiteralSecrets: undefined }) as unknown as NativeSecretRedactorDriver);
    expect(redactSensitiveText(probe)).toBe("Authorization: [redacted]");

    setNativeSecretRedactorDriver(makeDriver({ setRegisteredLiteralSecrets: () => { throw new Error("attach boom"); } }));
    expect(redactSensitiveText(probe)).toBe("Authorization: [redacted]");

    setNativeSecretRedactorDriver(makeDriver({ registerRuntimeSecrets: () => { throw new Error("register boom"); } }));
    registerRuntimeSecrets(["later-runtime-secret-5678"]);
    expect(redactSensitiveText("Authorization: later-runtime-secret-5678")).toBe("Authorization: [redacted]");

    const clears: number[] = [];
    setNativeSecretRedactorDriver(makeDriver({ clearRegisteredRuntimeSecrets: () => clears.push(1) }));
    setNativeSecretRedactorDriver(null);
    expect(clears).toHaveLength(1);
  }, 60_000);

  it("refuses a world-writable native library and falls back to JS", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "redactor-world-writable-"));
    try {
      const copy = path.join(tempDir, libName);
      copyFileSync(libPath, copy);
      chmodSync(copy, 0o666);
      process.env.PAPERCLIP_REDACTOR_LIB = copy;
      resetNativeRedactorForTests();
      expect(redactCurrentUserTextWithNative("probe", [], [], "*")).toBeNull(); // never installed
      registerRuntimeSecrets(["world-writable-secret-99"]);
      expect(redactSensitiveText("Authorization: world-writable-secret-99")).toBe("Authorization: [redacted]");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("never leaks secret-bearing driver error messages through console.warn", () => {
    useJs();
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    try {
      setNativeSecretRedactorDriver(makeDriver({ redactSensitiveText: () => { throw new Error("boom leak_payload_secret_1234"); }, redactEmbeddedJson: () => { throw new Error("boom leak_payload_secret_1234"); } }));
      registerRuntimeSecrets(["leak_payload_secret_1234"]);
      expect(redactSensitiveText("Authorization: leak_payload_secret_1234")).toBe("Authorization: [redacted]"); // fail-closed to JS
      expect(warnings.join("\n")).toContain("native driver failed (Error)");
      expect(warnings.join("\n")).not.toContain("leak_payload_secret_1234");
    } finally {
      warnSpy.mockRestore();
    }
  }, 60_000);
});
