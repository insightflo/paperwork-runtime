import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { forbidden } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import {
  createQueueTelemetryRouter,
  type QueueTelemetryRouteDeps,
} from "../routes/queue-telemetry.js";

function createApp(deps: QueueTelemetryRouteDeps) {
  const app = express();
  app.use("/api", createQueueTelemetryRouter(deps));
  app.use(errorHandler);
  return app;
}

describe("queue telemetry router", () => {
  it("returns fleet telemetry JSON after asserting company access", async () => {
    const payload = { companyId: "c1", waiting: 2, running: 1 };
    const assertCompanyAccess = vi.fn();
    const getFleetTelemetry = vi.fn().mockResolvedValue(payload);

    const res = await request(createApp({ assertCompanyAccess, getFleetTelemetry }))
      .get("/api/companies/c1/queue-telemetry");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(assertCompanyAccess).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(getFleetTelemetry).toHaveBeenCalledWith("c1");
    expect(assertCompanyAccess.mock.invocationCallOrder[0])
      .toBeLessThan(getFleetTelemetry.mock.invocationCallOrder[0]);
  });

  it("returns fleet telemetry CSV with attachment headers when configured", async () => {
    const csv = "agent,status\nagent-1,running\n";
    const assertCompanyAccess = vi.fn();
    const getFleetTelemetry = vi.fn();
    const exportFleetTelemetryCsv = vi.fn().mockResolvedValue(csv);

    const res = await request(createApp({ assertCompanyAccess, getFleetTelemetry, exportFleetTelemetryCsv }))
      .get("/api/companies/c1/queue-telemetry/export.csv");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="queue-telemetry.csv"');
    expect(res.text).toBe(csv);
    expect(assertCompanyAccess).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(exportFleetTelemetryCsv).toHaveBeenCalledWith("c1");
    expect(getFleetTelemetry).not.toHaveBeenCalled();
  });

  it("returns 501 when CSV export is not configured", async () => {
    const assertCompanyAccess = vi.fn();
    const getFleetTelemetry = vi.fn();

    const res = await request(createApp({ assertCompanyAccess, getFleetTelemetry }))
      .get("/api/companies/c1/queue-telemetry/export.csv");

    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "CSV export not configured" });
    expect(assertCompanyAccess).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(getFleetTelemetry).not.toHaveBeenCalled();
  });

  it("propagates access denial to error middleware without loading telemetry", async () => {
    const assertCompanyAccess = vi.fn(() => {
      throw forbidden("denied");
    });
    const getFleetTelemetry = vi.fn();

    const res = await request(createApp({ assertCompanyAccess, getFleetTelemetry }))
      .get("/api/companies/c1/queue-telemetry");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "denied" });
    expect(getFleetTelemetry).not.toHaveBeenCalled();
  });

  it("forwards async telemetry errors to error middleware", async () => {
    const assertCompanyAccess = vi.fn();
    const getFleetTelemetry = vi.fn().mockRejectedValue(new Error("telemetry failed"));

    const res = await request(createApp({ assertCompanyAccess, getFleetTelemetry }))
      .get("/api/companies/c1/queue-telemetry");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
