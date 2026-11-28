/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authApi } from "../../api/auth";
import { AuthPage } from "../Auth";

const router = vi.hoisted(() => ({ navigate: vi.fn(), searchParams: new URLSearchParams() }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => router.navigate,
  useSearchParams: () => [router.searchParams],
}));
vi.mock("../../api/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/auth")>(),
  authApi: {
    getSession: vi.fn(), getSocialProviders: vi.fn(), signInEmail: vi.fn(),
    signUpEmail: vi.fn(), requestPasswordReset: vi.fn(), resetPassword: vi.fn(),
    startSocialSignIn: vi.fn(),
  },
}));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function renderPage(reset = false) {
  if (reset) router.searchParams = new URLSearchParams("token=reset-token");
  await act(async () => {
    root.render(<QueryClientProvider client={client}><AuthPage /></QueryClientProvider>);
    await flush();
  });
  await act(async () => flush());
}

function input(id: string) {
  const node = host.querySelector<HTMLInputElement>(`#auth-${id}`);
  expect(node, `missing input: ${id}`).not.toBeNull();
  return node!;
}

async function fill(id: string, value: string) {
  await act(async () => {
    const node = input(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(text: string) {
  const node = [...host.querySelectorAll("button")].find((button) => button.textContent === text);
  expect(node, `missing button: ${text}`).not.toBeUndefined();
  await act(async () => { node!.click(); await flush(); });
}

// Dispatch submit directly so custom validation is tested even where native
// email/minLength validation would prevent the browser from submitting.
async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
}

function expectForm(fields: Record<string, string>, submitText: string) {
  const inputs = [...host.querySelectorAll("input")];
  expect(inputs).toHaveLength(Object.keys(fields).length);
  for (const [id, autocomplete] of Object.entries(fields)) {
    const node = input(id);
    expect(node.getAttribute("autocomplete")).toBe(autocomplete);
    expect(node.name).toBe(node.id);
    const labels = host.querySelectorAll<HTMLLabelElement>(`label[for="${node.id}"]`);
    expect(labels).toHaveLength(1);
    expect(labels[0].control).toBe(node);
    expect(labels[0].textContent?.trim()).toBeTruthy();
    expect(node.getAttribute("aria-invalid")).not.toBe("true");
    if (id === "email") {
      expect(node.type).toBe("email");
      expect(node.getAttribute("inputmode")).toBe("email");
      expect(node.getAttribute("spellcheck")).toBe("false");
    } else if (id.includes("password")) {
      expect(node.type).toBe("password");
    }
  }
  const submitButtons = host.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
  expect(submitButtons).toHaveLength(1);
  expect(submitButtons[0].textContent).toBe(submitText);
  for (const button of host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe(button === submitButtons[0] ? "submit" : "button");
  }
}

function expectInvalid(ids: string[], message: string) {
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe(message);
  expect(alert?.id).toBeTruthy();
  for (const node of host.querySelectorAll("input")) {
    const invalid = ids.includes(node.id.replace("auth-", ""));
    expect(node.getAttribute("aria-invalid") === "true").toBe(invalid);
    if (invalid) expect(node.getAttribute("aria-describedby")?.split(" ")).toContain(alert!.id);
    else expect(node.getAttribute("aria-describedby")?.split(" ") ?? []).not.toContain(alert!.id);
  }
}

describe("authentication forms checklist", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    router.searchParams = new URLSearchParams();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(authApi.getSession).mockResolvedValue(null);
    vi.mocked(authApi.getSocialProviders).mockResolvedValue([{ id: "google", label: "Google" }]);
    vi.mocked(authApi.requestPasswordReset).mockResolvedValue(undefined);
    vi.mocked(authApi.resetPassword).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  it("labels sign-in fields and identifies the email as the password-manager username", async () => {
    await renderPage();
    expectForm({ email: "username", password: "current-password" }, "Sign In");
    expect(host.querySelector('[data-auth-provider="google"]')?.getAttribute("type")).toBe("button");
  });

  it("labels sign-up fields and identifies the name, email and new password", async () => {
    await renderPage();
    await click("Create one");
    expectForm({ name: "name", email: "email", password: "new-password" }, "Create Account");
  });

  it("labels the forgot-password email and announces reset-link success politely", async () => {
    await renderPage();
    await click("Forgot password?");
    expectForm({ email: "email" }, "Send Reset Link");
    await fill("email", "user@example.com");
    await submit();
    const status = host.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("If an account exists");
    expect(authApi.requestPasswordReset).toHaveBeenCalledWith({ email: "user@example.com", redirectTo: "/auth" });
  });

  it("labels both reset passwords as new and announces successful reset", async () => {
    await renderPage(true);
    expectForm({ password: "new-password", "confirm-password": "new-password" }, "Reset Password");
    await fill("password", "new-secret-123");
    await fill("confirm-password", "new-secret-123");
    await submit();
    expect(authApi.resetPassword).toHaveBeenCalledWith({ token: "reset-token", newPassword: "new-secret-123" });
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Password updated");
    expectForm({ email: "username", password: "current-password" }, "Sign In");
  });

  it.each([
    ["sign-in", ["email", "password"]],
    ["sign-up", ["name", "email", "password"]],
    ["forgot", ["email"]],
    ["reset", ["password", "confirm-password"]],
  ] as const)("associates missing required %s fields with the validation alert", async (mode, fields) => {
    await renderPage(mode === "reset");
    if (mode === "sign-up") await click("Create one");
    if (mode === "forgot") await click("Forgot password?");
    await submit();
    expectInvalid([...fields], "Please fill in all required fields.");
    expect(authApi.signInEmail).not.toHaveBeenCalled();
    expect(authApi.signUpEmail).not.toHaveBeenCalled();
    expect(authApi.requestPasswordReset).not.toHaveBeenCalled();
    expect(authApi.resetPassword).not.toHaveBeenCalled();
  });

  it("marks only empty fields when required values are partially filled", async () => {
    await renderPage();
    await fill("email", "user@example.com");
    await submit();
    expectInvalid(["password"], "Please fill in all required fields.");
  });

  it("marks a short sign-up password and preserves its hint alongside the error", async () => {
    await renderPage();
    await click("Create one");
    await fill("name", "User");
    await fill("email", "user@example.com");
    await fill("password", "short");
    await submit();
    expectInvalid(["password"], "Password must be at least 10 characters.");
    expect(input("password").getAttribute("aria-describedby")?.split(" ")).toContain("auth-password-hint");
    expect(host.querySelector("#auth-password-hint")?.textContent).toContain("10 characters");
    expect(authApi.signUpEmail).not.toHaveBeenCalled();
  });

  it("marks reset length and confirmation errors without blaming unrelated fields", async () => {
    await renderPage(true);
    await fill("password", "short");
    await fill("confirm-password", "short");
    await submit();
    expectInvalid(["password"], "New password must be at least 10 characters.");
    await fill("password", "new-secret-123");
    await fill("confirm-password", "different-secret");
    await submit();
    expectInvalid(["confirm-password"], "Passwords do not match.");
    expect(authApi.resetPassword).not.toHaveBeenCalled();
    await fill("confirm-password", "new-secret-123");
    await submit();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(input("password").getAttribute("aria-invalid")).not.toBe("true");
  });

  it("clears field errors when switching form modes", async () => {
    await renderPage();
    await submit();
    expectInvalid(["email", "password"], "Please fill in all required fields.");
    await click("Forgot password?");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expectForm({ email: "email" }, "Send Reset Link");
  });

  it("announces API errors without treating them as known field validation failures", async () => {
    vi.mocked(authApi.signInEmail).mockRejectedValue(new Error("Sign-in unavailable"));
    await renderPage();
    await submit();
    expectInvalid(["email", "password"], "Please fill in all required fields.");
    await fill("email", "user@example.com");
    await fill("password", "current-secret");
    await submit();
    expectInvalid([], "Sign-in unavailable");
    expect(authApi.signInEmail).toHaveBeenCalledWith({ email: "user@example.com", password: "current-secret" });
  });

  it("clears local field errors when an OAuth failure replaces the alert", async () => {
    vi.mocked(authApi.startSocialSignIn).mockRejectedValue(new Error("Provider unavailable"));
    await renderPage();
    await submit();
    expectInvalid(["email", "password"], "Please fill in all required fields.");
    await click("Continue with Google");
    expectInvalid([], "Provider unavailable");
    expect(authApi.startSocialSignIn).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });
});
