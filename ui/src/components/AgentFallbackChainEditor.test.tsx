import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdapterFallbackChainEntry } from "@paperclipai/adapter-utils/types";
import type { UsageLimitGateSnapshot } from "../api/instanceSettings";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentFallbackChainEditor,
  MAX_FALLBACK_ENTRIES,
  addFallbackEntry,
  entryKey,
  findDuplicateIndex,
  moveFallbackEntry,
  normalizeFallbackOrder,
  removeFallbackEntry,
  resolveBackupEntryGateState,
} from "./AgentFallbackChainEditor";

const availableAdapters = [
  { type: "codex_local", label: "Codex (local)" },
  { type: "pi_local", label: "Pi (local)" },
  { type: "claude_local", label: "Claude (local)" },
];
const primaryModels = [{ id: "gpt-5.4", label: "GPT-5.4" }];

function renderEditor(overrides: Partial<Parameters<typeof AgentFallbackChainEditor>[0]> = {}) {
  const props = {
    primaryAdapterType: "codex_local",
    primaryModel: "gpt-5.4",
    automatic: true,
    order: [] as AdapterFallbackChainEntry[],
    legacyFallbackCommand: "",
    availableAdapters,
    primaryModels,
    getModelsForAdapter: (t: string) => (t === "codex_local" ? primaryModels : []),
    onChangeAutomatic: vi.fn(),
    onChangeOrder: vi.fn(),
    onChangeLegacyCommand: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(
    <TooltipProvider>
      <AgentFallbackChainEditor {...props} />
    </TooltipProvider>,
  );
}

describe("fallback entry helpers", () => {
  it("detects duplicates by trimmed adapter, provider and model regardless of thinking", () => {
    const order = [{ adapterType: "pi_local", provider: "zai", model: "glm-5.3" }];
    expect(
      findDuplicateIndex(order, { adapterType: " pi_local ", provider: " zai ", model: " glm-5.3 ", thinking: "high" }),
    ).toBe(0);
    expect(findDuplicateIndex(order, { adapterType: "pi_local", provider: "openai", model: "glm-5.3" })).toBe(-1);
    expect(entryKey({ adapterType: " codex_local ", model: " gpt-5.4 " })).toBe("codex_local||gpt-5.4");
  });

  it("adds a cross-adapter entry with provider and emits the updated order", () => {
    const result = addFallbackEntry([], { adapterType: "pi_local", provider: "zai", model: "glm-5.3" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toEqual([{ adapterType: "pi_local", provider: "zai", model: "glm-5.3" }]);
    }
  });

  it("rejects empty models, duplicates and entries beyond the cap", () => {
    expect(addFallbackEntry([], { adapterType: "codex_local", model: "  " })).toEqual({ ok: false, reason: "empty-model" });
    const order = [{ adapterType: "codex_local", model: "gpt-5.4" }];
    expect(addFallbackEntry(order, { adapterType: "codex_local", model: "gpt-5.4" })).toEqual({
      ok: false,
      reason: "duplicate",
    });
    const full = Array.from({ length: MAX_FALLBACK_ENTRIES }, (_, i) => ({ model: `m${i}` }));
    expect(addFallbackEntry(full, { adapterType: "codex_local", model: "new" })).toEqual({ ok: false, reason: "cap" });
    expect(MAX_FALLBACK_ENTRIES).toBe(8);
  });

  it("moves entries up and down and clamps at the bounds without mutating the input", () => {
    const order = [{ model: "a" }, { model: "b" }, { model: "c" }];
    expect(moveFallbackEntry(order, 1, -1).map((e) => e.model)).toEqual(["b", "a", "c"]);
    expect(moveFallbackEntry(order, 1, 1).map((e) => e.model)).toEqual(["a", "c", "b"]);
    expect(moveFallbackEntry(order, 0, -1).map((e) => e.model)).toEqual(["a", "b", "c"]);
    expect(moveFallbackEntry(order, 2, 5).map((e) => e.model)).toEqual(["a", "b", "c"]);
    expect(order.map((e) => e.model)).toEqual(["a", "b", "c"]);
  });

  it("removes an entry by index", () => {
    expect(removeFallbackEntry([{ model: "a" }, { model: "b" }], 0).map((e) => e.model)).toEqual(["b"]);
  });

  it("normalizes a stored fallback order from unknown shapes", () => {
    expect(
      normalizeFallbackOrder([
        { adapterType: "pi_local", model: "glm-5.3", thinking: "high" },
        null,
        { model: "ok" },
        { adapterType: "codex_local", command: "codex" },
        { model: 42 },
      ]),
    ).toEqual([{ adapterType: "pi_local", model: "glm-5.3", thinking: "high" }, { model: "ok" }]);
  });
});

describe("resolveBackupEntryGateState", () => {
  const snapshot: UsageLimitGateSnapshot = {
    limitedModels: [
      { adapterType: "pi_local", provider: null, model: "glm-5.3", kind: "limit", resetsAtMs: 1_000, reason: null },
    ],
    failedModels: [
      { adapterType: null, provider: null, model: "gpt-5.4", kind: "failed", resetsAtMs: 2_000, reason: "overload" },
    ],
  };

  it("matches limited entries case-insensitively and inherits the primary adapter type", () => {
    expect(resolveBackupEntryGateState({ adapterType: " PI_Local ", model: " GLM-5.3 " }, "codex_local", snapshot)).toBe("limit");
    expect(resolveBackupEntryGateState({ model: "glm-5.3" }, "pi_local", snapshot)).toBe("limit");
    expect(resolveBackupEntryGateState({ model: "glm-5.3" }, "codex_local", snapshot)).toBe("ready");
  });

  it("matches failed entries via wildcard snapshot parts and reports cooldown", () => {
    expect(resolveBackupEntryGateState({ adapterType: "claude_local", provider: "anthropic", model: "gpt-5.4" }, "codex_local", snapshot)).toBe("cooldown");
  });

  it("prefers limit over cooldown when both lists match and stays ready without a snapshot", () => {
    const both: UsageLimitGateSnapshot = {
      limitedModels: [{ adapterType: null, provider: null, model: "glm-5.3", kind: "limit", resetsAtMs: 1, reason: null }],
      failedModels: [{ adapterType: null, provider: null, model: "glm-5.3", kind: "failed", resetsAtMs: 1, reason: null }],
    };
    expect(resolveBackupEntryGateState({ model: "glm-5.3" }, "pi_local", both)).toBe("limit");
    expect(resolveBackupEntryGateState({ model: "glm-5.3" }, "pi_local", null)).toBe("ready");
    expect(resolveBackupEntryGateState({ model: "glm-5.3" }, "pi_local")).toBe("ready");
  });

  it("stays ready for models absent from the snapshot", () => {
    expect(resolveBackupEntryGateState({ model: "other-model" }, "pi_local", snapshot)).toBe("ready");
  });
});

describe("AgentFallbackChainEditor rendering", () => {
  it("renders the automatic failover toggle and an empty state", () => {
    const html = renderEditor({ order: [] });
    expect(html).toContain("자동 폴백 전환 (Automatic failover)");
    expect(html).toContain("쿼터 소진·과부하·오류 시");
    expect(html).toContain("No fallback entries yet");
    expect(html).not.toContain('aria-label="Remove fallback entry"');
  });

  it("renders ordered rows with adapter badge, provider, thinking tag and reorder controls", () => {
    const html = renderEditor({
      order: [
        { adapterType: "pi_local", provider: "zai", model: "glm-5.3", thinking: "high" },
        { adapterType: "codex_local", model: "gpt-5.4" },
      ],
    });
    expect(html).toContain("glm-5.3");
    expect(html).toContain("zai");
    expect(html).toContain("Pi (local)");
    expect(html).toContain("high");
    expect(html).toContain('aria-label="Move up"');
    expect(html).toContain('aria-label="Move down"');
    expect(html).toContain('aria-label="Remove fallback entry"');
  });

  it("offers the adapter registry, model selector and a disabled add button until a model is typed", () => {
    const html = renderEditor({});
    expect(html).toContain("Codex (local)");
    expect(html).toContain("Pi (local)");
    expect(html).toContain("GPT-5.4");
    expect(html).toContain("Add backup");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Add backup/);
  });

  it("keeps the legacy fallback command editable inside the advanced details section", () => {
    const html = renderEditor({ legacyFallbackCommand: "codex --model gpt-5.4" });
    expect(html).toContain("고급: 레거시 Fallback command");
    expect(html).toContain("<details");
    expect(html).toContain("codex --model gpt-5.4");
  });

  it("renders live gate badges (limit / cooldown / ready) per row when a snapshot is provided", () => {
    const html = renderEditor({
      order: [
        { adapterType: "pi_local", model: "glm-5.3" },
        { adapterType: "claude_local", model: "gpt-5.4" },
        { adapterType: "claude_local", model: "sonnet-9" },
      ],
      gateSnapshot: {
        limitedModels: [{ adapterType: "pi_local", provider: null, model: "glm-5.3", kind: "limit", resetsAtMs: 1_000, reason: null }],
        failedModels: [{ adapterType: null, provider: null, model: "gpt-5.4", kind: "failed", resetsAtMs: 2_000, reason: null }],
      },
    });
    expect(html).toContain('data-gate-state="limit"');
    expect(html).toContain("쿼터 제한");
    expect(html).toContain('data-gate-state="cooldown"');
    expect(html).toContain("쿨다운");
    expect(html).toContain('data-gate-state="ready"');
    expect(html).toContain("대기");
  });

  it("renders no gate badges when no snapshot is provided", () => {
    const html = renderEditor({ order: [{ adapterType: "pi_local", model: "glm-5.3" }] });
    expect(html).not.toContain("data-gate-state");
    expect(html).not.toContain("쿼터 제한");
    expect(html).not.toContain("쿨다운");
  });
});
