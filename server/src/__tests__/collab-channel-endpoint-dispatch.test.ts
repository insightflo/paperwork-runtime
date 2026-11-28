// [파일 목적] Stage 35 W5 — collab-channels 서비스의 `@<botName> list|read|run` 엔드포인트
//   디스패치 통합 테스트(실제 PGlite DB + 격리된 페어링 스토어 주입).
// [범위] 일반 메시지 무변화, 온라인 페어링 봇 list/run 큐잉 + taskId 시스템 답글, 오프라인 답글,
//        ro 폴더 run 정책 거부 답글, 미페어링 봇 이름 안내 답글. 에이전트 @mention wakeup 보존 검증 포함.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, collabMessages, companies, type Db } from "@paperclipai/db";
import { collabChannelsService } from "../services/collab-channels.js";
import { createEndpointBotPairingService } from "../services/endpoint-bot-pairing.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

let db: Db;
let closeDb: () => void = () => undefined;
beforeAll(async () => {
  const terminal = await terminalDatabase();
  db = terminal.db;
  closeDb = terminal.close;
}, 60_000);
afterAll(() => closeDb());

async function seedCompanyAndAgent() {
  const [company] = await db.insert(companies).values({ name: `Co-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  const [alpha] = await db.insert(agents).values({ companyId: company.id, name: "alpha", status: "running" }).returning();
  return { company, alpha };
}

/** 격리된 페어링 서비스 + 채널/스레드를 준비한다. lastSeenAtMs 로 온라인/오프라인을 제어한다. */
async function setupThread(mode: "ro" | "rw" = "rw", lastSeenAtMs = Date.now()) {
  const { company, alpha } = await seedCompanyAndAgent();
  const endpoint = createEndpointBotPairingService();
  const { code } = endpoint.issuePairingCode({
    companyId: company.id, botName: "my-mac", requestedFolders: [{ path: "/work", mode }], nowMs: lastSeenAtMs,
  });
  const { deviceId } = endpoint.completePairing({ code, os: "darwin", arch: "arm64", detectedClis: [], nowMs: lastSeenAtMs });
  const svc = collabChannelsService(db, endpoint);
  const channel = await svc.createChannel(company.id, { name: "Ops Crew", memberAgentIds: [alpha.id] });
  const thread = await svc.createThread(company.id, channel.id, {
    title: "Endpoint work", body: "kick off @alpha", authorType: "user", authorId: "local-board",
  });
  return { company, alpha, endpoint, svc, channel, thread, deviceId };
}

async function threadMessages(companyId: string, channelId: string, threadId: string) {
  return db.select().from(collabMessages).where(and(
    eq(collabMessages.companyId, companyId),
    eq(collabMessages.channelId, channelId),
    eq(collabMessages.threadId, threadId),
  ));
}

async function systemReply(companyId: string, channelId: string, threadId: string) {
  const messages = await threadMessages(companyId, channelId, threadId);
  return messages.find((message) => message.authorType === "system") ?? null;
}

describe("collab channel endpoint dispatch", () => {
  it("leaves ordinary channel messages fully unchanged", async () => {
    const { company, alpha, endpoint, svc, channel, thread, deviceId } = await setupThread();
    const posted = await svc.postMessage(company.id, channel.id, thread.id, {
      body: "please review the pricing page @alpha", authorType: "user", authorId: "local-board",
    });
    expect(posted.authorType).toBe("user");
    const messages = await threadMessages(company.id, channel.id, thread.id);
    expect(messages.map((message) => message.authorType)).toEqual(["user", "user"]);
    expect(endpoint.pollPendingTasks({ companyId: company.id, deviceId })).toEqual([]);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.source, "on_demand"));
    expect(wakes.filter((wake) => (wake.payload as { threadId?: string } | null)?.threadId === thread.id))
      .toHaveLength(2);
    expect(wakes.every((wake) => wake.agentId === alpha.id)).toBe(true);
  });

  it("enqueues a local task for @my-mac list and posts a system reply with the taskId", async () => {
    const { company, alpha, endpoint, svc, channel, thread, deviceId } = await setupThread();
    const posted = await svc.postMessage(company.id, channel.id, thread.id, {
      body: "@my-mac list /work", authorType: "user", authorId: "local-board",
    });
    expect(posted.authorType).toBe("user");
    const tasks = endpoint.pollPendingTasks({ companyId: company.id, deviceId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "list_dir", targetPath: "/work", status: "pending" });
    const reply = await systemReply(company.id, channel.id, thread.id);
    expect(reply?.actionKind).toBe("message");
    expect(reply?.expectsReply).toBe(false);
    expect(reply?.body).toContain(tasks[0]!.taskId);
    expect(reply?.body).toContain("@my-mac");
    // 스레드 본문 @alpha wakeup 은 그대로다. 채널 멤버가 하나뿐이라 @my-mac 발화도 기존 상태머신의
    // single_member 폴백으로 alpha 를 깨운다(엔드포인트 디스패치는 wakeup 흐름을 건드리지 않는다).
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.source, "on_demand"));
    const threadWakes = wakes.filter((wake) => (wake.payload as { threadId?: string } | null)?.threadId === thread.id);
    expect(threadWakes).toHaveLength(2);
    expect(threadWakes.every((wake) => wake.agentId === alpha.id)).toBe(true);
  });

  it("enqueues run commands for rw folders like read commands", async () => {
    const { company, endpoint, svc, channel, thread, deviceId } = await setupThread();
    await svc.postMessage(company.id, channel.id, thread.id, {
      body: "@my-mac run /work -- pwd", authorType: "user", authorId: "local-board",
    });
    const tasks = endpoint.pollPendingTasks({ companyId: company.id, deviceId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "shell_exec", targetPath: "/work", command: "pwd" });
    const reply = await systemReply(company.id, channel.id, thread.id);
    expect(reply?.body).toContain(tasks[0]!.taskId);
  });

  it("answers with an offline notice without enqueuing or throwing", async () => {
    const { company, endpoint, svc, channel, thread, deviceId } = await setupThread("rw", Date.now() - 61_000);
    const posted = await svc.postMessage(company.id, channel.id, thread.id, {
      body: "@my-mac read /work/README.md", authorType: "user", authorId: "local-board",
    });
    expect(posted.authorType).toBe("user");
    expect(endpoint.pollPendingTasks({ companyId: company.id, deviceId })).toEqual([]);
    const reply = await systemReply(company.id, channel.id, thread.id);
    expect(reply?.body).toContain("offline");
    expect(reply?.body).toContain("@my-mac");
  });

  it("answers with a policy denial for run in a read-only folder without throwing", async () => {
    const { company, endpoint, svc, channel, thread, deviceId } = await setupThread("ro");
    const posted = await svc.postMessage(company.id, channel.id, thread.id, {
      body: "@my-mac run /work -- pwd", authorType: "user", authorId: "local-board",
    });
    expect(posted.authorType).toBe("user");
    expect(endpoint.pollPendingTasks({ companyId: company.id, deviceId })).toEqual([]);
    const reply = await systemReply(company.id, channel.id, thread.id);
    expect(reply?.body).toContain("could not accept");
  });

  it("answers that an unpaired bot name was not found without enqueuing", async () => {
    const { company, endpoint, svc, channel, thread, deviceId } = await setupThread();
    await svc.postMessage(company.id, channel.id, thread.id, {
      body: "@ghost list /work", authorType: "user", authorId: "local-board",
    });
    expect(endpoint.pollPendingTasks({ companyId: company.id, deviceId })).toEqual([]);
    const reply = await systemReply(company.id, channel.id, thread.id);
    expect(reply?.body).toContain("No paired endpoint named @ghost");
  });
});
