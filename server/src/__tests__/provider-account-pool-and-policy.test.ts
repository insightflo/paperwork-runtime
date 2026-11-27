import { createDb, instanceSettings, type Db } from "@paperclipai/db";
import { patchInstanceGeneralSettingsSchema } from "@paperclipai/shared";
import { hiddenModelsSchema, promptCacheTtlSchema, providerAccountPoolStrategySchema } from "@paperclipai/shared/validators/instance";
import { afterAll, beforeAll, expect, it } from "vitest";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  filterVisibleModels,
  pickPoolAccount,
  type AccountUsageWindow,
  type PoolCandidate,
  type PoolStrategy,
} from "../services/provider-account-pool.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const NOW = 5_000_000;
const DAY_MINS = 24 * 60;

const win = (usedPercent: number, windowDurationMins: number | null, resetsInSec: number | null): AccountUsageWindow => ({
  usedPercent,
  windowDurationMins,
  resetsAtEpochSec: resetsInSec === null ? null : NOW + resetsInSec,
});
const acct = (accountId: string, primary: AccountUsageWindow | null, secondary: AccountUsageWindow | null = null): PoolCandidate =>
  ({ accountId, ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) });
const pick = (
  candidates: readonly PoolCandidate[],
  opts: { currentAccountId?: string; strategy?: PoolStrategy } = {},
) => pickPoolAccount({ candidates, nowEpochSec: NOW, ...opts });

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("account-pool-policy-");
  db = createDb(tempDb.connectionString);
}, 60_000);

afterAll(async () => {
  if (db) await db.$client.end({ timeout: 5 });
  await tempDb?.cleanup();
}, 30_000);

it("keeps 15% buffer for short windows, 5% for long windows, 10% for unknown duration", () => {
  expect(pick([acct("short", win(85, 300, 3600)), acct("long", win(85, DAY_MINS + 60, 3600))])).toBe("long");
  expect(pick([acct("unknown", win(90, null, 3600)), acct("long", win(90, DAY_MINS + 60, 3600))])).toBe("long");
  expect(pick([acct("unknown", win(89.9, null, 3600)), acct("long", win(99.9, DAY_MINS + 60, 3600))])).toBe("unknown");
});

it("treats an expired reset window as 0% used", () => {
  expect(pick([acct("spent", win(100, 300, -60)), acct("half", win(50, 300, 3600))])).toBe("spent");
});

it("picks the earliest reset and sticks to the current account within the 10-minute tie window", () => {
  expect(pick([acct("a", win(50, 300, 3600)), acct("b", win(50, 300, 7200))])).toBe("a");
  expect(pick([acct("a", win(50, 300, 600)), acct("b", win(50, 300, 900))], { currentAccountId: "b" })).toBe("b");
  expect(pick([acct("a", win(50, 300, 600)), acct("b", win(50, 300, 1300))], { currentAccountId: "b" })).toBe("a");
});

it("falls back to the account with the most capacity left when every buffer is exhausted", () => {
  expect(pick([acct("a", win(100, 300, 3600)), acct("b", win(95, 300, 7200))])).toBe("b");
  expect(pick([acct("a", win(100, 300, 3600)), acct("b", win(100, 300, 7200))], { currentAccountId: "b" })).toBe("b");
});

it("rotates round_robin through usable accounts and honors manual pinning", () => {
  const fresh = [acct("a", win(10, 300, 3600)), acct("b", win(10, 300, 3600)), acct("c", win(10, 300, 3600))];
  expect(pick(fresh, { strategy: "round_robin" })).toBe("a");
  expect(pick(fresh, { currentAccountId: "b", strategy: "round_robin" })).toBe("c");
  expect(pick(fresh, { currentAccountId: "c", strategy: "round_robin" })).toBe("a");
  const hot = [acct("a", win(99, 300, 3600)), acct("b", win(99, 300, 3600))];
  expect(pick(hot, { currentAccountId: "a", strategy: "round_robin" })).toBe("b");
  expect(pick(fresh, { currentAccountId: "c", strategy: "manual" })).toBe("c");
  expect(pick(fresh, { strategy: "manual" })).toBe("a");
  expect(pick(fresh, { currentAccountId: "zz", strategy: "manual" })).toBe("a");
  expect(pickPoolAccount({ candidates: [] })).toBe(null);
});

it("filters hidden models with case-insensitive trimmed exact match", () => {
  expect(filterVisibleModels([" gpt-4 ", "GPT-4o", "claude"], ["gpt-4", " CLAUDE "])).toEqual(["GPT-4o"]);
  expect(filterVisibleModels(["m1", "m2"], [])).toEqual(["m1", "m2"]);
  expect(filterVisibleModels(["m1"], undefined)).toEqual(["m1"]);
});

it("validates and sanitizes the new general settings fields", () => {
  expect(hiddenModelsSchema.parse([" A ", "a", "b", "a", "   "])).toEqual(["A", "a", "b"]);
  expect(hiddenModelsSchema.safeParse(Array.from({ length: 201 }, () => "m")).success).toBe(false);
  expect(hiddenModelsSchema.safeParse(["x".repeat(161)]).success).toBe(false);
  expect(promptCacheTtlSchema.parse("1h")).toBe("1h");
  expect(promptCacheTtlSchema.safeParse("10m").success).toBe(false);
  expect(providerAccountPoolStrategySchema.parse("round_robin")).toBe("round_robin");
  expect(providerAccountPoolStrategySchema.safeParse("random").success).toBe(false);
  expect(patchInstanceGeneralSettingsSchema.parse({
    hiddenModels: [" a ", "a"],
    promptCacheTtl: "5m",
    providerAccountPoolStrategy: "manual",
  })).toEqual({ hiddenModels: ["a"], promptCacheTtl: "5m", providerAccountPoolStrategy: "manual" });
  expect(patchInstanceGeneralSettingsSchema.safeParse({ promptCacheTtl: "2d" }).success).toBe(false);
});

it("persists and projects hiddenModels, promptCacheTtl, and providerAccountPoolStrategy", async () => {
  const svc = instanceSettingsService(db);
  const { general } = await svc.updateGeneral(patchInstanceGeneralSettingsSchema.parse({
    hiddenModels: [" secret-model ", "secret-model", "other"],
    promptCacheTtl: "1h",
    providerAccountPoolStrategy: "round_robin",
  }));
  const expected = { hiddenModels: ["secret-model", "other"], promptCacheTtl: "1h", providerAccountPoolStrategy: "round_robin" };
  expect(general).toMatchObject(expected);
  expect(await svc.getGeneral()).toMatchObject(expected);
  expect((await db.select().from(instanceSettings))[0].general).toMatchObject({ hiddenModels: ["secret-model", "other"] });
  await svc.updateGeneral({ censorUsernameInLogs: true });
  expect(await svc.getGeneral()).toMatchObject(expected);
});
