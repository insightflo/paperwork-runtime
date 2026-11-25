/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { AuthPage } from "./Auth";

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
  searchParams: new URLSearchParams(),
}));
const apiMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSocialProviders: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  signInSocial: vi.fn(),
  startSocialSignIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => routerMock.navigate,
  useSearchParams: () => [routerMock.searchParams],
}));
vi.mock("../api/auth", () => ({ authApi: apiMock }));

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function renderPage() {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><AuthPage /></QueryClientProvider>);
    await flush();
  });
  await act(async () => flush());
}

function providerButton(id: string): HTMLButtonElement {
  const node = host.querySelector<HTMLButtonElement>(`[data-auth-provider="${id}"]`);
  expect(node, `missing provider button: ${id}`).toBeTruthy();
  return node!;
}

async function click(node: HTMLButtonElement) {
  await act(async () => {
    node.click();
    await flush();
  });
}

describe("AuthPage OAuth provider buttons", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    routerMock.searchParams = new URLSearchParams("next=/missions");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(authApi.getSession).mockResolvedValue(null);
    vi.mocked(authApi.getSocialProviders).mockResolvedValue([
      { id: "google", label: "Google" },
      { id: "github", label: "GitHub" },
      { id: "microsoft", label: "Microsoft" },
      { id: "oidc", label: "SSO (OIDC)" },
    ]);
    apiMock.signInSocial.mockReturnValue(new Promise<{ url: string }>(() => {}));
    vi.mocked(authApi.startSocialSignIn).mockReturnValue(new Promise<{ url: string }>(() => {}));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  it("renders Google, GitHub, Microsoft, and OIDC as telemetry-ready cockpit buttons", async () => {
    await renderPage();
    const badgeMarkup = new Set<string>();

    for (const [id, label] of [
      ["google", "Google"],
      ["github", "GitHub"],
      ["microsoft", "Microsoft"],
      ["oidc", "SSO (OIDC)"],
    ] as const) {
      const button = providerButton(id);
      expect(button.textContent).toContain(`Continue with ${label}`);
      expect(button.querySelector("svg")).toBeTruthy();
      badgeMarkup.add(button.querySelector("svg")?.innerHTML ?? "");
      expect(button.className).toContain("border-border/80");
      expect(button.className).toContain("bg-card/70");
      expect(button.className).toContain("hover:border-primary/50");
      expect(button.className).toContain("hover:bg-accent/60");
    }
    expect(badgeMarkup.size).toBe(4);
  });

  it("triggers authApi.signInSocial with the clicked provider ID and next redirect path", async () => {
    await renderPage();

    await click(providerButton("github"));

    expect(apiMock.signInSocial).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/missions",
    });
  });

  it("keeps custom OAuth and OIDC provider IDs renderable", async () => {
    vi.mocked(authApi.getSocialProviders).mockResolvedValue([
      { id: "kakao", label: "Kakao" },
      { id: "naver", label: "Naver" },
      { id: "acme-oidc", label: "Acme SSO" },
    ]);

    await renderPage();

    const kakaoIcon = providerButton("kakao").querySelector("svg")?.innerHTML ?? "";
    expect(kakaoIcon).toContain("M15 12H3");
    expect(providerButton("naver").querySelector("svg")?.innerHTML).toBe(kakaoIcon);
    expect(providerButton("acme-oidc").querySelector("svg")?.innerHTML).toBe(kakaoIcon);
  });
});
