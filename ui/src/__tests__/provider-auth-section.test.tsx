/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { api } from "../api/client";
import { costsApi } from "../api/costs";
import { instanceSettingsApi } from "../api/instanceSettings";
import { CompanyContext } from "../context/CompanyContext";
import { ProviderAuthSection } from "../components/ProviderAuthSection";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LoginActionPlan, ProviderAuthStatus } from "../components/ProviderAuthPanel";

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getProviderAuth: vi.fn(), getProviderLoginPlan: vi.fn() },
}));
vi.mock("../api/client", () => ({ api: { get: vi.fn() } }));
vi.mock("../api/costs", () => ({ costsApi: { quotaWindows: vi.fn() } }));
vi.mock("../hooks/useAfterInitialPaint", () => ({ useAfterInitialPaint: () => true }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const getAuth = vi.mocked(instanceSettingsApi.getProviderAuth);
const getPlan = vi.mocked(instanceSettingsApi.getProviderLoginPlan);
const quotaWindows = vi.mocked(costsApi.quotaWindows);

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.resetAllMocks();
});

beforeEach(() => {
  quotaWindows.mockResolvedValue([]);
});

const status = (over: Partial<ProviderAuthStatus>): ProviderAuthStatus => ({
  provider: "claude",
  evidence: "missing",
  ...over,
});
const plan = (over: Partial<LoginActionPlan>): LoginActionPlan => ({
  provider: "claude", command: "claude", args: ["login"], interactive: true, notes: [], ...over,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const qw = (label: string, usedPercent: number): QuotaWindow => ({
  label, usedPercent, resetsAt: null, valueLabel: null,
});

async function mount(options: { withCompanyProvider?: boolean; companyId?: string | null } = {}) {
  const { withCompanyProvider = true, companyId = "company-1" } = options;
  host = document.createElement("div");
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  const client = new QueryClient();
  const tree = (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ProviderAuthSection />
      </TooltipProvider>
    </QueryClientProvider>
  );
  await act(async () => {
    r.render(
      withCompanyProvider ? (
        <CompanyContext.Provider value={{ selectedCompanyId: companyId } as never}>
          {tree}
        </CompanyContext.Provider>
      ) : (
        tree
      ),
    );
  });
}

const loginButton = (provider: string) =>
  [...(host?.querySelectorAll("li") ?? [])]
    .find((li) => li.querySelector("span")?.textContent === provider)
    ?.querySelector("button")!;

const click = async (el: HTMLElement) => act(async () => { el.click(); });

describe("ProviderAuthSection", () => {
  it("renders providers fetched from the provider-auth endpoint", async () => {
    getAuth.mockResolvedValue({ providers: [
      status({ envVar: "ANTHROPIC_API_KEY", evidence: "api_key_env_present" }),
      status({ provider: "codex" }),
    ] });
    await mount();
    await flush();
    expect(host!.textContent).toContain("claude");
    expect(host!.textContent).toContain("codex");
    expect(host!.textContent).toContain("ANTHROPIC_API_KEY");
  });

  it("shows a sanitized error banner when the fetch rejects", async () => {
    getAuth.mockRejectedValue(new Error("503 token=sekrit-xyz"));
    await mount();
    await flush();
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain("currently unavailable");
    expect(host!.innerHTML).not.toContain("sekrit-xyz");
  });

  it("fetches and renders the login command for the clicked provider", async () => {
    getAuth.mockResolvedValue({ providers: [status({}), status({ provider: "codex" })] });
    getPlan.mockResolvedValue(plan({ provider: "codex", command: "codex", args: ["auth", "login"] }));
    await mount();
    await flush();
    await click(loginButton("codex"));
    await flush();
    expect(getPlan).toHaveBeenCalledWith("codex");
    expect(host!.textContent).toContain("codex auth login");
  });

  it("keeps the newer request loading when an earlier request resolves late (A-then-B, A resolves first)", async () => {
    const a = deferred<LoginActionPlan>();
    const b = deferred<LoginActionPlan>();
    getAuth.mockResolvedValue({ providers: [status({}), status({ provider: "codex" })] });
    getPlan.mockImplementation((p) => (p === "claude" ? a.promise : b.promise));
    await mount();
    await flush();
    await click(loginButton("claude"));
    await click(loginButton("codex"));
    a.resolve(plan({}));
    await flush();
    expect(loginButton("codex").textContent).toContain("Preparing");
    expect(host!.textContent).not.toContain("claude login");
    b.resolve(plan({ provider: "codex", command: "codex", args: ["auth", "login"] }));
    await flush();
    expect(host!.textContent).toContain("codex auth login");
  });

  it("keeps the newer selection when an earlier request resolves after the newer one", async () => {
    const a = deferred<LoginActionPlan>();
    const b = deferred<LoginActionPlan>();
    getAuth.mockResolvedValue({ providers: [status({}), status({ provider: "codex" })] });
    getPlan.mockImplementation((p) => (p === "claude" ? a.promise : b.promise));
    await mount();
    await flush();
    await click(loginButton("claude"));
    await click(loginButton("codex"));
    b.resolve(plan({ provider: "codex", command: "codex", args: ["auth", "login"] }));
    await flush();
    expect(host!.textContent).toContain("codex auth login");
    a.resolve(plan({}));
    await flush();
    expect(host!.textContent).toContain("codex auth login");
    expect(host!.textContent).not.toContain("claude login");
    expect(loginButton("codex").textContent).toContain("Login Command");
  });

  it("renders provider usage rings when quota windows are available", async () => {
    getAuth.mockResolvedValue({ providers: [status({})] });
    const quotas: ProviderQuotaResult[] = [
      { provider: "claude", source: "oauth", ok: true, windows: [qw("5h", 42)] },
    ];
    quotaWindows.mockResolvedValue(quotas);
    await mount();
    await flush();
    expect(quotaWindows).toHaveBeenCalledWith("company-1");
    const ring = host!.querySelector('[data-provider="claude"]');
    expect(ring?.getAttribute("aria-label")).toContain("42% used");
    expect(host!.textContent).toContain("claude");
  });

  it("renders providers without rings while quota windows are still loading", async () => {
    getAuth.mockResolvedValue({ providers: [status({})] });
    quotaWindows.mockReturnValue(deferred<ProviderQuotaResult[]>().promise);
    await mount();
    await flush();
    expect(host!.textContent).toContain("claude");
    expect(host!.querySelector("[data-provider]")).toBeNull();
  });

  it("renders providers cleanly with no rings when quota windows are empty", async () => {
    getAuth.mockResolvedValue({ providers: [status({})] });
    quotaWindows.mockResolvedValue([]);
    await mount();
    await flush();
    expect(host!.textContent).toContain("claude");
    expect(host!.querySelector("[data-provider]")).toBeNull();
  });

  it("renders providers cleanly and skips the quota fetch when no company is selected", async () => {
    getAuth.mockResolvedValue({ providers: [status({})] });
    await mount({ companyId: null });
    await flush();
    expect(host!.textContent).toContain("claude");
    expect(host!.querySelector("[data-provider]")).toBeNull();
    expect(quotaWindows).not.toHaveBeenCalled();
  });

  it("renders cleanly with no CompanyProvider (regression: optional context read)", async () => {
    getAuth.mockResolvedValue({ providers: [status({})] });
    await mount({ withCompanyProvider: false });
    await flush();
    expect(host!.textContent).toContain("claude");
    expect(host!.querySelector("[data-provider]")).toBeNull();
    expect(quotaWindows).not.toHaveBeenCalled();
  });

  it("unwraps the { plan } envelope returned by the login-plan endpoint", async () => {
    const mod = await vi.importActual<typeof import("../api/instanceSettings")>("../api/instanceSettings");
    vi.mocked(api.get).mockResolvedValue({ plan: plan({}) });
    await expect(mod.instanceSettingsApi.getProviderLoginPlan("claude")).resolves.toEqual(plan({}));
    expect(api.get).toHaveBeenCalledWith("/instance/settings/general/provider-auth/claude/login-plan");
  });
});
