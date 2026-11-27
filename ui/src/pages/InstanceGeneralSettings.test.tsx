// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  InstanceGeneralSettings,
  createNewProviderRow,
  piCatalogModelName,
  piCliVersionLabel,
  resolveGeneralSettingsTab,
  toLlmStructuredProvidersDraft,
  toLlmStructuredProvidersPatch,
  toGeneralPatch,
  toJudgmentDraft,
  toLlmStructuredDraft,
  toLlmStructuredPatch,
} from "./InstanceGeneralSettings";

import type { InstanceGeneralSettings as GeneralSettings } from "@paperclipai/shared";
import type { PiCliStatusSnapshot } from "@paperclipai/shared/types/instance";

const { queryData, piStatusData } = vi.hoisted(() => ({
  queryData: vi.fn((): GeneralSettings => ({ censorUsernameInLogs: false, llmStructuredApiKeyConfigured: false })),
  piStatusData: vi.fn((): PiCliStatusSnapshot => ({
    installed: false,
    executablePath: null,
    version: null,
    agentDir: "~/.pi/agent",
    providers: [],
    catalogModels: [],
    runtimes: [],
  })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: (options?: { queryKey?: readonly unknown[] }) => ({
    data: Array.isArray(options?.queryKey) && options.queryKey[1] === "pi-cli-status" ? piStatusData() : queryData(),
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const renderPage = (tab?: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/instance/settings/general${tab ? `?tab=${tab}` : ""}`]}>
      <InstanceGeneralSettings />
    </MemoryRouter>,
  );

describe("toJudgmentDraft / toGeneralPatch (Judgment API key draft·patch)", () => {
  it("builds an empty draft (never copies a key) and carries saved overrides", () => {
    expect(toJudgmentDraft(undefined)).toEqual({
      judgmentBaseUrl: "", judgmentModelId: "", judgmentApiKey: "", clearJudgmentApiKey: false,
    });
    expect(toJudgmentDraft({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0" })).toEqual({
      judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0", judgmentApiKey: "", clearJudgmentApiKey: false,
    });
  });

  it("maps blank fields to null (clear) and values through trimmed", () => {
    expect(toGeneralPatch({ judgmentBaseUrl: "", judgmentModelId: "alt-model-1", judgmentApiKey: "", clearJudgmentApiKey: false }))
      .toEqual({ judgmentBaseUrl: null, judgmentModelId: "alt-model-1" });
    expect(toGeneralPatch({ judgmentBaseUrl: "  https://api.example.com  ", judgmentModelId: " ", judgmentApiKey: " sk-example ", clearJudgmentApiKey: false }))
      .toEqual({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: null, judgmentApiKey: "sk-example" });
  });

  it("sends null (clear) for the judgment key only when Clear key is checked", () => {
    expect(toGeneralPatch({ judgmentBaseUrl: "", judgmentModelId: "", judgmentApiKey: "", clearJudgmentApiKey: false }))
      .toEqual({ judgmentBaseUrl: null, judgmentModelId: null });
    expect(toGeneralPatch({ judgmentBaseUrl: "", judgmentModelId: "", judgmentApiKey: "sk-x", clearJudgmentApiKey: true }).judgmentApiKey)
      .toBeNull();
  });
});

describe("toLlmStructuredDraft / toLlmStructuredPatch", () => {
  it("defaults to empty fields and never copies a key", () => {
    expect(toLlmStructuredDraft(null)).toEqual({
      llmStructuredBaseUrl: "", llmStructuredModel: "", llmStructuredApiKey: "",
    });
    const settings = { llmStructuredBaseUrl: "https://api.deepseek.com/v1", llmStructuredModel: "deepseek-chat", llmStructuredApiKey: "do-not-copy" };
    expect(toLlmStructuredDraft(settings)).toEqual({ ...settings, llmStructuredApiKey: "" });
  });

  it("trims public fields, omits a blank key, and handles replacement/clear keys", () => {
    const draft = { llmStructuredBaseUrl: " https://api.deepseek.com/v1 ", llmStructuredModel: " deepseek-chat ", llmStructuredApiKey: " \t " };
    expect(toLlmStructuredPatch(draft)).toStrictEqual({
      llmStructuredBaseUrl: "https://api.deepseek.com/v1", llmStructuredModel: "deepseek-chat",
    });
    expect(toLlmStructuredPatch({ ...draft, llmStructuredApiKey: " sk-example " }).llmStructuredApiKey).toBe("sk-example");
    expect(toLlmStructuredPatch({ ...draft, llmStructuredApiKey: "sk-example" }, { clearApiKey: true }).llmStructuredApiKey).toBeNull();
    expect(toLlmStructuredPatch(toLlmStructuredDraft())).toStrictEqual({ llmStructuredBaseUrl: null, llmStructuredModel: null });
  });
});

describe("structured provider drafts", () => {
  it.each([
    ["deepseek", "DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
    ["zai", "Z.AI", "https://api.z.ai/api/paas/v4", "glm-4.7"],
    ["openai", "OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
    ["custom", "Custom", "", ""],
  ] as const)("creates a unique valid row for %s", (preset, name, baseUrl, model) => {
    const row = createNewProviderRow(preset, [preset, `${preset}-2`]);
    expect(row).toEqual({ id: `${preset}-3`, name, baseUrl, model, apiKey: "", apiKeyConfigured: false, clearApiKey: false });
    expect(row.id).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it("hydrates only public fields, preserves a blank key, and patches replacement and cleared keys", () => {
    const saved = { id: "saved", name: "Saved", baseUrl: "https://example.com/v1", apiKeyConfigured: true, apiKey: "not copied" };
    const [row] = toLlmStructuredProvidersDraft({ llmStructuredProviders: [saved] });
    expect(row).toEqual({ ...saved, apiKey: "", model: "", clearApiKey: false });
    const renamed = { ...row, name: " Renamed ", apiKey: "  " };
    expect(toLlmStructuredProvidersPatch([renamed], row.id)).toEqual({
      llmStructuredProviders: [{ id: row.id, name: "Renamed", baseUrl: row.baseUrl, model: null }],
      llmStructuredDefaultProviderId: row.id,
    });
    expect(toLlmStructuredProvidersPatch([{ ...renamed, apiKey: " replacement " }]).llmStructuredProviders)
      .toMatchObject([{ apiKey: "replacement" }]);
    expect(toLlmStructuredProvidersPatch([{ ...renamed, apiKey: "replacement", clearApiKey: true }]).llmStructuredProviders)
      .toMatchObject([{ apiKey: null }]);
    expect(toLlmStructuredProvidersPatch([createNewProviderRow()], row.id)).toMatchObject({
      llmStructuredProviders: [{ id: "custom" }], llmStructuredDefaultProviderId: null,
    });
  });
});

describe("pi cli helpers", () => {
  it("piCliVersionLabel strips pi/v prefixes for the badge", () => {
    expect(piCliVersionLabel("pi 9.9.9")).toBe("v9.9.9");
    expect(piCliVersionLabel("v1.2.3")).toBe("v1.2.3");
    expect(piCliVersionLabel("1.2.3")).toBe("v1.2.3");
    expect(piCliVersionLabel(null)).toBe("v?");
    expect(piCliVersionLabel("  ")).toBe("v?");
  });

  it("piCatalogModelName strips the provider prefix from catalog refs", () => {
    expect(piCatalogModelName("zai/glm-4.6")).toBe("glm-4.6");
    expect(piCatalogModelName("openrouter/anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet");
    expect(piCatalogModelName("solo-model")).toBe("solo-model");
  });
});

describe("InstanceGeneralSettings tabs", () => {
  it("defaults to the General tab with an accessible 4-tab tablist", () => {
    const html = renderPage();
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("General settings summary");
    expect(html).toContain("Censor username in logs");
    expect(html).not.toContain("Judgment connection");
    expect(html).not.toContain("Installed Coding Agent CLIs");
    expect(html).not.toContain("구독 인증");
  });

  it("resolves ?tab= to the requested panel (unknown → general)", () => {
    expect(resolveGeneralSettingsTab(null)).toBe("general");
    expect(resolveGeneralSettingsTab("bogus")).toBe("general");
    for (const tab of ["providers", "judgment", "runtimes"] as const) expect(resolveGeneralSettingsTab(tab)).toBe(tab);
    const providers = renderPage("providers");
    expect(providers).toContain("구독 인증 (Subscription / OAuth)");
    expect(providers).toContain("API 인증 (API Key)");
    expect(providers).not.toContain("Judgment connection");
    expect(providers).not.toContain("Censor username in logs");
    const runtimes = renderPage("runtimes");
    expect(runtimes).toContain("멀티 CLI · 모델 런타임 관리");
    expect(runtimes).toContain("Live Pi Model Catalog");
    expect(runtimes).not.toContain("구독 인증");
    expect(runtimes).not.toContain("Censor username in logs");
  });
});

describe("InstanceGeneralSettings structured LLM section (providers tab)", () => {
  it.each([false, true])("renders the correct controls when key configured is %s", (configured) => {
    queryData.mockReturnValueOnce({ censorUsernameInLogs: false, llmStructuredProviders: [
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyConfigured: configured },
    ], llmStructuredDefaultProviderId: "openai" });
    const html = renderPage("providers");
    expect(html).toContain("Structured LLM connection (1-shot API)");
    expect(html).toContain("Base URL");
    expect(html).toContain("Model");
    expect(html).toContain('aria-pressed="true"');
    const keyInput = html.match(/<input\b[^>]*\btype="password"[^>]*>/)?.[0];
    expect(keyInput).toContain('type="password"');
    expect(keyInput).toContain('autoComplete="new-password"');
    expect(html).toContain("Save structured LLM providers");
    expect(html.includes("Clear key")).toBe(configured);
    expect(html).toContain(configured ? "키 등록됨" : "키 미등록");
    expect(html).toContain("+ 공급자 추가");
    expect(html).toMatch(/<button\b[^>]*>연결 테스트 · 모델 조회<\/button>/);
    expect(html).toContain(configured ? "비워두면 기존 키 유지" : 'placeholder="sk-..."');
  });

  it("keeps legacy settings visible without pretending the legacy key belongs to a new provider", () => {
    queryData.mockReturnValueOnce({ censorUsernameInLogs: false, llmStructuredBaseUrl: "https://legacy.example/v1",
      llmStructuredApiKeyConfigured: true });
    const html = renderPage("providers");
    expect(html).toContain("https://legacy.example/v1");
    expect(html).toContain("키 등록됨");
    expect(html).not.toContain('type="password"');
  });

  it("renders pi auth.json providers with logout under 구독 인증", () => {
    piStatusData.mockReturnValueOnce({
      installed: true, executablePath: "/home/u/.bun/bin/pi", version: "9.9.9", agentDir: "/home/u/.pi/agent",
      providers: [
        { id: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", modelCount: 2, models: ["zai/glm-4.6"], authConfigured: true },
        { id: "solo", baseUrl: "https://solo.example/v1", modelCount: 1, models: ["solo/m1"], authConfigured: false },
      ],
      catalogModels: [], runtimes: [],
    });
    const html = renderPage("providers");
    expect(html).toContain("로그인됨 (auth.json)");
    expect(html).toContain("미인증");
    expect(html).toContain("로그아웃");
    expect(html).toContain("1 / 2 로그인됨");
    expect(html).toContain("openai-completions");
  });
});

describe("InstanceGeneralSettings judgment tab", () => {
  it.each([false, true])("renders labeled inputs, key pill, and clear control (configured=%s)", (configured) => {
    queryData.mockReturnValueOnce({ censorUsernameInLogs: false, judgmentApiKeyConfigured: configured } as GeneralSettings);
    const html = renderPage("judgment");
    expect(html).toContain("Judgment connection");
    expect(html).toContain('id="judgment-base-url"');
    expect(html).toContain("Base URL");
    expect(html).toContain('id="judgment-model-id"');
    expect(html).toContain("Model id");
    expect(html).toContain("TypeSafe 호환 판단 API 주소(비우면 기본값)");
    expect(html).toContain("모델 미설정 시 정의별 모델 사용");
    expect(html).toContain("서버 환경의 기존 판단 API 키가 이 주소로 전송됨");
    const keyInput = html.match(/<input\b[^>]*\bid="judgment-api-key"[^>]*>/)?.[0];
    expect(keyInput).toContain('type="password"');
    expect(keyInput).toContain(`placeholder="${configured ? "비워두면 기존 키 유지" : "서버 환경 키 사용"}"`);
    expect(html).toContain(configured ? "키 등록됨" : "서버 환경 키");
    expect(html.includes("Clear key")).toBe(configured);
    expect(html).toContain("Save judgment connection");
  });
});

describe("InstanceGeneralSettings Multi-CLI manager section (runtimes tab)", () => {
  const snapshot = {
    installed: true,
    executablePath: "/home/u/.bun/bin/pi",
    version: "pi 9.9.9",
    agentDir: "/home/u/.pi/agent",
    providers: [],
    catalogModels: ["solo/m1", "zai/glm-4.5", "zai/glm-4.6"],
    runtimes: [
      {
        id: "pi", name: "Pi CLI", adapterType: "pi_local", installed: true,
        executablePath: "/home/u/.bun/bin/pi", version: "9.9.9", authConfigured: true,
        authSource: "~/.pi/agent/auth.json", modelCount: 3, sampleModels: ["zai/glm-4.6"],
        supportsSelfUpdate: true, supportsModelUpdate: true, supportsProviderSync: true,
      },
      {
        id: "codex", name: "OpenAI Codex", adapterType: "codex_local", installed: false,
        executablePath: null, version: null, authConfigured: false, authSource: null,
        modelCount: 0, sampleModels: [], supportsSelfUpdate: true, supportsModelUpdate: false, supportsProviderSync: false,
      },
    ],
  } as PiCliStatusSnapshot;

  it("renders multi-CLI runtimes and the catalog when installed", () => {
    piStatusData.mockReturnValueOnce(snapshot);
    const html = renderPage("runtimes");
    expect(html).toContain("멀티 CLI · 모델 런타임 관리");
    expect(html).toContain("1 / 2 CLI 설치됨");
    expect(html).toContain("Installed Coding Agent CLIs");
    expect(html).toContain("OpenAI Codex");
    // updateAvailable 미지원(unknown) 상태 — 업데이트 버튼 대신 확인 버튼만 노출
    expect(html).toContain("업데이트 확인");
    expect(html).not.toContain("CLI 업데이트");
    expect(html).not.toContain("업데이트 가능");
    expect(html).not.toContain("최신 버전");
    expect(html).toContain("모델 새로고침");
    expect(html).toContain("Pi CLI v9.9.9");
    expect(html).toContain("총 3개 모델");
    expect(html).toContain("/home/u/.bun/bin/pi");
    expect(html).toContain("Pi CLI ↔ 웹 설정 동기화");
    expect(html).toContain("모델 카탈로그 새로고침 (pi update --models)");
    expect(html).toContain("CLI 버전 업데이트 (pi update --self)");
    expect(html).toContain("모델 검색");
    expect(html).toContain("zai/glm-4.6");
    expect(html).toContain("복사");
    expect(html).toContain("적용");
    expect(html).toContain("인증됨");
  });

  it("shows the CLI 업데이트 button + 업데이트 가능 badge only when updateAvailable is true", () => {
    piStatusData.mockReturnValueOnce({
      ...snapshot,
      catalogModels: [],
      runtimes: [
        {
          id: "codex", name: "OpenAI Codex", adapterType: "codex_local", installed: true,
          executablePath: "/usr/local/bin/codex", version: "1.0.0", authConfigured: false, authSource: null,
          modelCount: 0, sampleModels: [], supportsSelfUpdate: true, supportsModelUpdate: false, supportsProviderSync: false,
          latestVersion: "1.0.1", updateAvailable: true,
        },
        {
          id: "claude", name: "Claude Code", adapterType: "claude_local", installed: true,
          executablePath: "/usr/local/bin/claude", version: "2.0.0", authConfigured: false, authSource: null,
          modelCount: 0, sampleModels: [], supportsSelfUpdate: true, supportsModelUpdate: false, supportsProviderSync: false,
          latestVersion: "2.0.0", updateAvailable: false,
        },
      ],
    });
    const html = renderPage("runtimes");
    // updateAvailable: true → amber 배지 + 버전 전환 + CLI 업데이트 버튼
    expect(html).toContain("업데이트 가능");
    expect(html).toContain("v1.0.0 → v1.0.1");
    expect(html).toContain("CLI 업데이트");
    expect(html.match(/CLI 업데이트/g)).toHaveLength(1);
    // updateAvailable: false(최신 확인됨) → 확인 버튼 + 최신 버전 배지, 업데이트 버튼 없음
    expect(html).toContain("최신 버전");
    expect(html).toContain("업데이트 확인");
    expect(html).not.toContain("v2.0.0 →");
  });

  it("renders the not-detected badge and no logout when pi is absent", () => {
    piStatusData.mockReturnValueOnce({
      installed: false, executablePath: null, version: null, agentDir: "/x/.pi/agent",
      providers: [], catalogModels: [], runtimes: [], error: "spawn pi ENOENT",
    });
    const html = renderPage("runtimes");
    expect(html).toContain("Pi CLI not detected");
    expect(html).toContain("총 0개 모델");
    expect(html).toContain("spawn pi ENOENT");
    expect(html).not.toContain("로그아웃");
    expect(html).toContain("Pi CLI ↔ 웹 설정 동기화");
  });
});
