/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatShellCommand,
  ProviderAuthPanel,
  type LoginActionPlan,
  type ProviderAuthStatus,
} from "../components/ProviderAuthPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const status = (over: Partial<ProviderAuthStatus>): ProviderAuthStatus => ({
  provider: "claude",
  evidence: "missing",
  ...over,
});

const plan = (over: Partial<LoginActionPlan>): LoginActionPlan => ({
  provider: "claude",
  command: "claude",
  args: ["login"],
  interactive: true,
  notes: ["browser sign-in"],
  ...over,
});

async function mount(props: Parameters<typeof ProviderAuthPanel>[0]) {
  host = document.createElement("div");
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  await act(async () => {
    r.render(<ProviderAuthPanel {...props} />);
  });
  return host;
}

const button = (text: string) =>
  [...(host?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes(text));

describe("ProviderAuthPanel", () => {
  it("labels all five local evidence states with metadata", async () => {
    await mount({
      providers: [
        status({ provider: "claude", evidence: "api_key_env_present", envVar: "ANTHROPIC_API_KEY" }),
        status({
          provider: "codex",
          evidence: "credential_file_present",
          credentialPath: "/home/u/.codex/auth.json",
          credentialMeta: { exists: true, isSymlink: true, sizeBytes: 42, mtimeEpochMs: 0, inode: 7 },
        }),
        status({ provider: "pi", evidence: "managed_env_present", envVar: "PAPERCLIP_API_KEY" }),
        status({ provider: "commandcode", evidence: "missing" }),
        status({ provider: "devin", evidence: "probe_error", errorPath: "/home/u/.devin/auth.json" }),
      ],
    });
    const text = host!.textContent!;
    expect(text).toContain("API key env detected");
    expect(text).toContain("Credential file detected");
    expect(text).toContain("Managed env detected");
    expect(text).toContain("No local credentials");
    expect(text).toContain("Local probe error");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("/home/u/.codex/auth.json");
    expect(text).toContain("symlink");
    expect(text).toContain("42 B");
    expect(text).toContain("/home/u/.devin/auth.json");
    expect(text).toContain("Local evidence only");
  });

  it("shows a loading indicator", async () => {
    await mount({ providers: [], loading: true });
    expect(host!.querySelector('[role="status"]')).toBeTruthy();
  });

  it("renders a sanitized error banner without echoing the raw error", async () => {
    await mount({ providers: [], error: "upstream token=sekrit-xyz <b>x</b>" });
    expect(host!.textContent).toContain("Provider auth status is currently unavailable.");
    expect(host!.innerHTML).not.toContain("sekrit-xyz");
  });

  it("invokes onRefresh from the refresh button", async () => {
    const onRefresh = vi.fn();
    await mount({ providers: [], onRefresh });
    await act(async () => {
      button("Refresh")!.click();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("requests a login plan for the clicked provider", async () => {
    const onRequestLoginPlan = vi.fn();
    await mount({ providers: [status({})], onRequestLoginPlan });
    await act(async () => {
      button("Login Command")!.click();
    });
    expect(onRequestLoginPlan).toHaveBeenCalledWith("claude");
  });

  it("shows the login plan only when plan.provider matches the selection", async () => {
    await mount({
      providers: [status({})],
      loginPlans: { claude: plan({}) },
      selectedLoginProvider: "claude",
      onRequestLoginPlan: vi.fn(),
    });
    expect(host!.textContent).toContain("claude login");
    expect(host!.textContent).toContain("browser sign-in");
  });

  it("hides the plan box when plan.provider mismatches the selection", async () => {
    await mount({
      providers: [status({})],
      loginPlans: { claude: plan({ provider: "codex", command: "codex", args: ["auth", "login"] }) },
      selectedLoginProvider: "claude",
    });
    expect(host!.textContent).not.toContain("codex auth login");
    expect(host!.textContent).not.toContain("browser sign-in");
  });
});

describe("formatShellCommand", () => {
  it("keeps safe tokens unquoted", () => {
    expect(formatShellCommand("claude", ["login"])).toBe("claude login");
    expect(formatShellCommand("codex", ["auth", "login"])).toBe("codex auth login");
  });

  it("quotes empty, assignment-form, spaced, and quoted tokens", () => {
    expect(formatShellCommand("cmd", [""])).toBe("cmd ''");
    expect(formatShellCommand("env", ["FOO=bar"])).toBe("env 'FOO=bar'");
    expect(formatShellCommand("cmd", ["a b"])).toBe("cmd 'a b'");
    expect(formatShellCommand("cmd", ["it's"])).toBe("cmd 'it'\\''s'");
    expect(formatShellCommand("cmd", ['say "hi"'])).toBe(`cmd 'say "hi"'`);
  });

  it("quotes POSIX reserved words only in command position", () => {
    expect(formatShellCommand("elif", [])).toBe("'elif'");
    expect(formatShellCommand("if", ["x"])).toBe("'if' x");
    expect(formatShellCommand("echo", ["if"])).toBe("echo if");
  });
});
