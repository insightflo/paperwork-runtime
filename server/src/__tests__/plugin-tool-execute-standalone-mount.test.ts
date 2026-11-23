import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { errorHandler } from "../middleware/index.js";
import { pluginToolExecuteRoutes } from "../routes/plugin-tool-execute.js";
import { pluginRoutes } from "../routes/plugins.js";
import { createHttpHandlerLifetime } from "../services/http-handler-lifetime.js";
import {
  observeExecuteToolSpy,
  PLUGIN_ROUTE_RECEIPT_COMPANY_ID,
  startPluginRouteReceiptFixture,
} from "./helpers/plugin-route-receipt-fixture.js";

const TOOL = "acme.linear:search-issues";
const runContext = { agentId: "agent-1", runId: "run-1", companyId: PLUGIN_ROUTE_RECEIPT_COMPANY_ID };

const makeDispatcher = () => observeExecuteToolSpy({
  listToolsForAgent: vi.fn(),
  getTool: vi.fn(() => ({ namespacedName: TOOL })),
  executeTool: vi.fn(async () => ({ content: "ok" })),
});

const boardApp = (router: express.Router) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user-1",
      companyIds: [PLUGIN_ROUTE_RECEIPT_COMPANY_ID],
      source: "session",
    } as never;
    next();
  });
  app.use("/api", router);
  app.use(errorHandler);
  return app;
};

type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: RouteLayer[] };
};

/** Recursively finds every route layer serving POST /plugins/tools/execute, tagged with its owning router stack. */
const collectExecuteLayers = (stack: RouteLayer[], hits: Array<{ stack: RouteLayer[]; layer: RouteLayer }>) => {
  for (const layer of stack) {
    if (layer.route?.path === "/plugins/tools/execute" && layer.route.methods.post) hits.push({ stack, layer });
    const nested = layer.handle?.stack;
    if (Array.isArray(nested)) collectExecuteLayers(nested, hits);
  }
};

let fixture: Awaited<ReturnType<typeof startPluginRouteReceiptFixture>>;
beforeAll(async () => { fixture = await startPluginRouteReceiptFixture(); }, 120_000);
afterAll(async () => { await fixture?.cleanup(); });

describe("standalone plugin tool execute mount (Phase 0-2 Step 1b-1)", () => {
  it("(a) pluginToolExecuteRoutes mounted alone handles POST /api/plugins/tools/execute", async () => {
    const router = pluginToolExecuteRoutes(fixture.db, { toolDispatcher: makeDispatcher() } as never);
    const res = await request(boardApp(router)).post("/api/plugins/tools/execute")
      .send({ tool: TOOL, parameters: { q: "x" }, runContext });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pluginId: "acme.linear", toolName: "search-issues", result: { content: "ok" } });
  });

  it("(b) pluginRoutes with skipToolExecuteRoute does not serve the execute route", async () => {
    const router = pluginRoutes(fixture.db, {} as never, undefined, undefined,
      { toolDispatcher: makeDispatcher() } as never, { workerManager: {} as never },
      { lifetime: createHttpHandlerLifetime(), skipToolExecuteRoute: true });
    const res = await request(boardApp(router)).post("/api/plugins/tools/execute")
      .send({ tool: TOOL, parameters: { q: "x" }, runContext });
    expect(res.status).toBe(404);
  });

  it("(c) real app registers POST /plugins/tools/execute exactly once, owned by the standalone router", async () => {
    const localPluginDir = await mkdtemp(path.join(tmpdir(), "p02-s1b1-plugins-"));
    const app = await createApp(fixture.db, {
      uiMode: "none", serverPort: 3100, storageService: {} as never,
      deploymentMode: "authenticated", deploymentExposure: "public",
      allowedHostnames: [], bindHost: "127.0.0.1", authReady: true,
      companyDeletionEnabled: false, localPluginDir, resolveSession: async () => null,
    });
    try {
      const root = (app as unknown as { router: { stack: RouteLayer[] } }).router.stack;
      const hits: Array<{ stack: RouteLayer[]; layer: RouteLayer }> = [];
      collectExecuteLayers(root, hits);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.stack.filter((layer) => layer.route)).toEqual([hits[0]!.layer]);
    } finally {
      await app.runtimeShutdown.dispose();
      await rm(localPluginDir, { recursive: true, force: true });
    }
  }, 60_000);
});
