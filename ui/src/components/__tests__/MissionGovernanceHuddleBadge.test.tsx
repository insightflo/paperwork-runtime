// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionGovernanceThreadPanel } from "../MissionGovernanceThreadPanel";
import { missionsApi } from "../../api/missions";
import type { ExceptionHuddleBadgeProps } from "../ExceptionHuddleBadge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../../api/missions", () => ({
  missionsApi: { getGovernanceThread: vi.fn() },
}));

type ActiveHuddle = Omit<ExceptionHuddleBadgeProps, "className">;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel(activeHuddle?: ActiveHuddle | null) {
  await render(<MissionGovernanceThreadPanel missionId="mission-1" activeHuddle={activeHuddle} />);
  await settle();
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

describe("MissionGovernanceThreadPanel active huddle badge", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(missionsApi.getGovernanceThread).mockResolvedValue({
      missionId: "mission-1",
      companyId: "company-1",
      events: [],
      summary: { totalEventCount: 0, latestEvents: [], openDecisions: [] },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    client.clear();
    host.remove();
    document.body.innerHTML = "";
  });

  it("renders identically when activeHuddle is omitted or null", async () => {
    await render(<MissionGovernanceThreadPanel missionId="mission-1" />);
    await settle();
    const omittedHtml = host.innerHTML;

    expect(omittedHtml).not.toContain("Huddle");

    await render(<MissionGovernanceThreadPanel missionId="mission-1" activeHuddle={null} />);
    await settle();

    expect(host.innerHTML).toBe(omittedHtml);
  });

  it.each([
    {
      label: "open round 1/2",
      huddle: { status: "open", currentRound: 1, maxRounds: 2 },
      text: "Huddle R1/2",
      ariaLabel: "Open exception huddle: round 1 of 2 in progress",
    },
    {
      label: "timed_out",
      huddle: { status: "timed_out", currentRound: 2, maxRounds: 2 },
      text: "Huddle Timeout · Chair Decision",
      ariaLabel: "Open exception huddle: timed out, chair decision",
    },
    {
      label: "decided",
      huddle: { status: "decided", currentRound: 2, maxRounds: 2, decisionKind: "escalate" },
      text: "Huddle: Escalate",
      ariaLabel: "Open exception huddle: decided, Escalate",
    },
  ] as const)("renders the $label badge in the panel header and invokes onOpen", async ({ huddle, text, ariaLabel }) => {
    const onOpen = vi.fn();
    await renderPanel({ ...huddle, onOpen });

    const section = host.querySelector('section[aria-label="Governance Thread"]');
    const header = section?.firstElementChild;
    const button = host.querySelector(`button[aria-label="${ariaLabel}"]`);

    expect(section, "governance panel").toBeTruthy();
    expect(button, `${text} button`).toBeTruthy();
    expect(header?.contains(button!)).toBe(true);
    expect(button!.textContent).toContain(text);
    expect(header?.textContent).toContain("read-only");

    click(button!);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
