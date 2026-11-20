// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  InstanceGeneralSettings,
  createNewProviderRow,
  piCatalogModelName,
  piCliVersionLabel,
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

describe("toJudgmentDraft", () => {
  it("builds an empty draft from empty settings", () => {
    expect(toJudgmentDraft(undefined)).toEqual({ judgmentBaseUrl: "", judgmentModelId: "" });
    expect(toJudgmentDraft({})).toEqual({ judgmentBaseUrl: "", judgmentModelId: "" });
  });

  it("carries saved overrides into the draft", () => {
    expect(
      toJudgmentDraft({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0" }),
    ).toEqual({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0" });
  });
});

describe("toGeneralPatch", () => {
  it("maps blank fields to null (clear) and values through trimmed", () => {
    expect(toGeneralPatch({ judgmentBaseUrl: "", judgmentModelId: "alt-model-1" })).toEqual({
      judgmentBaseUrl: null,
      judgmentModelId: "alt-model-1",
    });
    expect(toGeneralPatch({ judgmentBaseUrl: "  https://api.example.com  ", judgmentModelId: " " })).toEqual({
      judgmentBaseUrl: "https://api.example.com",
      judgmentModelId: null,
    });
  });
});

describe("toLlmStructuredDraft", () => {
  it("defaults to empty fields", () => {
    expect(toLlmStructuredDraft(null)).toEqual({
      llmStructuredBaseUrl: "", llmStructuredModel: "", llmStructuredApiKey: "",
    });
  });

  it("hydrates public fields but never copies a key", () => {
    const settings = {
      llmStructuredBaseUrl: "https://api.deepseek.com/v1",
      llmStructuredModel: "deepseek-chat",
      llmStructuredApiKey: "do-not-copy",
    };
    expect(toLlmStructuredDraft(settings)).toEqual({ ...settings, llmStructuredApiKey: "" });
  });
});

describe("toLlmStructuredPatch", () => {
  const draft = {
    llmStructuredBaseUrl: " https://api.deepseek.com/v1 ",
    llmStructuredModel: " deepseek-chat ",
    llmStructuredApiKey: " \t ",
  };

  it("trims public fields and omits a blank key to preserve the saved key", () => {
    expect(toLlmStructuredPatch(draft)).toStrictEqual({
      llmStructuredBaseUrl: "https://api.deepseek.com/v1", llmStructuredModel: "deepseek-chat",
    });
  });

  it("sends a trimmed replacement key", () => {
    expect(toLlmStructuredPatch({ ...draft, llmStructuredApiKey: " sk-example " }).llmStructuredApiKey)
      .toBe("sk-example");
  });

  it("clears the key explicitly even with a replacement typed in", () => {
    expect(toLlmStructuredPatch({ ...draft, llmStructuredApiKey: "sk-example" }, { clearApiKey: true })
      .llmStructuredApiKey).toBeNull();
  });

  it("sends null for blank URL and model", () => {
    expect(toLlmStructuredPatch(toLlmStructuredDraft())).toStrictEqual({
      llmStructuredBaseUrl: null, llmStructuredModel: null,
    });
  });
});

describe("InstanceGeneralSettings structured LLM section", () => {
  it.each([false, true])("renders the correct controls when key configured is %s", (configured) => {
    queryData.mockReturnValueOnce({ censorUsernameInLogs: false, llmStructuredProviders: [
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyConfigured: configured },
    ], llmStructuredDefaultProviderId: "openai" });
    const html = renderToStaticMarkup(<InstanceGeneralSettings />);
    const title = "Structured LLM connection (1-shot API)";
    expect(html).toContain(title);
    expect(html.indexOf(title)).toBeGreaterThan(html.indexOf("Judgment connection"));
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

  it("keeps legacy settings visible without pretending the legacy key belongs to a new provider", () => {
    queryData.mockReturnValueOnce({ censorUsernameInLogs: false, llmStructuredBaseUrl: "https://legacy.example/v1",
      llmStructuredApiKeyConfigured: true });
    const html = renderToStaticMarkup(<InstanceGeneralSettings />);
    expect(html).toContain("https://legacy.example/v1");
    expect(html).toContain("키 등록됨");
    expect(html).not.toContain('type="password"');
  });
});

describe("InstanceGeneralSettings judgment connection section", () => {
  it("renders the two labeled inputs and the key-forwarding warning", () => {
    const html = renderToStaticMarkup(<InstanceGeneralSettings />);

    expect(html).toContain("Judgment connection");
    expect(html).toContain('id="judgment-base-url"');
    expect(html).toContain("Base URL");
    expect(html).toContain('id="judgment-model-id"');
    expect(html).toContain("Model id");
    expect(html).toContain("TypeSafe 호환 판단 API 주소(비우면 기본값)");
    expect(html).toContain("모델 미설정 시 정의별 모델 사용");
    expect(html).toContain("서버 환경의 기존 판단 API 키가 이 주소로 전송됨");
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

describe("InstanceGeneralSettings Multi-CLI manager section", () => {
  it("renders multi-CLI runtimes, pi providers, and catalog state when installed", () => {
    piStatusData.mockReturnValueOnce({
      installed: true,
      executablePath: "/home/u/.bun/bin/pi",
      version: "pi 9.9.9",
      agentDir: "/home/u/.pi/agent",
      providers: [
        { id: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", modelCount: 2, models: ["zai/glm-4.6", "zai/glm-4.5"], authConfigured: true },
        { id: "solo", baseUrl: "https://solo.example/v1", modelCount: 1, models: ["solo/m1"], authConfigured: false },
      ],
      catalogModels: ["solo/m1", "zai/glm-4.5", "zai/glm-4.6"],
      runtimes: [
        {
          id: "pi",
          name: "Pi CLI",
          adapterType: "pi_local",
          installed: true,
          executablePath: "/home/u/.bun/bin/pi",
          version: "9.9.9",
          authConfigured: true,
          authSource: "~/.pi/agent/auth.json",
          modelCount: 3,
          sampleModels: ["zai/glm-4.6"],
          supportsSelfUpdate: true,
          supportsModelUpdate: true,
          supportsProviderSync: true,
        },
        {
          id: "codex",
          name: "OpenAI Codex",
          adapterType: "codex_local",
          installed: false,
          executablePath: null,
          version: null,
          authConfigured: false,
          authSource: null,
          modelCount: 0,
          sampleModels: [],
          supportsSelfUpdate: true,
          supportsModelUpdate: false,
          supportsProviderSync: false,
        },
      ],
    });
    const html = renderToStaticMarkup(<InstanceGeneralSettings />);

    expect(html).toContain("Multi-CLI &amp; Model Runtime (OpenBot Manager)");
    expect(html.indexOf("OpenBot Manager")).toBeGreaterThan(html.indexOf("Structured LLM connection"));
    expect(html).toContain("1 / 2 CLI 설치됨");
    expect(html).toContain("Installed Coding Agent CLIs");
    expect(html).toContain("OpenAI Codex");
    expect(html).toContain("CLI 업데이트");
    expect(html).toContain("모델 새로고침");
    expect(html).toContain("Pi CLI v9.9.9");
    expect(html).toContain("총 3개 모델");
    expect(html).toContain("/home/u/.bun/bin/pi");
    expect(html).toContain("/home/u/.pi/agent");
    expect(html).toContain("Pi CLI ↔ 웹 설정 동기화");
    expect(html).toContain("모델 카탈로그 새로고침 (pi update --models)");
    expect(html).toContain("CLI 버전 업데이트 (pi update --self)");
    expect(html).toContain("상태 새로고침");
    expect(html).toContain("로그인됨 (auth.json)");
    expect(html).toContain("미인증");
    expect(html).toContain("로그아웃");
    expect(html).toContain("모델 검색");
    expect(html).toContain("zai/glm-4.6");
    expect(html).toContain("복사");
    expect(html).toContain("적용");
    expect(html).toContain("openai-completions");
  });

  it("renders the not-detected badge and no logout when pi is absent", () => {
    piStatusData.mockReturnValueOnce({
      installed: false,
      executablePath: null,
      version: null,
      agentDir: "/x/.pi/agent",
      providers: [],
      catalogModels: [],
      runtimes: [],
      error: "spawn pi ENOENT",
    });
    const html = renderToStaticMarkup(<InstanceGeneralSettings />);

    expect(html).toContain("Pi CLI not detected");
    expect(html).toContain("총 0개 모델");
    expect(html).toContain("spawn pi ENOENT");
    expect(html).not.toContain("로그아웃");
    expect(html).toContain("Pi CLI ↔ 웹 설정 동기화");
  });
});
