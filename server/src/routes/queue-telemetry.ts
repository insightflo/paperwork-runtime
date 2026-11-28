import { Router, type NextFunction, type Request, type Response } from "express";

export interface QueueTelemetryRouteDeps {
  assertCompanyAccess: (req: Request, companyId: string) => void;
  getFleetTelemetry: (companyId: string) => Promise<unknown>;
  exportFleetTelemetryCsv?: (companyId: string) => Promise<string>;
}

type QueueTelemetryHandler = (req: Request, res: Response) => Promise<void>;

function forwardErrors(handler: QueueTelemetryHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (err) {
      next(err);
    }
  };
}

export function createQueueTelemetryRouter(deps: QueueTelemetryRouteDeps): Router {
  const router = Router();

  router.get("/companies/:companyId/queue-telemetry", forwardErrors(async (req, res) => {
    const companyId = String(req.params.companyId);
    deps.assertCompanyAccess(req, companyId);
    res.status(200).json(await deps.getFleetTelemetry(companyId));
  }));

  router.get("/companies/:companyId/queue-telemetry/export.csv", forwardErrors(async (req, res) => {
    const companyId = String(req.params.companyId);
    deps.assertCompanyAccess(req, companyId);
    if (!deps.exportFleetTelemetryCsv) {
      res.status(501).json({ error: "CSV export not configured" });
      return;
    }

    const csv = await deps.exportFleetTelemetryCsv(companyId);
    res.status(200)
      .set("Content-Type", "text/csv; charset=utf-8")
      .set("Content-Disposition", 'attachment; filename="queue-telemetry.csv"')
      .send(csv);
  }));

  return router;
}
