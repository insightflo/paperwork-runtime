import { describe, expect, it } from "vitest";
import { conflict } from "../errors.js";
import { ProducerRebindIssuanceFailed } from "../services/workflow/automatic-producer-rebind.js";
import { isAdoptProducerEditsEligible } from "../services/missions/mission-owner-adopt-producer-edits.js";

describe("stale producer rebind diagnostic P0", () => {
  const scope = {
    companyId: "comp-1",
    workflowRunId: "run-1",
    producerStepId: "build-service-report-content",
    productId: "prod-1",
    selector: { type: "document" as const, title: "content.json" },
  };

  it("constructs ProducerRebindIssuanceFailed with workproduct_selector_stale_producer and conflictReason", () => {
    const iterErr = new ProducerRebindIssuanceFailed(scope, conflict("producer_rebind_iteration_mismatch"));
    expect(iterErr.message).toBe("workproduct_selector_stale_producer");
    expect(iterErr.diagnostic).toEqual({
      schemaVersion: "workflow.producer-rebind-diagnostic.v1",
      outcome: "issuance-failed",
      conflictReason: "producer_rebind_iteration_mismatch",
      scope: {
        companyId: "comp-1",
        workflowRunId: "run-1",
        producerStepId: "build-service-report-content",
        productId: "prod-1",
      },
    });

    const bytesErr = new ProducerRebindIssuanceFailed(scope, conflict("producer_rebind_bytes_changed"));
    expect(bytesErr.message).toBe("workproduct_selector_stale_producer");
    expect(bytesErr.diagnostic.conflictReason).toBe("producer_rebind_bytes_changed");
  });

  it.each(["producer_rebind_bytes_changed", "producer_rebind_iteration_mismatch"])(
    "marks stale-producer diagnostic %s as adopt-producer-edits eligible",
    (conflictReason) => {
      expect(
        isAdoptProducerEditsEligible({
          dispatchError: "workproduct_selector_stale_producer",
          producerRebindDiagnostic: { conflictReason },
        }),
      ).toBe(true);
    },
  );

  it("keeps direct byte mismatch eligible and rejects unrelated or absent diagnostics", () => {
    expect(isAdoptProducerEditsEligible({ dispatchError: "workproduct_selector_rebind_bytes_mismatch" })).toBe(true);
    expect(
      isAdoptProducerEditsEligible({
        dispatchError: "workproduct_selector_stale_producer",
        producerRebindDiagnostic: { conflictReason: "producer_rebind_not_generation_only" },
      }),
    ).toBe(false);
    expect(
      isAdoptProducerEditsEligible({
        dispatchError: "workproduct_selector_stale_producer",
      }),
    ).toBe(false);
    expect(isAdoptProducerEditsEligible(null)).toBe(false);
  });
});
