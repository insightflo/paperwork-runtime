import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { dashboardDgateService } from "../services/dashboard-dgate.js";
import { dashboardTelemetryService } from "../services/dashboard-telemetry.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);
  const telemetrySvc = dashboardTelemetryService(db);
  const dgateSvc = dashboardDgateService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  router.get("/companies/:companyId/dashboard/telemetry", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await telemetrySvc.telemetry(companyId, req.query.window);
    res.json(data);
  });

  router.get("/companies/:companyId/dashboard/dgate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await dgateSvc.getSnapshot(companyId);
    res.json(data);
  });

  return router;
}
