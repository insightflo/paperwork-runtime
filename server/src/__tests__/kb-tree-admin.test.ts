// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canonNodeSlugFor, syncPromotedCanonToKb } from "../services/knowledge/kb-tree-admin.js";

describe("Quality RSI canon -> KB sync", () => {
  it("produces deterministic canon-* slugs regardless of punctuation or casing", () => {
    expect(canonNodeSlugFor("QA_Escaped_Missing_Source!")).toBe("canon-qa_escaped_missing_source");
    expect(canonNodeSlugFor("   ")).toBe("canon-rule");
  });

  it("fails open and returns { synced: false } if DB throws", async () => {
    const brokenDb = {
      select: () => { throw new Error("db offline"); },
    } as never;
    const res = await syncPromotedCanonToKb(brokenDb, {
      companyId: "c1",
      patternId: "p1",
      code: "qa_escaped_asset",
      title: "Asset verification rule",
      summary: "Verify all asset links before completion.",
    });
    expect(res).toEqual({ synced: false });
  });
});
