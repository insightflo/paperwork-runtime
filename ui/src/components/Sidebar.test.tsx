import { describe, expect, it } from "vitest";
import { humanOperatorBadgeCount } from "./human-operator-badge-count";

describe("Sidebar", () => {
  it("adds pending Interactive Cards without dropping existing request counts", () => {
    expect(humanOperatorBadgeCount(3, 2)).toBe(5);
    expect(humanOperatorBadgeCount(undefined, undefined)).toBe(0);
  });
});
