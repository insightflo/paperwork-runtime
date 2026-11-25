/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginsApi } from "@/api/plugins";
import {
  PluginLauncherOutlet,
  PluginLauncherProvider,
  usePluginLaunchers,
} from "../plugins/launchers";
import { PluginSlotOutlet, usePluginSlots } from "../plugins/slots";

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listUiContributions: vi.fn(),
    bridgePerformAction: vi.fn(),
  },
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ key: "plugin-retired-test", pathname: "/" }),
  useNavigate: () => vi.fn(),
}));

const listUiContributions = vi.mocked(pluginsApi.listUiContributions);

describe("retired plugin UI contribution discovery", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    listUiContributions.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("returns empty slot and launcher results without fetching or rendering error banners", async () => {
    let slotsResult: ReturnType<typeof usePluginSlots> | undefined;
    let launchersResult: ReturnType<typeof usePluginLaunchers> | undefined;

    function Probe() {
      slotsResult = usePluginSlots({
        slotTypes: ["globalToolbarButton", "sidebar"],
        companyId: "company-1",
      });
      launchersResult = usePluginLaunchers({
        placementZones: ["globalToolbarButton", "sidebar"],
        companyId: "company-1",
      });
      return null;
    }

    await act(async () => {
      root.render(
        <PluginLauncherProvider>
          <Probe />
          <PluginSlotOutlet
            slotTypes={["globalToolbarButton", "sidebar"]}
            context={{ companyId: "company-1" }}
          />
          <PluginLauncherOutlet
            placementZones={["globalToolbarButton", "sidebar"]}
            context={{ companyId: "company-1" }}
          />
        </PluginLauncherProvider>,
      );
    });

    expect(slotsResult).toMatchObject({
      slots: [],
      isLoading: false,
      errorMessage: null,
    });
    expect(launchersResult?.launchers).toEqual([]);
    expect(launchersResult?.contributionsByPluginId.size).toBe(0);
    expect(launchersResult).toMatchObject({
      isLoading: false,
      errorMessage: null,
    });
    expect(listUiContributions).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Plugin extensions unavailable");
    expect(host.textContent).not.toContain("Plugin launchers unavailable");
  });
});
