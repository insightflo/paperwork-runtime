import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { errorHandler } from "../middleware/index.js";
import { pluginToolExecuteRoutes } from "../routes/plugin-tool-execute.js";
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
  match?: (path: string) => boolean;
};

/** Recursively finds every route layer serving POST `routePath`, tagged with its owning router stack. */
const collectPostLayers = (stack: RouteLayer[], routePath: string, hits: Array<{ stack: RouteLayer[]; layer: RouteLayer }>) => {
  for (const layer of stack) {
    if (layer.route?.path === routePath && layer.route.methods.post) hits.push({ stack, layer });
    const nested = layer.handle?.stack;
    if (Array.isArray(nested)) collectPostLayers(nested, routePath, hits);
  }
};

/** Recursively collects every route layer (any method/path) in a router stack. */
const collectRouteLayers = (stack: RouteLayer[], hits: RouteLayer[]) => {
  for (const layer of stack) {
    if (layer.route) hits.push(layer);
    const nested = layer.handle?.stack;
    if (Array.isArray(nested)) collectRouteLayers(nested, hits);
  }
};

/** True when the layer is a mounted sub-router whose stack recursively serves POST `routePath`. */
const ownsPostRoute = (layer: RouteLayer, routePath: string) => {
  const stack = layer.handle?.stack;
  if (!Array.isArray(stack)) return false;
  const owned: Array<{ stack: RouteLayer[]; layer: RouteLayer }> = [];
  collectPostLayers(stack, routePath, owned);
  return owned.length > 0;
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

  it("(b) real app keeps the standalone execute router mounted while legacy plugin install is absent", async () => {
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
      collectPostLayers(root, "/plugins/tools/execute", hits);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.stack.filter((layer) => layer.route)).toEqual([hits[0]!.layer]);
      const apiLayer = root.find((layer) => Array.isArray(layer.handle?.stack)
        && layer.match?.("/api") === true && layer.match?.("/zzz-nomatch") === false);
      expect(apiLayer).toBeDefined();
      const apiStack = apiLayer!.handle!.stack!;
      const standaloneIdx = apiStack.findIndex((layer) => ownsPostRoute(layer, "/plugins/tools/execute"));
      const pluginRoutesIdx = apiStack.findIndex((layer) => ownsPostRoute(layer, "/plugins/install"));
      expect(standaloneIdx).toBeGreaterThanOrEqual(0);
      expect(pluginRoutesIdx).toBe(-1);
      expect(hits[0]!.stack).toBe(apiStack[standaloneIdx]!.handle!.stack!);
      const standaloneRoutes: RouteLayer[] = [];
      collectRouteLayers(apiStack[standaloneIdx]!.handle!.stack!, standaloneRoutes);
      expect(standaloneRoutes).toEqual([hits[0]!.layer]);
      const installHits: Array<{ stack: RouteLayer[]; layer: RouteLayer }> = [];
      collectPostLayers(root, "/plugins/install", installHits);
      expect(installHits).toHaveLength(0);
    } finally {
      await app.runtimeShutdown.dispose();
      await rm(localPluginDir, { recursive: true, force: true });
    }
  }, 60_000);
});
