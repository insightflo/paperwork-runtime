// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  InstanceGeneralSettings,
  createNewProviderRow,
  toLlmStructuredProvidersDraft,
  toLlmStructuredProvidersPatch,
  toGeneralPatch,
  toJudgmentDraft,
  toLlmStructuredDraft,
  toLlmStructuredPatch,
} from "./InstanceGeneralSettings";

import type { InstanceGeneralSettings as GeneralSettings } from "@paperclipai/shared";

const { queryData } = vi.hoisted(() => ({
  queryData: vi.fn((): GeneralSettings => ({ censorUsernameInLogs: false, llmStructuredApiKeyConfigured: false })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => ({
    data: queryData(),
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
