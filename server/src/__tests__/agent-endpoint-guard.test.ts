import { describe, expect, it } from "vitest";
import { evaluateAgentEndpointToolCall } from "../services/agent-endpoint-guard.js";
import type { AllowedFolderGrant, LocalToolCall } from "../services/endpoint-local-tool-bridge.js";

const agentRo = { accessLevel: "full", allowedFolders: [{ path: "/data", mode: "ro" }], allowLocalScripts: true };
const agentRw = { accessLevel: "full", allowedFolders: [{ path: "/data", mode: "rw" }], allowLocalScripts: true };
const endpointRw: AllowedFolderGrant[] = [{ path: "/data", mode: "rw" }];
const endpointRo: AllowedFolderGrant[] = [{ path: "/data", mode: "ro" }];

function evaluate(rawBotPolicy: unknown, endpointFolders: AllowedFolderGrant[], call: LocalToolCall) {
  return evaluateAgentEndpointToolCall({ rawBotPolicy, endpointFolders, call });
}

describe("evaluateAgentEndpointToolCall - allowed paths", () => {
  it("allows a read when both agent policy and endpoint rules permit", () => {
    const res = evaluate(agentRo, endpointRw, { kind: "local_read_file", path: "/data/a.txt" });
    expect(res.allowed).toBe(true);
    if (!res.allowed) return;
    expect(res.task.kind).toBe("local_read_file");
    expect(res.task.folderPath).toBe("/data");
    expect(res.task.relativePath).toBe("a.txt");
  });

  it("allows a directory listing in a ro endpoint folder when the agent grants ro", () => {
    const res = evaluate(agentRo, endpointRo, { kind: "local_list_dir", path: "/data" });
    expect(res.allowed).toBe(true);
    if (!res.allowed) return;
    expect(res.task.folderMode).toBe("ro");
  });

  it("allows a write when both layers grant rw", () => {
    const res = evaluate(agentRw, endpointRw, { kind: "local_write_file", path: "/data/b.txt", content: "hello" });
    expect(res.allowed).toBe(true);
    if (!res.allowed) return;
    expect(res.task.folderMode).toBe("rw");
    expect(res.task.contentBytes).toBe(5);
  });

  it("allows a shell exec anchored on the cwd when both layers grant rw", () => {
    const res = evaluate(agentRw, endpointRw, { kind: "local_shell_exec", command: "ls -la", cwd: "/data" });
    expect(res.allowed).toBe(true);
    if (!res.allowed) return;
    expect(res.task.cwd).toBe("/data");
    expect(res.task.folderMode).toBe("rw");
  });
});

describe("evaluateAgentEndpointToolCall - agent_policy layer", () => {
  it("blocks a write at agent_policy when the botPolicy is ro even if the endpoint is rw", () => {
    const res = evaluate(agentRo, endpointRw, { kind: "local_write_file", path: "/data/b.txt", content: "x" });
    expect(res.allowed).toBe(false);
    if (res.allowed) return;
    expect(res.layer).toBe("agent_policy");
    expect(res.reason).toContain("rw access");
  });

  it("blocks path traversal fail-closed at agent_policy", () => {
    const res = evaluate(agentRw, endpointRw, { kind: "local_read_file", path: "/data/../etc/passwd" });
    expect(res.allowed).toBe(false);
    if (res.allowed) return;
    expect(res.layer).toBe("agent_policy");
    expect(res.reason).toContain("/data/../etc/passwd");
  });

  it("denies explicitly when the raw botPolicy is structurally invalid", () => {
    const res = evaluate(42, endpointRw, { kind: "local_read_file", path: "/data/a.txt" });
    expect(res.allowed).toBe(false);
    if (res.allowed) return;
    expect(res.layer).toBe("agent_policy");
    expect(res.reason).toContain("invalid botPolicy");
  });

  it("denies when the botPolicy is missing (default policy grants no folders)", () => {
    const res = evaluate(null, endpointRw, { kind: "local_read_file", path: "/data/a.txt" });
    expect(res.allowed).toBe(false);
    if (res.allowed) return;
    expect(res.layer).toBe("agent_policy");
  });
});

describe("evaluateAgentEndpointToolCall - endpoint_bridge layer", () => {
  it("blocks a write at endpoint_bridge when the endpoint folder is ro even if the botPolicy is rw", () => {
    const res = evaluate(agentRw, endpointRo, { kind: "local_write_file", path: "/data/b.txt", content: "x" });
    expect(res.allowed).toBe(false);
    if (res.allowed) return;
    expect(res.layer).toBe("endpoint_bridge");
    expect(res.reason).toContain("WRITE_REQUIRES_RW");
  });

  it("blocks destructive shell commands at endpoint_bridge", () => {
    const res = evaluate(agentRw, endpointRw, { kind: "local_shell_exec", command: "rm -rf /", cwd: "/data" });
    expect(res.allowed).toBe(false);
    if (res.allowed) return;
    expect(res.layer).toBe("endpoint_bridge");
    expect(res.reason).toContain("DESTRUCTIVE_COMMAND");
  });

  it("blocks a target outside every endpoint folder even when the botPolicy allows it", () => {
    const widePolicy = {
      accessLevel: "full",
      allowedFolders: [{ path: "/data", mode: "rw" }, { path: "/etc", mode: "rw" }],
    };
    const res = evaluate(widePolicy, endpointRw, { kind: "local_read_file", path: "/etc/passwd" });
    expect(res.allowed).toBe(false);
    if (res.allowed) return;
    expect(res.layer).toBe("endpoint_bridge");
    expect(res.reason).toContain("NO_ALLOWED_FOLDER");
  });
});
