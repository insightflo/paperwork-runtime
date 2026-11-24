import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { patchInstanceExperimentalSettingsSchema, patchInstanceGeneralSettingsSchema } from "@paperclipai/shared";
import { llmStructuredTestConnectionSchema } from "@paperclipai/shared/validators/instance";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import {
  getPiCliStatus,
  isValidCliRuntimeId,
  logoutPiCliProvider,
  runCliRuntimeUpdate,
  syncInstanceProvidersWithPiCli,
} from "../services/pi-cli-manager.js";
import {
  isValidProviderAuthId,
  planProviderLogin,
  probeAllProviders,
  ProviderAuthClientError,
} from "../services/provider-auth-core-client.js";
import {
  checkProviderRuntimeBlocklist,
  ProviderRuntimeEngineError,
} from "../services/provider-runtime-engine-client.js";
import { routeQuotaWithEngine } from "../services/quota-router-engine-client.js";
import { getActorInfo } from "./authz.js";

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function sendProviderAuthError(res: Response, err: unknown) {
  if (err instanceof ProviderAuthClientError) {
    res.status(503).json({ error: "provider_auth_probe_unavailable", reason: err.reason });
    return;
  }
  throw err;
}

async function logInstanceCliActivity(
  db: Db,
  svc: ReturnType<typeof instanceSettingsService>,
  req: Request,
  action: string,
  details: Record<string, unknown>,
) {
  const actor = getActorInfo(req);
  const companyIds = await svc.listCompanyIds();
  await Promise.all(
    companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action,
        entityType: "instance_settings",
        entityId: "default",
        details,
      }),
    ),
  );
}

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);

  router.get("/instance/settings/general", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await svc.getGeneral());
  });

  router.patch(
    "/instance/settings/general",
    validate(patchInstanceGeneralSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateGeneral(req.body);
      if (
        req.body.llmStructuredProviders !== undefined ||
        req.body.llmStructuredBaseUrl !== undefined ||
        req.body.llmStructuredApiKey !== undefined
      ) {
        await syncInstanceProvidersWithPiCli(db, { direction: "to_pi" }).catch(() => undefined);
      }
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              general: updated.general,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.general);
    },
  );

  router.post(
    "/instance/settings/general/llm-structured/test",
    validate(llmStructuredTestConnectionSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      res.json(await svc.testLlmStructuredConnection(req.body));
    },
  );

  router.get("/instance/settings/general/pi-cli/status", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await getPiCliStatus());
  });

  router.post("/instance/settings/general/pi-cli/sync", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const direction: unknown = req.body?.direction;
    if (direction !== undefined && direction !== "both" && direction !== "to_pi" && direction !== "from_pi") {
      throw badRequest("direction must be one of: both, to_pi, from_pi");
    }
    const result = await syncInstanceProvidersWithPiCli(db, { direction });
    await logInstanceCliActivity(db, svc, req, "instance.settings.cli_synced", {
      direction: direction ?? "both",
      ok: result.ok,
      message: result.message,
    });
    res.json(result);
  });

  router.post("/instance/settings/general/pi-cli/update", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const target: unknown = req.body?.target;
    if (target !== "self" && target !== "models") {
      throw badRequest("target must be one of: self, models");
    }
    const runtimeId: unknown = req.body?.runtimeId;
    if (runtimeId !== undefined && !isValidCliRuntimeId(runtimeId)) {
      throw badRequest("invalid runtimeId");
    }
    const result = await runCliRuntimeUpdate(runtimeId ?? "pi", target);
    await logInstanceCliActivity(db, svc, req, "instance.settings.cli_updated", {
      runtimeId: runtimeId ?? "pi",
      target,
      ok: result.ok,
      message: result.message,
    });
    res.json(result);
  });

  router.post("/instance/settings/general/pi-cli/logout", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const providerId: unknown = req.body?.providerId;
    if (typeof providerId !== "string" || providerId.length === 0) {
      throw badRequest("providerId is required");
    }
    const runtimeId: unknown = req.body?.runtimeId;
    if (runtimeId !== undefined && !isValidCliRuntimeId(runtimeId)) {
      throw badRequest("invalid runtimeId");
    }
    const result = await logoutPiCliProvider(providerId, { runtimeId: runtimeId ?? "pi" });
    await logInstanceCliActivity(db, svc, req, "instance.settings.cli_logout", {
      runtimeId: runtimeId ?? "pi",
      providerId,
      ok: result.ok,
    });
    res.json(result);
  });

  router.get("/instance/settings/general/provider-auth", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json({ providers: await probeAllProviders() });
    } catch (err) {
      sendProviderAuthError(res, err);
    }
  });

  router.get("/instance/settings/general/provider-auth/:provider/login-plan", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.setHeader("Cache-Control", "no-store");
    const provider: unknown = req.params.provider;
    if (!isValidProviderAuthId(provider)) {
      throw badRequest("provider must be one of: claude, codex, pi, commandcode, devin");
    }
    try {
      res.json({ plan: await planProviderLogin(provider) });
    } catch (err) {
      sendProviderAuthError(res, err);
    }
  });

  router.post("/instance/settings/provider-runtimes/check-blocklist", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await checkProviderRuntimeBlocklist(req.body);
      res.json({
        advisory: true,
        blocked: result.blocked,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      });
    } catch (err) {
      if (err instanceof ProviderRuntimeEngineError && err.reason === "invalid_input") {
        res.status(400).json({ error: "Invalid provider runtime blocklist request" });
        return;
      }
      res.status(503).json({ error: "Provider runtime blocklist check unavailable" });
    }
  });

  router.post("/instance/settings/quota-router/route", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.setHeader("Cache-Control", "no-store");
    const outcome = await routeQuotaWithEngine(req.body);
    if (outcome.ok) {
      res.json({ advisory: true, ...outcome.result });
      return;
    }
    if (outcome.kind === "invalid_input") {
      res.status(400).json({ error: "Invalid quota route request" });
      return;
    }
    res.status(503).json({ error: "Quota router unavailable" });
  });

  router.get("/instance/settings/experimental", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await svc.getExperimental());
  });

  router.patch(
    "/instance/settings/experimental",
    validate(patchInstanceExperimentalSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateExperimental(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.experimental_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              experimental: updated.experimental,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.experimental);
    },
  );

  return router;
}
