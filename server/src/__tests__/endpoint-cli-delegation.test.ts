import { describe, expect, it } from "vitest";
import {
  buildLocalCliDelegationPlan as build,
  selectPreferredLocalCli as select,
  type CliDelegationRequest,
  type SupportedLocalCli,
} from "../services/endpoint-cli-delegation.js";

const request: CliDelegationRequest = {
  cli: "pi", prompt: "Analyze the code", cwd: "/proj/src",
  allowedFolders: [{ path: "/proj", mode: "rw" }],
};

describe("local CLI preference", () => {
  it("uses preference order rather than detection order", () => {
    expect(select(["claude", "codex", "pi"])).toBe("pi");
    expect(select(["gemini", "claude", "codex"])).toBe("codex");
  });
  it("uses the full default order", () => {
    const order = ["pi", "codex", "claude", "gemini", "opencode", "cursor", "agy"];
    order.forEach((cli, index) => expect(select(order.slice(index).reverse())).toBe(cli));
  });
  it("honors custom order and filters unknown names in both lists", () => {
    expect(select(["pi", "gemini"], ["gemini", "pi"])).toBe("gemini");
    expect(select(["sh", "PI", "constructor", "__proto__", "codex"])).toBe("codex");
    expect(select(["sh"], ["sh" as SupportedLocalCli])).toBeNull();
  });
  it("returns null when no preferred supported CLI is detected", () => {
    expect(select([])).toBeNull();
    expect(select(["sh", "bash"])).toBeNull();
    expect(select(["pi"], [])).toBeNull();
    expect(select(["pi"], ["claude"])).toBeNull();
  });
});

describe("local CLI delegation plans", () => {
  it("accepts the rw root and descendants, including trailing separators", () => {
    expect(build(request).cwd).toBe("/proj/src");
    expect(build({ ...request, cwd: "/proj" }).cwd).toBe("/proj");
    expect(build({ ...request, allowedFolders: [{ path: "/proj/", mode: "rw" }] }).cwd)
      .toBe("/proj/src");
  });
  it("rejects ro, absent grants, and read-only subfolders beneath rw grants", () => {
    expect(() => build({ ...request, allowedFolders: [] })).toThrow();
    expect(() => build({ ...request, allowedFolders: [{ path: "/proj", mode: "ro" }] })).toThrow();
    expect(() => build({ ...request, allowedFolders: [
      ...request.allowedFolders, { path: "/proj/src", mode: "ro" },
    ] })).toThrow();
  });
  it.each(["/proj-evil", "/project/src", "/elsewhere", "proj/src"])
  ("rejects prefix spoofs and paths without an absolute grant: %s", (cwd) => {
    expect(() => build({ ...request, cwd })).toThrow();
  });
  it.each(["/proj/../proj/src", "/proj/src/..", "/proj/./../src", "/proj/\0src"])
  ("rejects traversal and null bytes before normalization: %s", (cwd) => {
    expect(() => build({ ...request, cwd })).toThrow();
  });
  it.each(["/proj/..", "/proj/\0", "proj"])("rejects unsafe grant roots: %s", (path) => {
    expect(() => build({ ...request, allowedFolders: [{ path, mode: "rw" }] })).toThrow();
  });
  it("handles absolute Windows paths without depending on the server OS", () => {
    const windows = { ...request, cwd: "C:\\proj\\src",
      allowedFolders: [{ path: "C:\\proj", mode: "rw" as const }] };
    expect(build(windows).cwd).toBe(windows.cwd);
    for (const cwd of ["C:\\proj-evil", "C:\\proj\\..\\proj", "C:proj", "D:\\proj"]) {
      expect(() => build({ ...windows, cwd })).toThrow();
    }
  });
  it.each(["", " \n\t", "x".repeat(32_001), "hello\0world"])("rejects invalid prompts", (prompt) => {
    expect(() => build({ ...request, prompt })).toThrow();
  });
  it("accepts the maximum prompt length without trimming content", () => {
    const prompt = "x".repeat(32_000);
    expect(build({ ...request, prompt }).argv.at(-1)).toBe(prompt);
  });
  it("defaults timeout and output bounds", () => {
    expect(build(request)).toMatchObject({ cli: "pi", timeoutMs: 120_000, maxOutputBytes: 131_072 });
  });
  it.each([
    [-1, -1, 5_000, 4_096], [900_000, 2_000_000, 600_000, 1_048_576],
    [30_000, 8_192, 30_000, 8_192], [Infinity, -Infinity, 600_000, 4_096],
  ])("clamps timeout %s and output %s", (timeoutMs, maxOutputBytes, timeout, output) => {
    expect(build({ ...request, timeoutMs, maxOutputBytes }))
      .toMatchObject({ timeoutMs: timeout, maxOutputBytes: output });
  });
  it("rejects NaN and invalid runtime CLI names", () => {
    expect(() => build({ ...request, timeoutMs: NaN })).toThrow();
    expect(() => build({ ...request, maxOutputBytes: NaN })).toThrow();
    for (const cli of ["sh", "constructor", "__proto__"]) {
      expect(() => build({ ...request, cli: cli as SupportedLocalCli })).toThrow();
    }
  });
  it.each([
    ["pi", ["--no-session", "-p"]], ["codex", ["exec", "--"]],
    ["claude", ["-p"]], ["gemini", ["-p"]], ["agy", ["-p"]],
    ["opencode", ["run", "--"]], ["cursor", ["agent", "-p"]],
  ] as [SupportedLocalCli, string[]][])("keeps hostile text as one literal argument for %s", (cli, prefix) => {
    const prompt = "Analyze $(rm -rf /); `whoami` && echo '$HOME'\n\"quoted\" | cat > /tmp/x";
    expect(build({ ...request, cli, prompt }).argv).toEqual([...prefix, prompt]);
  });
  it.each(["--dangerously-skip-permissions", "-", "@/etc/passwd"])
  ("rejects prompt syntax interpreted as CLI options or file input: %s", (prompt) => {
    expect(() => build({ ...request, prompt })).toThrow();
  });
});
