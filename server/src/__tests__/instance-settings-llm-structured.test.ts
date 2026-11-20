import { createDb, instanceSettings, type Db } from "@paperclipai/db";
import { instanceGeneralSettingsSchema, patchInstanceGeneralSettingsSchema } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { instanceSettingsService } from "../services/instance-settings.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("instance-llm-structured-");
  db = createDb(tempDb.connectionString);
}, 60_000);

afterAll(async () => {
  if (db) await db.$client.end({ timeout: 5 });
  await tempDb?.cleanup();
}, 30_000);

afterEach(() => vi.unstubAllEnvs());

it("stores only encrypted key material, preserves it on omission, and clears it on null", async () => {
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a1".repeat(32));
  const svc = instanceSettingsService(db);
  const baseUrl = "https://llm.example.test/v1";
  const apiKey = "test-only-structured-provider-key";
  const readStored = async () => (await db.select().from(instanceSettings))[0].general;
  const updated = await svc.updateGeneral(patchInstanceGeneralSettingsSchema.parse({
    llmStructuredBaseUrl: baseUrl,
    llmStructuredModel: "vendor/model",
    llmStructuredApiKey: ` ${apiKey} `,
  }));
  const stored = await readStored();
  expect(stored).toMatchObject({ llmStructuredApiKeyEncrypted: { material: { scheme: "local_encrypted_v1" } } });
  expect(stored).not.toHaveProperty("llmStructuredApiKey");
  expect(JSON.stringify(stored)).not.toContain(apiKey);
  for (const general of [updated.general, await svc.getGeneral()]) {
    expect(general).toMatchObject({
      llmStructuredBaseUrl: baseUrl,
      llmStructuredModel: "vendor/model",
      llmStructuredApiKeyConfigured: true,
    });
    expect(general).not.toHaveProperty("llmStructuredApiKey");
    expect(general).not.toHaveProperty("llmStructuredApiKeyEncrypted");
    expect(instanceGeneralSettingsSchema.safeParse(general).success).toBe(true);
  }
  await svc.updateGeneral({ llmStructuredModel: "vendor/new-model" });
  expect((await readStored()).llmStructuredApiKeyEncrypted).toEqual(stored.llmStructuredApiKeyEncrypted);
  expect(await svc.getLlmStructuredRuntimeConfig()).toEqual({ baseUrl, model: "vendor/new-model", apiKey });

  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b2".repeat(32));
  expect(await svc.getLlmStructuredRuntimeConfig()).toEqual({ baseUrl, model: "vendor/new-model", apiKey: undefined });
  expect((await svc.updateGeneral({ llmStructuredApiKey: null })).general.llmStructuredApiKeyConfigured).toBe(false);
  expect((await svc.getGeneral()).llmStructuredApiKeyConfigured).toBe(false);
  expect(await readStored()).not.toHaveProperty("llmStructuredApiKeyEncrypted");
  expect((await svc.getLlmStructuredRuntimeConfig()).apiKey).toBeUndefined();
});

it("rejects writes to the configured flag and keys containing embedded control characters", () => {
  expect(patchInstanceGeneralSettingsSchema.safeParse({ llmStructuredApiKeyConfigured: true }).success).toBe(false);
  for (const value of ["a\nb", "a\rb", "a\0b"]) {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ llmStructuredApiKey: value }).success).toBe(false);
  }
});
