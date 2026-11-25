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

function input(id: string): HTMLInputElement {
  const node = host.querySelector<HTMLInputElement>(`#${id}`);
  expect(node).toBeTruthy();
  return node!;
}

async function setInput(id: string, value: string) {
  await act(async () => {
    const node = input(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(text: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
  expect(button, `missing button: ${text}`).toBeTruthy();
  await act(async () => {
    button!.click();
    await flush();
  });
}

describe("AuthPage password reset flow", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    routerMock.searchParams = new URLSearchParams();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(authApi.getSession).mockResolvedValue(null);
    vi.mocked(authApi.getSocialProviders).mockResolvedValue([{ id: "google", label: "Google" }]);
    vi.mocked(authApi.signInEmail).mockResolvedValue(undefined);
    vi.mocked(authApi.signUpEmail).mockResolvedValue(undefined);
    vi.mocked(authApi.requestPasswordReset).mockResolvedValue(undefined);
    vi.mocked(authApi.resetPassword).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  it("switches to forgot password mode and submits the email without enumerating accounts", async () => {
    await renderPage();
    await clickButton("Forgot password?");
    expect(host.textContent).toContain("Reset your password");

    await setInput("auth-email", "user@example.com");
    await clickButton("Send Reset Link");

    expect(authApi.requestPasswordReset).toHaveBeenCalledWith({
      email: "user@example.com",
      redirectTo: "/auth",
    });
    expect(host.textContent).toContain("If an account exists for that email, a password reset link has been sent.");
    expect(host.textContent).not.toContain("No account exists");
  });

  it("opens token links in reset mode, validates input, resets the password, and returns to sign in", async () => {
    routerMock.searchParams = new URLSearchParams("token=abc");
    await renderPage();
    expect(host.textContent).toContain("Choose a new password");

    await setInput("auth-password", "long-enough-1");
    await setInput("auth-confirm-password", "different-password");
    await clickButton("Reset Password");
    expect(host.textContent).toContain("Passwords do not match.");
    expect(authApi.resetPassword).not.toHaveBeenCalled();

    await setInput("auth-password", "short");
    await setInput("auth-confirm-password", "short");
    await clickButton("Reset Password");
    expect(host.textContent).toContain("New password must be at least 8 characters.");
    expect(authApi.resetPassword).not.toHaveBeenCalled();

    await setInput("auth-password", "new-secret-1");
    await setInput("auth-confirm-password", "new-secret-1");
    await clickButton("Reset Password");

    expect(authApi.resetPassword).toHaveBeenCalledWith({ token: "abc", newPassword: "new-secret-1" });
    expect(host.textContent).toContain("Password updated. Sign in with your new password.");
    expect(host.textContent).toContain("Sign in to Paperwork");
  });

  it("keeps sign-in, sign-up, and OAuth provider controls intact", async () => {
    await renderPage();
    expect(host.textContent).toContain("Continue with Google");
    expect(host.textContent).toContain("Create one");

    await setInput("auth-email", "user@example.com");
    await setInput("auth-password", "current-secret");
    await clickButton("Sign In");
    expect(authApi.signInEmail).toHaveBeenCalledWith({ email: "user@example.com", password: "current-secret" });

    await clickButton("Create one");
    expect(host.textContent).toContain("Create your Paperwork account");
    await setInput("auth-name", "User");
    await setInput("auth-password", "new-secret-1");
    await clickButton("Create Account");
    expect(authApi.signUpEmail).toHaveBeenCalledWith({
      name: "User",
      email: "user@example.com",
      password: "new-secret-1",
    });
  });
});
