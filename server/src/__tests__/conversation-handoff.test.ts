import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeHandoffDelivered,
  excerptPreservingEnds,
  HANDOFF_BUDGET_CHARS,
  HANDOFF_END_MARKER,
  HANDOFF_START_MARKER,
  handoffFilePath,
  readAndVerifyHandoffPacket,
  renderConversationHandoff,
  ROUTINE_HANDOFF_BUDGET_CHARS,
  writeHandoffPacketBeforeBind,
} from "../services/conversation-handoff.js";
import { computeAgentToolFingerprint, hasToolSurfaceChanged } from "../services/tool-fingerprint.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-handoff-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("conversation-handoff & tool-fingerprint", () => {
  it("enforces 32KB budget, preserves routine 8KB budget, and keeps surrogate pairs intact", () => {
    const emojiText = "A".repeat(120) + "🚀".repeat(50) + "Z".repeat(120);
    const cut = excerptPreservingEnds(emojiText, 190);
    expect(cut.length).toBeLessThanOrEqual(190);
    expect(() => JSON.stringify(cut)).not.toThrow();
    for (let i = 0; i < cut.length; i += 1) {
      const code = cut.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = cut.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }

    const messages = Array.from({ length: 18 }, (_, idx) => ({
      id: `m-${idx}`,
      role: (idx % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn ${idx} payload ` + "x".repeat(3000) + " apiKey=secret_value_should_redact",
      capturedSteps: `tool step ${idx} ran ok`,
    }));

    const packet = renderConversationHandoff({
      agentName: "Research Director",
      fromAdapter: "pi_local",
      toAdapter: "antigravity_local",
      reason: "provider_fallback",
      messages,
    });
    expect(packet).not.toBeNull();
    expect(packet!.length).toBeLessThanOrEqual(HANDOFF_BUDGET_CHARS);
    expect(packet).toContain(HANDOFF_START_MARKER);
    expect(packet).toContain(HANDOFF_END_MARKER);
    expect(packet).not.toContain("secret_value_should_redact");

    const routinePacket = renderConversationHandoff({
      agentName: "Routine Monitor",
      routineMode: true,
      messages,
    });
    expect(routinePacket!.length).toBeLessThanOrEqual(ROUTINE_HANDOFF_BUDGET_CHARS);
  });

  it("writes and hashes handoff artifact BEFORE bindSession runs, and verifies/recovers corruption", async () => {
    const dir = makeTempDir();
    let seenOnDiskDuringBind = false;
    let boundSha = "";

    const out = await writeHandoffPacketBeforeBind({
      directory: dir,
      sessionKey: "agent-1:thread-abc",
      input: {
        agentName: "Synthesis Editor",
        fromAdapter: "antigravity_local",
        toAdapter: "codex_local",
        messages: [
          { id: "1", role: "user", text: "Synthesize Q3 report" },
          { id: "2", role: "assistant", text: "Drafted sections 1-3", capturedSteps: "read 4 files" },
        ],
      },
      bindSession: async (artifact) => {
        expect(artifact).not.toBeNull();
        seenOnDiskDuringBind = existsSync(artifact!.filePath);
        boundSha = artifact!.sha256;
        return "bound-ok";
      },
    });

    expect(out.result).toBe("bound-ok");
    expect(seenOnDiskDuringBind).toBe(true);
    const verified = await readAndVerifyHandoffPacket({ directory: dir, sessionKey: "agent-1:thread-abc" });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.sha256).toBe(boundSha);
      expect(verified.packet).toContain("Drafted sections 1-3");
    }

    const filePath = handoffFilePath(dir, "agent-1:thread-abc");
    writeFileSync(filePath, '{"version":1,"sessionKey":"agent-1:thread-abc","sha256":"deadbeef","packet":"tampered"}');
    const tampered = await readAndVerifyHandoffPacket({ directory: dir, sessionKey: "agent-1:thread-abc" });
    expect(tampered).toEqual({ ok: false, reason: "corrupt" });

    await acknowledgeHandoffDelivered({ directory: dir, sessionKey: "agent-1:thread-abc" });
    const afterAck = await readAndVerifyHandoffPacket({ directory: dir, sessionKey: "agent-1:thread-abc" });
    expect(afterAck).toEqual({ ok: false, reason: "missing" });
  });

  it("produces deterministic tool fingerprints and detects MCP/model/instructions drift", () => {
    const base = {
      adapterType: "antigravity_local",
      model: "gemini-3-pro",
      instructionsText: "Follow strict policy",
      mcpServers: [
        { name: "paperclip", url: "http://127.0.0.1:3100/mcp" },
        { name: "github", command: "gh-mcp", args: ["--read-only"] },
      ],
      allowedTools: ["read_file", "run_command"],
      envKeys: { Z_TOKEN: "val-z", A_KEY: "val-a" },
    };

    const reordered = {
      ...base,
      mcpServers: [...base.mcpServers].reverse(),
      allowedTools: ["run_command", "read_file"],
      envKeys: { A_KEY: "val-a", Z_TOKEN: "val-z" },
    };

    const fp1 = computeAgentToolFingerprint(base);
    expect(computeAgentToolFingerprint(reordered)).toBe(fp1);
    expect(hasToolSurfaceChanged(fp1, reordered).changed).toBe(false);
    expect(hasToolSurfaceChanged(fp1, { ...base, model: "gemini-2.5-pro" }).changed).toBe(true);
    expect(hasToolSurfaceChanged(fp1, { ...base, instructionsText: "Changed rules" }).changed).toBe(true);
  });
});
