import { describe, expect, it } from "vitest";
import { sortMissions } from "./mission-sort";
import type { MissionListItem, MissionStatus } from "../api/missions";

function mission(overrides: Partial<MissionListItem> & { id: string }): MissionListItem {
  return {
    companyId: "company-1",
    ownerAgentId: "agent-1",
    title: `Mission ${overrides.id}`,
    description: null,
    status: "active" satisfies MissionStatus,
    goalId: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** Fleet fixture delivered oldest-first, like the unsorted allMissions query. */
const FLEET = [
  mission({ id: "m-old-a", title: "Zebra", createdAt: "2026-01-01", updatedAt: "2026-01-01" } as never),
  mission({ id: "m-old-b", title: "Apple", createdAt: "2026-01-02", updatedAt: "2026-01-02" } as never),
  mission({
    id: "m-new-a",
    title: "Mango",
    status: "completed",
    createdAt: "2026-01-05",
    updatedAt: "2026-01-05",
  } as never),
  mission({
    id: "m-new-b",
    title: "Banana",
    status: "paused",
    createdAt: "2026-01-06",
    updatedAt: "2026-01-06",
  } as never),
];

const ids = (list: MissionListItem[]) => list.map((m) => m.id);

describe("sortMissions", () => {
  it("defaults to newest-updated-first even when the fleet input is oldest-first", () => {
    const result = sortMissions(FLEET, "updatedAt", "desc");
    expect(ids(result)).toEqual(["m-new-b", "m-new-a", "m-old-b", "m-old-a"]);
  });

  it("falls back to newest-updated-first for invalid sort values from the URL", () => {
    const result = sortMissions(FLEET, "hacked" as never, "sideways" as never);
    expect(ids(result)).toEqual(["m-new-b", "m-new-a", "m-old-b", "m-old-a"]);
  });

  it("sorts oldest-updated-first with updatedAt:asc", () => {
    expect(ids(sortMissions(FLEET, "updatedAt", "asc"))).toEqual([
      "m-old-a",
      "m-old-b",
      "m-new-a",
      "m-new-b",
    ]);
  });

  it("sorts newest-created-first with createdAt:desc and oldest-first with createdAt:asc", () => {
    expect(ids(sortMissions(FLEET, "createdAt", "desc"))).toEqual([
      "m-new-b",
      "m-new-a",
      "m-old-b",
      "m-old-a",
    ]);
    expect(ids(sortMissions(FLEET, "createdAt", "asc"))).toEqual([
      "m-old-a",
      "m-old-b",
      "m-new-a",
      "m-new-b",
    ]);
  });

  it("sorts titles A-Z with title:asc and Z-A with title:desc", () => {
    expect(ids(sortMissions(FLEET, "title", "asc"))).toEqual([
      "m-old-b",
      "m-new-b",
      "m-new-a",
      "m-old-a",
    ]);
    expect(ids(sortMissions(FLEET, "title", "desc"))).toEqual([
      "m-old-a",
      "m-new-a",
      "m-new-b",
      "m-old-b",
    ]);
  });

  it("sorts status alphabetically with status:asc and reversed with status:desc", () => {
    // "active" < "completed" < "paused"; active 동률은 updatedAt desc 타이브레이크로 m-old-b가 먼저.
    expect(ids(sortMissions(FLEET, "status", "asc"))).toEqual([
      "m-old-b",
      "m-old-a",
      "m-new-a",
      "m-new-b",
    ]);
    expect(ids(sortMissions(FLEET, "status", "desc"))).toEqual([
      "m-new-b",
      "m-new-a",
      "m-old-b",
      "m-old-a",
    ]);
  });

  it("breaks primary-key ties by updatedAt desc, then id asc", () => {
    const tied = [
      mission({ id: "b", updatedAt: "2026-03-01" } as never),
      mission({ id: "a", updatedAt: "2026-03-01" } as never),
      mission({ id: "z", updatedAt: "2026-04-01" } as never),
      mission({ id: "c", updatedAt: "2026-02-01" } as never),
    ];
    // status 전부 동률 → updatedAt desc: z(04) → b/a(03, id asc: a 먼저) → c(02).
    expect(ids(sortMissions(tied, "status", "asc"))).toEqual(["z", "a", "b", "c"]);
    // title은 전부 달라 타이브레이크 없이 역순.
    expect(ids(sortMissions(tied, "title", "desc"))).toEqual(["z", "c", "b", "a"]);
  });

  it("orders a filtered subset identically to the same members in the full list", () => {
    const full = sortMissions(FLEET, "createdAt", "asc");
    const subset = sortMissions(
      FLEET.filter((m) => m.status === "active"),
      "createdAt",
      "asc",
    );
    const fullOrder = ids(full).filter((id) => subset.some((m) => m.id === id));
    expect(ids(subset)).toEqual(fullOrder);
  });

  it("does not mutate the input array", () => {
    const input = [...FLEET];
    sortMissions(input, "title", "asc");
    expect(ids(input)).toEqual(["m-old-a", "m-old-b", "m-new-a", "m-new-b"]);
  });
});
