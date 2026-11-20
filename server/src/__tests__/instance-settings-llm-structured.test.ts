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

const primary = { id: "primary", name: "Primary", baseUrl: "https://first.example.test/v1", model: "vendor/first" };
const secondary = { id: "secondary", name: "Secondary", baseUrl: "https://second.example.test/v1" };

it("manages providers and resolves default, explicit, and legacy runtime configuration", async () => {
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a1".repeat(32));
  const svc = instanceSettingsService(db);
  const apiKey = "primary-provider-test-secret";
  const legacy = { baseUrl: "https://legacy.example.test/v1", model: "legacy/model", apiKey: "legacy-test-secret" };
  const stored = async () => (await db.select().from(instanceSettings))[0].general.llmStructuredProviders;
  const { general } = await svc.updateGeneral(patchInstanceGeneralSettingsSchema.parse({
    llmStructuredProviders: [{ ...primary, apiKey }, secondary],
    llmStructuredDefaultProviderId: secondary.id,
    llmStructuredBaseUrl: legacy.baseUrl,
    llmStructuredModel: legacy.model,
    llmStructuredApiKey: legacy.apiKey,
  }));
  const encrypted = await stored();
  expect(encrypted).toMatchObject([{ apiKeyEncrypted: { material: { scheme: "local_encrypted_v1" } } }, secondary]);
  expect(JSON.stringify(encrypted)).not.toContain(apiKey);
  expect(general.llmStructuredProviders).toEqual([
    { ...primary, apiKeyConfigured: true }, { ...secondary, apiKeyConfigured: false },
  ]);
  expect(instanceGeneralSettingsSchema.parse(general)).toEqual(general);
  expect(general.llmStructuredDefaultProviderId).toBe(secondary.id);
  expect(await svc.getLlmStructuredRuntimeConfig()).toEqual({ baseUrl: secondary.baseUrl, model: undefined, apiKey: undefined });
  expect(await svc.getLlmStructuredRuntimeConfig(primary.id)).toEqual({ baseUrl: primary.baseUrl, model: primary.model, apiKey });
  expect(await svc.getLlmStructuredRuntimeConfig("missing")).toEqual(legacy);

  const renamed = { ...primary, name: "Renamed" };
  await svc.updateGeneral({ llmStructuredProviders: [renamed, secondary] });
  expect(await stored()).toEqual([{ ...(encrypted as object[])[0], name: renamed.name }, secondary]);
  expect((await svc.getGeneral()).llmStructuredProviders?.[0]).toEqual({ ...renamed, apiKeyConfigured: true });
  await svc.updateGeneral({ llmStructuredDefaultProviderId: null });
  expect((await svc.getLlmStructuredRuntimeConfig()).apiKey).toBe(apiKey);
  await svc.updateGeneral({ llmStructuredDefaultProviderId: secondary.id });
  const cleared = await svc.updateGeneral({ llmStructuredProviders: [{ ...renamed, apiKey: null }] });
  expect(cleared.general.llmStructuredProviders).toEqual([{ ...renamed, apiKeyConfigured: false }]);
  expect(cleared.general).not.toHaveProperty("llmStructuredDefaultProviderId");
  expect(await stored()).toEqual([renamed]);
});

it("discovers models using a stored provider key and does not echo upstream secrets", async () => {
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a1".repeat(32));
  const svc = instanceSettingsService(db);
  const apiKey = "discovery-test-secret";
  await svc.updateGeneral({ llmStructuredProviders: [{ ...primary, apiKey }] });
  const input = { providerId: primary.id, baseUrl: `${primary.baseUrl}/` };
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: [{ id: "z" }, { id: "a" }, { id: "z" }, { id: `echo:${apiKey}` }, { id: " " }] }))
    .mockResolvedValueOnce(new Response(apiKey, { status: 401 }))
    .mockRejectedValueOnce(new Error(apiKey));
  expect(await svc.testLlmStructuredConnection(input, { fetchImpl })).toMatchObject({ ok: true, statusCode: 200, models: ["a", "z"] });
  expect(fetchImpl).toHaveBeenNthCalledWith(1, `${primary.baseUrl}/models`, expect.objectContaining({
    method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  }));
  const unauthorized = await svc.testLlmStructuredConnection(input, { fetchImpl });
  expect(unauthorized).toMatchObject({ ok: false, statusCode: 401, models: [], error: "upstream_http_error" });
  const offline = await svc.testLlmStructuredConnection(input, { fetchImpl });
  expect(offline).toMatchObject({ ok: false, models: [], error: "network_error" });
  expect(JSON.stringify([unauthorized, offline])).not.toContain(apiKey);
  expect(await svc.testLlmStructuredConnection({ ...input, providerId: "missing" }, { fetchImpl })).toEqual({
    ok: false, latencyMs: 0, models: [], error: "api_key_required",
  });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it("rejects writes to the configured flag and keys containing embedded control characters", () => {
  expect(patchInstanceGeneralSettingsSchema.safeParse({ llmStructuredApiKeyConfigured: true }).success).toBe(false);
  for (const value of ["a\nb", "a\rb", "a\0b"]) {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ llmStructuredApiKey: value }).success).toBe(false);
  }
});
