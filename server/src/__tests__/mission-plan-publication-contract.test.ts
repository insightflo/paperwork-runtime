import { describe, expect, it } from "vitest";
import { reviewPublicationVerificationTopology as review, reviewPublicationQaReceiptTopology as reviewQa } from "../services/missions/mission-plan-publication-contract.js";
import { publicationContract, publicationTools, publicationUnits } from "./helpers/mission-publication-fixture.js";
import { reviewPlanAgainstIntent } from "../services/missions/mission-plan-qa.js";

describe("publication topology", () => {
  it("accepts downstream declared receipt binding", () => {
    const units = publicationUnits();
    units[1]!.toolArgs = { receiptInput: "{$steps.p.workProductPath}" };
    expect(review(units, publicationTools)).toEqual([]);
  });
  it.each([{}, { receiptInput: "https://example.test/guessed" }, { receiptInput: "{$steps.other.workProductPath}" },
    { publishResultPath: "{$steps.p.workProductPath}" }])("rejects missing, guessed, foreign, or undeclared binding %j", toolArgs => {
    const units = publicationUnits();
    units[1]!.toolArgs = toolArgs;
    expect(review(units, publicationTools)).toMatchObject([{ code: "missing_publication_verify_tool" }]);
  });
  it("requires dependency as well as the binding", () => {
    const units = publicationUnits();
    units[1]!.toolArgs = { receiptInput: "{$steps.p.workProductPath}" };
    units[1]!.dependsOn = [];
    expect(review(units, publicationTools)).toHaveLength(1);
  });
  it("does not derive contracts from suggestive tool names", () => {
    expect(review([{ id: "p", toolName: "publish" }, { id: "v", toolName: "verify" }])).toEqual([]);
  });
});

describe("publication mechanical QA receipt topology", () => {
  const qaTool = { name: "mechanical", adapterConfig: { artifactContract: publicationContract("qa") } };
  const publisher = { name: "publisher", adapterConfig: { artifactContract: {
    ...publicationContract("publication"), consumerParams: { receipt: "qaReceipt" },
  } } };
  const tools = [publisher, qaTool];
  const qa = { id: "q", toolName: qaTool.name };
  const publish = { id: "p", toolName: publisher.name, dependsOn: ["q"] };
  const diagnostic = { code: "missing_publication_qa_receipt_tool", severity: "invalid" };

  it("rejects LLM-only QA even when its prose claims a receipt", () => {
    const units = [{ id: "q", type: "qa", description: "mechanical QA produced toolArtifactReceipt" }, publish];
    expect(reviewQa(units, tools)).toMatchObject([diagnostic]);
    expect(reviewQa(units, tools)[0]?.message).toContain("toolArtifactReceipt");
  });
  it("accepts a declared upstream mechanical QA tool", () => {
    expect(reviewQa([qa, publish], tools)).toEqual([]);
  });
  it("accepts transitive dependencies regardless of array order", () => {
    expect(reviewQa([{ ...publish, dependsOn: ["bridge"] }, qa,
      { id: "bridge", dependsOn: ["q"] }], tools)).toEqual([]);
  });
  it.each([{ dependsOn: [] }, { dependsOn: ["p"] }])("rejects disconnected or downstream mechanical QA ($dependsOn)", ({ dependsOn }) => {
    expect(reviewQa([{ ...qa, dependsOn }, { ...publish, dependsOn: [] }], tools)).toMatchObject([diagnostic]);
  });
  it("accepts publication without a declared receipt requirement", () => {
    expect(reviewQa([{ ...publish, dependsOn: [] }], [qaTool,
      { ...publisher, adapterConfig: { artifactContract: publicationContract("publication") } }])).toEqual([]);
  });
  it("preserves synthetic catalogs without enabled valid mechanical QA tools", () => {
    const units = [{ ...publish, dependsOn: [] }];
    expect(reviewQa(units, [publisher])).toEqual([]);
    expect(reviewQa(units, [publisher, { ...qaTool, enabled: false }])).toEqual([]);
    expect(reviewQa(units, [publisher, { ...qaTool, adapterConfig: { artifactContract: { role: "qa" } } }])).toEqual([]);
  });
  it("does not count a disabled QA selection when another enabled QA tool exists", () => {
    expect(reviewQa([qa, publish], [publisher, { ...qaTool, enabled: false },
      { ...qaTool, name: "available-qa" }])).toMatchObject([diagnostic]);
  });
  it.each(["toolName", "toolNames", "tools"])("accepts the %s selection field", field => {
    expect(reviewQa([{ id: "q", [field]: field === "toolName" ? "mechanical" : ["mechanical"] }, publish], tools)).toEqual([]);
  });
  it("requires QA ancestry for every receipt-requiring publisher", () => {
    expect(reviewQa([qa, publish, { ...publish, id: "p2", dependsOn: [] }], tools)).toMatchObject([diagnostic]);
  });
  it("wires the diagnostic into PLAN-QA independently of prose intent", () => {
    const selectedExecutionUnits = [{ id: "q", type: "qa" }, publish,
      { id: "v", toolName: "beta", dependsOn: ["p"], toolArgs: { receiptInput: "{$steps.p.workProductPath}" } }];
    expect(reviewPlanAgainstIntent({ selectedExecutionUnits, tools: [...tools, publicationTools[1]!],
      intent: { publish: false, audienceSplit: false, scenario: false, audiences: [], beneficiary: [], matchedSignals: [] },
    })).toMatchObject([diagnostic]);
  });
});
