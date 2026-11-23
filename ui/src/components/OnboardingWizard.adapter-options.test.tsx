// @vitest-environment node
//
// Regression test for the pruned-adapter UI cleanup (cursor, gemini_local,
// opencode_local, openclaw_gateway, antigravity_local). Adapter option lists in
// OnboardingWizard and AgentConfigForm render inside closed popovers, so the
// selector contract is asserted on the component sources: no quoted literal of
// a deleted adapter type may reappear, and every retained adapter must stay
// wired as a selectable option and a valid NewAgent submission target.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const onboardingSource = readFileSync(
  new URL("./OnboardingWizard.tsx", import.meta.url),
  "utf8",
);
const agentConfigFormSource = readFileSync(
  new URL("./AgentConfigForm.tsx", import.meta.url),
  "utf8",
);
const newAgentSource = readFileSync(
  new URL("../pages/NewAgent.tsx", import.meta.url),
  "utf8",
);

const DELETED_ADAPTERS = [
  "cursor",
  "gemini_local",
  "opencode_local",
  "openclaw_gateway",
  "antigravity_local",
] as const;

const RETAINED_ADAPTERS = [
  "claude_local",
  "codex_local",
  "pi_local",
  "commandcode_local",
] as const;

const quoted = (adapter: string) => `"${adapter}"`;

/** Every `value: "x" as const` entry — the wizard's selectable option lists. */
function onboardingOptionValues(): string[] {
  return [...onboardingSource.matchAll(/value: "([a-z_]+)" as const/g)].map(
    (m) => m[1]!,
  );
}

describe("OnboardingWizard adapter options", () => {
  it("offers exactly the retained local adapters and no pruned ones", () => {
    expect(new Set(onboardingOptionValues())).toEqual(
      new Set(RETAINED_ADAPTERS),
    );
  });

  it.each(DELETED_ADAPTERS)(
    "contains no %s reference anywhere in the component",
    (adapter) => {
      expect(onboardingSource).not.toContain(quoted(adapter));
    },
  );
});

describe("AgentConfigForm adapter options", () => {
  it.each(DELETED_ADAPTERS)(
    "contains no %s branch, option, or placeholder",
    (adapter) => {
      expect(agentConfigFormSource).not.toContain(quoted(adapter));
    },
  );

  it.each(RETAINED_ADAPTERS)(
    "keeps %s wired into the form's adapter handling",
    (adapter) => {
      expect(agentConfigFormSource).toContain(
        `adapterType === ${quoted(adapter)}`,
      );
    },
  );
});

describe("NewAgent submission", () => {
  it.each(DELETED_ADAPTERS)(
    "has no %s validation gate blocking submission",
    (adapter) => {
      expect(newAgentSource).not.toContain(quoted(adapter));
    },
  );

  it("supports every retained adapter as a preset adapter type", () => {
    const supported = newAgentSource.match(
      /SUPPORTED_ADVANCED_ADAPTER_TYPES[\s\S]*?\(\[([\s\S]*?)\]\)/,
    )?.[1];
    expect(supported).toBeDefined();
    for (const adapter of RETAINED_ADAPTERS) {
      expect(supported).toContain(quoted(adapter));
    }
  });

  it("submits the configured adapter type for retained adapters", () => {
    expect(newAgentSource).toContain("createAgent.mutate({");
    expect(newAgentSource).toContain(
      "adapterType: configValues.adapterType",
    );
  });
});
