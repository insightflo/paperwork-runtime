import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type WorkflowHarnessFleetSummary as Fleet,
  type useCompanyWorkflowHarnessFleet as UseFleet,
} from "@/hooks/useCompanyWorkflowHarnessFleet";
import { FLEET_EMPTY_COPY, FLEET_ERROR_LABEL } from "./WorkflowHarnessFleetBanner";
import { HARNESS_FLEET_MALFORMED_COPY, WorkflowsHarnessHeaderStrip } from "./WorkflowsHarnessHeaderStrip";

type CompanyId = string | null | undefined;
type FleetResult = ReturnType<typeof UseFleet>;

const hook = vi.hoisted(() => ({ result: {} as FleetResult, companyIds: [] as CompanyId[] }));

vi.mock("@/hooks/useCompanyWorkflowHarnessFleet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useCompanyWorkflowHarnessFleet")>();
  return {
    ...actual,
    useCompanyWorkflowHarnessFleet: (companyId: CompanyId): FleetResult => {
      hook.companyIds.push(companyId);
      return hook.result;
    },
  };
});

const FLEET: Fleet = {
  totalRuns: 9, healthyRuns: 6, stalledRuns: 2, timedOutRuns: 1,
  sharpRuns: 4, splitRuns: 3, escalatedRuns: 1,
  pendingAdvisorGates: 1, challengedAdvisorGates: 0,
  avgSuccessRatePct: 77.5, worstStallRunId: "run_1", maxIdleMs: 125_000,
};

const CARD_MARK = 'aria-label="Workflow harness fleet summary"';

function stub(result: FleetResult) {
  hook.result = result;
}
function render(companyId?: CompanyId, className?: string): string {
  return renderToStaticMarkup(<WorkflowsHarnessHeaderStrip companyId={companyId} className={className} />);
}

beforeEach(() => {
  hook.result = { data: undefined, error: null, isLoading: false };
  hook.companyIds.length = 0;
});

describe("WorkflowsHarnessHeaderStrip", () => {
  it.each([undefined, null, "", "   "])("renders empty markup for blank companyId %p", (companyId) => {
    expect(render(companyId)).toBe("");
  });

  it("maps loading to the banner loading skeleton and delegates nothing", () => {
    stub({ data: undefined, error: null, isLoading: true });
    const html = render("co_1");

    expect(html).toContain('data-fleet-state="loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(CARD_MARK);
    expect(html).not.toContain(FLEET_EMPTY_COPY);
  });

  it("maps error to the banner alert with the error message", () => {
    stub({ data: undefined, error: new Error("500 <upstream down>"), isLoading: false });
    const html = render("co_1");

    expect(html).toContain('data-fleet-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(FLEET_ERROR_LABEL);
    expect(html).toContain("500 &lt;upstream down&gt;");
    expect(html).not.toContain(FLEET_EMPTY_COPY);
    expect(html).not.toContain(CARD_MARK);
  });

  it("keeps surfacing the error when a stale fleet is present", () => {
    stub({ data: FLEET, error: new Error("timeout"), isLoading: false });
    const html = render("co_1");

    expect(html).toContain('role="alert"');
    expect(html).toContain("timeout");
    expect(html).toContain(CARD_MARK);
  });

  it("maps ready data to the populated banner with fleet counts", () => {
    stub({ data: FLEET, error: null, isLoading: false });
    const html = render("co_1", "strip-class");

    expect(html).toContain('data-fleet-state="populated"');
    expect(html).toContain("strip-class");
    expect(html).toContain(CARD_MARK);
    expect(html).toMatch(/data-metric="total"[^>]*>.*?<span class="font-semibold">9<\/span>/);
    expect(html).toMatch(/data-metric="healthy"[^>]*>.*?<span class="font-semibold">6<\/span>/);
    expect(html).toMatch(/data-metric="stalled"[^>]*>.*?<span class="font-semibold">2<\/span>/);
    expect(html).toContain("77.5%");
    expect(html).toContain("2m 5s");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(FLEET_EMPTY_COPY);
  });

  it("maps a malformed (null) payload to an error instead of an empty fleet", () => {
    stub({ data: null, error: null, isLoading: false });
    const html = render("co_1");

    expect(html).toContain('data-fleet-state="error"');
    expect(html).toContain(HARNESS_FLEET_MALFORMED_COPY);
    expect(html).not.toContain(FLEET_EMPTY_COPY);
  });
});
