// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  InstanceGeneralSettings,
  toGeneralPatch,
  toJudgmentDraft,
  toLlmStructuredDraft,
  toLlmStructuredPatch,
} from "./InstanceGeneralSettings";

const { queryData } = vi.hoisted(() => ({
  queryData: vi.fn(() => ({ censorUsernameInLogs: false, llmStructuredApiKeyConfigured: false })),
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
    queryData.mockReturnValueOnce({ censorUsernameInLogs: false, llmStructuredApiKeyConfigured: configured });
    const html = renderToStaticMarkup(<InstanceGeneralSettings />);
    const title = "Structured LLM connection (1-shot API)";
    expect(html).toContain(title);
    expect(html.indexOf(title)).toBeGreaterThan(html.indexOf("Judgment connection"));
    expect(html).toContain('id="llm-structured-base-url"');
    expect(html).toContain('id="llm-structured-model"');
    const keyInput = html.match(/<input\b[^>]*\bid="llm-structured-api-key"[^>]*>/)?.[0];
    expect(keyInput).toContain('type="password"');
    expect(keyInput).toContain('autoComplete="new-password"');
    expect(html).toContain("Save structured LLM connection");
    expect(html.includes("Clear saved key")).toBe(configured);
    expect(html).toContain(configured ? "API Key 등록됨" : "API Key 미등록");
    expect(html).toContain(configured ? "비워두면 기존 키 유지" : 'placeholder="sk-..."');
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
