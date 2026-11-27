// server/src/__tests__/endpoint-task-audit.test.ts
//
// [파일 목적] 개인 엔드포인트 봇 감사 링 버퍼(Stage 33 W2F) 단위 테스트.
//   회사 격리, 최신순 정렬, deviceId 필터, maxPerCompany 퇴거, 시크릿 마스킹,
//   stats 카운터를 검증한다. 순수 인메모리 서비스라 DB fixture 불필요.

import { describe, expect, it } from "vitest";
import {
  createEndpointAuditStore,
  redactAuditSecrets,
  type EndpointAuditEvent,
} from "../services/endpoint-task-audit.js";

const C1 = "11111111-1111-1111-1111-111111111111";
const C2 = "22222222-2222-2222-2222-222222222222";

let seq = 0;
function event(overrides: Partial<EndpointAuditEvent> = {}): EndpointAuditEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    companyId: C1,
    deviceId: "dev-1",
    botName: "dolshoi-bot",
    taskId: `task-${seq}`,
    kind: "dispatch",
    targetPath: "/api/tasks",
    outcome: "enqueued",
    summary: "dispatched task",
    createdAtMs: 1_000 + seq,
    ...overrides,
  };
}

describe("redactAuditSecrets", () => {
  it("redacts Bearer tokens", () => {
    expect(redactAuditSecrets("Authorization: Bearer abc.def123_GH-456")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts sk- style API keys", () => {
    expect(redactAuditSecrets("using key sk-proj-abc123def456ghi789 now")).toBe(
      "using key [REDACTED] now",
    );
  });

  it("redacts ghp_ GitHub tokens", () => {
    expect(redactAuditSecrets("token ghp_0123456789abcdefghijklmnopqrstuv")).toBe(
      "token [REDACTED]",
    );
  });

  it("redacts xoxb- Slack tokens", () => {
    expect(redactAuditSecrets("xoxb-123456789-1234567890123-abcdefg")).toBe("[REDACTED]");
  });

  it("redacts token=, password=, api_key= values", () => {
    const text = "?token=secret123&user=me password=hunter2 api_key=XYZ987";
    const out = redactAuditSecrets(text);
    expect(out).not.toContain("secret123");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("XYZ987");
    expect(out).toContain("token=[REDACTED]");
    expect(out).toContain("password=[REDACTED]");
    expect(out).toContain("api_key=[REDACTED]");
    expect(out).toContain("user=me");
  });

  it("leaves ordinary text untouched", () => {
    const text = "dispatched issue-42 to personal endpoint bridge";
    expect(redactAuditSecrets(text)).toBe(text);
  });
});

describe("createEndpointAuditStore", () => {
  it("record redacts secrets in the stored summary", () => {
    const store = createEndpointAuditStore();
    store.record(event({ summary: "call with Bearer supersecrettoken99" }));
    const [first] = store.list(C1);
    expect(first?.summary).toBe("call with Bearer [REDACTED]");
    expect(first?.summary).not.toContain("supersecrettoken99");
  });

  it("list is strictly company-isolated", () => {
    const store = createEndpointAuditStore();
    store.record(event({ companyId: C1, taskId: "c1-a" }));
    store.record(event({ companyId: C1, taskId: "c1-b" }));
    store.record(event({ companyId: C2, taskId: "c2-a" }));
    expect(store.list(C1).map((e) => e.taskId)).toEqual(["c1-b", "c1-a"]);
    expect(store.list(C2).map((e) => e.taskId)).toEqual(["c2-a"]);
  });

  it("list returns newest-first ordering", () => {
    const store = createEndpointAuditStore();
    store.record(event({ taskId: "old" }));
    store.record(event({ taskId: "middle" }));
    store.record(event({ taskId: "newest" }));
    expect(store.list(C1).map((e) => e.taskId)).toEqual(["newest", "middle", "old"]);
    expect(store.list(C1)[0]?.createdAtMs).toBeGreaterThanOrEqual(store.list(C1)[1]!.createdAtMs);
  });

  it("list filters by deviceId when given", () => {
    const store = createEndpointAuditStore();
    store.record(event({ deviceId: "dev-1", taskId: "d1" }));
    store.record(event({ deviceId: "dev-2", taskId: "d2" }));
    store.record(event({ deviceId: "dev-1", taskId: "d3" }));
    const only = store.list(C1, { deviceId: "dev-2" });
    expect(only.map((e) => e.taskId)).toEqual(["d2"]);
    expect(only.every((e) => e.deviceId === "dev-2")).toBe(true);
  });

  it("list caps results by limit and defaults to 50", () => {
    const store = createEndpointAuditStore();
    for (let i = 0; i < 5; i += 1) store.record(event({ taskId: `t-${i}` }));
    const capped = store.list(C1, { limit: 2 });
    expect(capped.map((e) => e.taskId)).toEqual(["t-4", "t-3"]);
    for (let i = 0; i < 52; i += 1) store.record(event({ taskId: `many-${i}` }));
    expect(store.list(C1)).toHaveLength(50);
    expect(store.list(C1)[0]?.taskId).toBe("many-51");
  });

  it("evicts oldest events beyond maxPerCompany", () => {
    const store = createEndpointAuditStore(3);
    store.record(event({ taskId: "a" }));
    store.record(event({ taskId: "b" }));
    store.record(event({ taskId: "c" }));
    store.record(event({ taskId: "d" }));
    store.record(event({ taskId: "e" }));
    expect(store.list(C1).map((e) => e.taskId)).toEqual(["e", "d", "c"]);
    expect(store.stats(C1).total).toBe(3);
  });

  it("stats counts outcomes per company", () => {
    const store = createEndpointAuditStore();
    store.record(event({ outcome: "enqueued", taskId: "1" }));
    store.record(event({ outcome: "completed", taskId: "2" }));
    store.record(event({ outcome: "completed", taskId: "3" }));
    store.record(event({ outcome: "failed", taskId: "4" }));
    store.record(event({ outcome: "denied", taskId: "5" }));
    store.record(event({ companyId: C2, outcome: "completed", taskId: "6" }));
    expect(store.stats(C1)).toEqual({ total: 5, enqueued: 1, completed: 2, failed: 1, denied: 1 });
    expect(store.stats(C2)).toEqual({ total: 1, enqueued: 0, completed: 1, failed: 0, denied: 0 });
    expect(store.stats(C1).total).toBe(store.list(C1, { limit: 100 }).length);
  });

  it("record returns an immutable copy decoupled from the caller input", () => {
    const store = createEndpointAuditStore();
    const input = event({ summary: "ok" });
    const stored = store.record(input);
    input.summary = "mutated after record";
    input.taskId = "mutated";
    const [first] = store.list(C1);
    expect(first?.summary).toBe("ok");
    expect(first?.taskId).not.toBe("mutated");
    expect(() => {
      (stored as { taskId: string }).taskId = "overwrite";
    }).toThrow();
  });
});
