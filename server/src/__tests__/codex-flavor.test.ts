import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripReservedDriverArgs, type AcpFlavorBuildArgsInput } from "@paperclipai/adapter-utils";
import { sessionCodec } from "@paperclipai/adapter-codex-local/server";
import { codexFlavor } from "../../../packages/adapters/codex-local/src/server/codex-flavor.js";

const baseInput: AcpFlavorBuildArgsInput = {
  command: "codex",
  prompt: "prompt",
  resumeSessionId: null,
  model: "",
  effort: "",
  maxTurns: 0,
  extraArgs: [],
  config: {},
};

const argv = (over: Partial<AcpFlavorBuildArgsInput> = {}) =>
  codexFlavor.buildArgs({ ...baseInput, ...over });

describe("codexFlavor argv parity", () => {
  it("builds the default exec argv", () => {
    expect(argv()).toEqual(["exec", "--json", "--skip-git-repo-check", "-"]);
  });

  it("unshifts --search ahead of exec when config.search is set", () => {
    expect(argv({ config: { search: true } })).toEqual([
      "--search", "exec", "--json", "--skip-git-repo-check", "-",
    ]);
  });

  it("adds the bypass flag for either bypass config key", () => {
    for (const config of [
      { dangerouslyBypassApprovalsAndSandbox: true },
      { dangerouslyBypassSandbox: true },
    ]) {
      expect(argv({ config })).toContain("--dangerously-bypass-approvals-and-sandbox");
    }
    expect(argv({ config: { dangerouslyBypassApprovalsAndSandbox: false } })).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("emits --model and -c model_reasoning_effort after the fixed flags", () => {
    expect(argv({ model: "gpt-5", effort: "high" })).toEqual([
      "exec", "--json", "--skip-git-repo-check",
      "--model", "gpt-5", "-c", 'model_reasoning_effort="high"', "-",
    ]);
  });

  it("dedupes a user-supplied --skip-git-repo-check", () => {
    const args = argv({ extraArgs: ["--skip-git-repo-check", "--verbose"] });
    expect(args).toEqual(["exec", "--json", "--skip-git-repo-check", "--verbose", "-"]);
    expect(args.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
  });

  it("tails with resume <id> - on resume and a bare - on fresh runs", () => {
    expect(argv({ resumeSessionId: "sess-1" }).slice(-3)).toEqual(["resume", "sess-1", "-"]);
    expect(argv().at(-1)).toBe("-");
  });

  it("strips driver-reserved flags and their values from user args", () => {
    const stripped = stripReservedDriverArgs(
      ["--model", "injected", "--search", "--json", "--profile", "team"],
      codexFlavor.reservedArgs ?? [],
    );
    expect(stripped).toEqual(["--profile", "team"]);
  });
});

describe("codexFlavor.sessionCodec.deserialize", () => {
  it("returns null for missing params", () => {
    for (const raw of [null, undefined, {}]) {
      expect(codexFlavor.sessionCodec.deserialize(raw)).toBeNull();
    }
  });

  it("returns null for malformed params", () => {
    for (const raw of ["sess", 7, true, [], { sessionId: "   " }, { sessionId: 42 }]) {
      expect(codexFlavor.sessionCodec.deserialize(raw)).toBeNull();
    }
  });

  it("normalizes legacy snake_case params", () => {
    expect(
      codexFlavor.sessionCodec.deserialize({
        session_id: "sess-legacy",
        workdir: "/repo",
        workspace_id: "ws-1",
        repo_url: "https://example.com/repo",
        repo_ref: "main",
      }),
    ).toEqual({
      sessionId: "sess-legacy",
      cwd: "/repo",
      workspaceId: "ws-1",
      repoUrl: "https://example.com/repo",
      repoRef: "main",
    });
  });
});

describe("resume-vs-fresh decision parity", () => {
  const resumeIdFor = (raw: unknown, cwd: string): string | null => {
    const params = codexFlavor.sessionCodec.deserialize(raw) ?? {};
    const id = typeof params.sessionId === "string" ? params.sessionId : "";
    const savedCwd = typeof params.cwd === "string" ? params.cwd : "";
    const canResume = id.length > 0 &&
      (savedCwd.length === 0 || path.resolve(savedCwd) === path.resolve(cwd));
    return canResume ? id : null;
  };

  it("resumes when stored cwd matches the run cwd", () => {
    const id = resumeIdFor({ sessionId: "sess-1", cwd: "/repo" }, "/repo");
    expect(argv({ resumeSessionId: id }).slice(-3)).toEqual(["resume", "sess-1", "-"]);
    expect(argv({ resumeSessionId: resumeIdFor({ sessionId: "s" }, "/repo") }).slice(-3)).toEqual(
      ["resume", "s", "-"],
    );
  });

  it("falls back to a fresh run on cwd mismatch or unusable params", () => {
    expect(
      argv({ resumeSessionId: resumeIdFor({ sessionId: "s", cwd: "/repo" }, "/other") }).at(-1),
    ).toBe("-");
    for (const raw of [null, {}, { sessionId: "  " }, "garbage"]) {
      expect(argv({ resumeSessionId: resumeIdFor(raw, "/repo") }).at(-1)).toBe("-");
    }
  });
});

describe("public ./server codec export", () => {
  it("is the same object as codexFlavor.sessionCodec", () => {
    expect(sessionCodec).toBe(codexFlavor.sessionCodec);
  });
});
