import { afterEach, describe, expect, it, vi } from "vitest";
import { instanceSettings, type Db } from "@paperclipai/db";
import {
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  resolveJudgmentModel,
  resolveJudgmentProviderConfig,
} from "../services/judgment/provider-config.js";

type Row = Record<string, unknown>;

/** 최소 인메모리 DB 픽스처 — instanceSettingsService 가 사용하는 체인만 흉내낸다. */
function makeInstanceSettingsDb() {
  const tableRows = new Map<unknown, Row[]>([[instanceSettings, []]]);
  let nextId = 0;
  const toJson = (value: unknown) => JSON.parse(JSON.stringify(value));
  const rowsQuery = (result: Row[]) => {
    const query: Record<string, unknown> = {
      then: (onFulfilled: (rows: Row[]) => unknown, onRejected?: unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected as never),
    };
    for (const link of ["where", "orderBy", "limit"]) query[link] = () => query;
    return query as never;
  };
  const serializeObjects = (values: Row): Row => {
    const serialized: Row = { ...values };
    for (const key of Object.keys(serialized)) {
      const value = serialized[key];
      if (value !== null && typeof value === "object") serialized[key] = toJson(value);
    }
    return serialized;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => rowsQuery([...(tableRows.get(table) ?? [])]),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => ({
        onConflictDoUpdate: () => ({
          returning: () => {
            const row = { id: `row-${++nextId}`, ...serializeObjects(values) };
            tableRows.get(table)!.push(row);
            return rowsQuery([row]);
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => ({
          returning: () => {
            const merged = (tableRows.get(table) ?? []).map((row) => ({
              ...row,
              ...serializeObjects(values),
            }));
            tableRows.set(table, merged);
            return rowsQuery(merged);
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, tableRows };
}

describe("resolveJudgmentProviderConfig", () => {
  it("returns saved judgment overrides", async () => {
    const { db } = makeInstanceSettingsDb();
    await instanceSettingsService(db).updateGeneral({
      judgmentBaseUrl: "http://127.0.0.1:9",
      judgmentModelId: "alt-model-1",
    });

    await expect(resolveJudgmentProviderConfig(db)).resolves.toEqual({
      baseUrl: "http://127.0.0.1:9",
      modelId: "alt-model-1",
    });
  });

  it("omits cleared (null) overrides instead of returning null", async () => {
    const { db } = makeInstanceSettingsDb();
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ judgmentBaseUrl: "http://127.0.0.1:9", judgmentModelId: "alt-model-1" });
    await svc.updateGeneral({ judgmentModelId: null });

    await expect(resolveJudgmentProviderConfig(db)).resolves.toEqual({
      baseUrl: "http://127.0.0.1:9",
    });
  });
});

describe("resolveJudgmentProviderConfig — stored judgmentApiKey", () => {
  const apiKey = "test-only-judgment-secret";

  afterEach(() => vi.unstubAllEnvs());

  it("patch schema trims, rejects empty/control chars, and rejects the masked flag", () => {
    expect(patchInstanceGeneralSettingsSchema.parse({ judgmentApiKey: ` ${apiKey} ` }).judgmentApiKey).toBe(apiKey);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ judgmentApiKey: "" }).success).toBe(false);
    // trim 후 검증이므로 가장자리 개행은 제거되지만 내부 제어 문자는 거부된다.
    expect(patchInstanceGeneralSettingsSchema.parse({ judgmentApiKey: " k\n " }).judgmentApiKey).toBe("k");
    expect(patchInstanceGeneralSettingsSchema.safeParse({ judgmentApiKey: "k\n2" }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ judgmentApiKey: "k\0x" }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ judgmentApiKeyConfigured: true }).success).toBe(false);
  });

  it("stores only encrypted material, masks getGeneral, and resolves the decrypted key", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a1".repeat(32));
    const { db, tableRows } = makeInstanceSettingsDb();
    const svc = instanceSettingsService(db);
    await svc.updateGeneral(patchInstanceGeneralSettingsSchema.parse({ judgmentApiKey: ` ${apiKey} ` }));

    const storedGeneral = tableRows.get(instanceSettings)![0]!.general as Row;
    expect(storedGeneral.judgmentApiKeyEncrypted).toMatchObject({ material: { scheme: "local_encrypted_v1" } });
    expect(JSON.stringify(storedGeneral)).not.toContain(apiKey);

    const general = await svc.getGeneral();
    expect(general.judgmentApiKeyConfigured).toBe(true);
    expect(general).not.toHaveProperty("judgmentApiKey");
    expect(general).not.toHaveProperty("judgmentApiKeyEncrypted");
    expect(instanceGeneralSettingsSchema.safeParse(general).success).toBe(true);

    await expect(resolveJudgmentProviderConfig(db)).resolves.toEqual({ apiKey });
  });

  it("omission preserves the stored key; null clears it and resolution falls back to env", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a1".repeat(32));
    const { db } = makeInstanceSettingsDb();
    const svc = instanceSettingsService(db);
    await svc.updateGeneral(patchInstanceGeneralSettingsSchema.parse({ judgmentApiKey: apiKey }));

    await svc.updateGeneral({ judgmentBaseUrl: "http://127.0.0.1:9" });
    await expect(resolveJudgmentProviderConfig(db)).resolves.toEqual({
      baseUrl: "http://127.0.0.1:9",
      apiKey,
    });

    const cleared = await svc.updateGeneral(patchInstanceGeneralSettingsSchema.parse({ judgmentApiKey: null }));
    expect(cleared.general.judgmentApiKeyConfigured).toBe(false);
    await expect(resolveJudgmentProviderConfig(db)).resolves.toEqual({ baseUrl: "http://127.0.0.1:9" });
  });
});

describe("resolveJudgmentModel", () => {
  it("override wins; unset and null fall back to the definition model id", () => {
    expect(resolveJudgmentModel({ modelId: "alt-model-1" }, "jev-1.13.0")).toBe("alt-model-1");
    expect(resolveJudgmentModel({}, "jev-1.13.0")).toBe("jev-1.13.0");
    expect(resolveJudgmentModel({ modelId: null as unknown as string }, "jev-1.13.0")).toBe("jev-1.13.0");
  });
});
