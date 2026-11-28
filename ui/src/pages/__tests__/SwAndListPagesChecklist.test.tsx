import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const swSource = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
const origin = "https://paperwork.test";
const unavailable = () => Promise.reject(new Error("unavailable"));

function worker() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const cache = { put: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(undefined) };
  const caches = {
    open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
  };
  const self = {
    location: { origin }, skipWaiting: vi.fn().mockResolvedValue(undefined),
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    addEventListener: (name: string, listener: (event: unknown) => void) => { handlers[name] = listener; },
  };
  const fetch = vi.fn().mockResolvedValue(new Response("fresh asset"));
  runInNewContext(swSource, { self, caches, fetch, URL, Response });
  function dispatch(path: string, method = "GET", mode = "cors") {
    const pending: Promise<unknown>[] = [];
    const event = {
      request: { url: new URL(path, origin).href, method, mode },
      respondWith: vi.fn(), waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    };
    handlers.fetch(event);
    return {
      event,
      async result() {
        const response = await event.respondWith.mock.calls[0]?.[0] as Response | undefined;
        await Promise.all(pending);
        return response;
      },
    };
  }
  async function lifecycle(name: string) {
    const pending: Promise<unknown>[] = [];
    handlers[name]({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }
  return { cache, caches, self, fetch, dispatch, lifecycle };
}

describe("service worker network and offline contracts", () => {
  it.each(["/api", "/api/", "/api/companies?limit=1", "/api/stream", "/api%2Fcompanies"])(
    "never reads or writes cache for %s, even offline", async (path) => {
      const sw = worker();
      sw.fetch.mockImplementation(unavailable);
      const call = sw.dispatch(path);
      expect(await call.result()).toBeUndefined();
      expect(call.event.respondWith).not.toHaveBeenCalled();
      expect(sw.fetch).not.toHaveBeenCalled();
      expect(sw.caches.open).not.toHaveBeenCalled();
      expect(sw.cache.put).not.toHaveBeenCalled();
      expect(sw.cache.match).not.toHaveBeenCalled();
    },
  );

  it.each([["/assets/app.js", "POST"], ["https://cdn.test/app.js", "GET"]])(
    "leaves %s %s to the browser", async (path, method) => {
      const sw = worker();
      expect(await sw.dispatch(path, method).result()).toBeUndefined();
      expect(sw.caches.open).not.toHaveBeenCalled();
      expect(sw.fetch).not.toHaveBeenCalled();
    },
  );

  it("prefers network over cached assets and persists a separate response body", async () => {
    const sw = worker();
    sw.cache.match.mockResolvedValue(new Response("stale"));
    const call = sw.dispatch("/assets/app.js");
    const response = await call.result();
    expect(await response!.text()).toBe("fresh asset");
    expect(sw.cache.match).not.toHaveBeenCalled();
    expect(sw.cache.put).toHaveBeenCalledWith(call.event.request, expect.any(Response));
    expect(await (sw.cache.put.mock.calls[0][1] as Response).text()).toBe("fresh asset");
  });

  it("serves an offline asset only from the current cache", async () => {
    const sw = worker();
    sw.fetch.mockImplementation(unavailable);
    sw.cache.match.mockResolvedValue(new Response("cached asset"));
    expect(await (await sw.dispatch("/assets/app.js").result())!.text()).toBe("cached asset");
    expect(sw.caches.open).toHaveBeenCalledWith("paperwork-v5");
  });

  it.each([["/assets/missing.js", "cors"], ["/issues", "navigate"]])(
    "returns an explicit offline response for a cache miss at %s", async (path, mode) => {
      const sw = worker();
      sw.fetch.mockImplementation(unavailable);
      const response = await sw.dispatch(path, "GET", mode).result();
      expect(response!.status).toBe(503);
      expect(await response!.text()).toBe("Offline");
    },
  );

  it.each(["open", "put"] as const)("handles cache %s failures without rejecting the response or lifetime", async (failure) => {
    const sw = worker();
    (failure === "open" ? sw.caches.open : sw.cache.put).mockImplementation(unavailable);
    expect(await (await sw.dispatch("/assets/app.js").result())!.text()).toBe("fresh asset");
  });

  it.each(["open", "match"] as const)("handles offline cache %s failures", async (failure) => {
    const sw = worker();
    sw.fetch.mockImplementation(unavailable);
    (failure === "open" ? sw.caches.open : sw.cache.match).mockImplementation(unavailable);
    expect((await sw.dispatch("/assets/app.js").result())!.status).toBe(503);
  });

  it.each(["/", "/issues", "/private-export.json", "/sw.js"])("does not persist non-build resources at %s", async (path) => {
    const sw = worker();
    await sw.dispatch(path).result();
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it.each(["html", "error", "api-redirect"])("does not cache %s responses", async (kind) => {
    const sw = worker();
    const response = new Response("body", kind === "html"
      ? { headers: { "Content-Type": "text/html" } } : { status: kind === "error" ? 500 : 200 });
    if (kind === "api-redirect") Object.defineProperties(response, {
      redirected: { value: true }, url: { value: `${origin}/api/companies` },
    });
    sw.fetch.mockResolvedValue(response);
    await sw.dispatch("/assets/app.js").result();
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it("retries an HTML asset with cache bypass and caches only the corrected asset", async () => {
    const sw = worker();
    sw.fetch.mockResolvedValueOnce(new Response("shell", { headers: { "Content-Type": "text/html" } }));
    await sw.dispatch("/assets/app.js").result();
    const [url, options] = sw.fetch.mock.calls[1];
    expect(new URL(url).searchParams.has("__pc_sw_bust")).toBe(true);
    expect(options).toEqual({ cache: "reload" });
    expect(sw.cache.put).toHaveBeenCalledOnce();
  });

  it("rejects stale cached HTML masquerading as an asset", async () => {
    const sw = worker();
    sw.fetch.mockImplementation(unavailable);
    sw.cache.match.mockResolvedValue(new Response("shell", { headers: { "Content-Type": "text/html" } }));
    expect((await sw.dispatch("/assets/app.js").result())!.status).toBe(503);
  });

  it("cleans only obsolete app caches before claiming clients", async () => {
    const sw = worker();
    sw.caches.keys.mockResolvedValue(["paperwork-v3", "paperwork-v4", "paperwork-v5", "other-app"]);
    await sw.lifecycle("activate");
    expect(sw.caches.delete.mock.calls.map(([key]) => key)).toEqual(["paperwork-v3", "paperwork-v4"]);
    expect(sw.self.clients.claim).toHaveBeenCalledOnce();
    expect(sw.self.clients.claim.mock.invocationCallOrder[0]).toBeGreaterThan(sw.caches.delete.mock.invocationCallOrder[1]);
  });

  it.each(["keys", "delete", "claim", "skipWaiting"])("settles lifecycle %s rejections", async (failure) => {
    const sw = worker();
    sw.caches.keys.mockResolvedValue(["paperwork-v4"]);
    const fn = failure === "keys" ? sw.caches.keys : failure === "delete" ? sw.caches.delete
      : failure === "claim" ? sw.self.clients.claim : sw.self.skipWaiting;
    fn.mockImplementation(unavailable);
    await sw.lifecycle(failure === "skipWaiting" ? "install" : "activate");
    if (failure !== "skipWaiting") expect(sw.self.clients.claim).toHaveBeenCalledOnce();
  });
});

// Parse real JSX rather than matching comments or whitespace. These contracts cover the
// page-owned controls; shared IssuesList controls have their own component ownership.
function pageJsx(name: string) {
  const source = ts.createSourceFile(name, readFileSync(new URL(`../${name}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return nodes;
}
type Opening = ReturnType<typeof pageJsx>[number];
function attr(node: Opening, name: string) {
  const value = node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText() === name);
  return value && ts.isJsxAttribute(value) ? value.initializer?.getText() : undefined;
}
const tag = (node: Opening) => node.tagName.getText();

describe("list page accessibility contracts", () => {
  it.each(["Issues.tsx", "Activity.tsx"])("keeps %s page buttons named, typed and toggle-aware", (name) => {
    const buttons = pageJsx(name).filter((node) => tag(node) === "button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(attr(button, "type")).toBe('"button"');
      expect(attr(button, "aria-pressed")).toBe("{active}");
      const contents = button.parent.getText();
      expect(attr(button, "aria-label") || /\{(?:group|pill)\.label\}/.test(contents)).toBeTruthy();
    }
  });

  it.each(["Issues.tsx", "Activity.tsx"])("names all %s page-owned filter controls", (name) => {
    const nodes = pageJsx(name);
    for (const control of nodes.filter((node) => ["input", "Input", "select"].includes(tag(node)))) {
      expect(attr(control, "aria-label") || attr(control, "aria-labelledby") || nodes.some((label) =>
        tag(label) === "label" && attr(label, "htmlFor") === attr(control, "id") && attr(control, "id"))).toBeTruthy();
    }
    if (name === "Activity.tsx") expect(nodes.some((node) => attr(node, "aria-label") === '"활동 검색"')).toBe(true);
  });

  it("announces Activity errors and filtered result counts", () => {
    const nodes = pageJsx("Activity.tsx");
    const error = nodes.find((node) => tag(node) === "p" && node.parent.getText().includes("error.message"))!;
    expect(attr(error, "role")).toBe('"alert"');
    expect(attr(error, "aria-live")).toBe('"polite"');
    const count = nodes.find((node) => attr(node, "aria-atomic") === '"true"')!;
    expect(attr(count, "aria-live")).toBe('"polite"');
    expect(attr(count, "role")).toBeUndefined(); // Preserve pagination's existing status contract.
    expect(count.parent.getText()).toContain("filtered.length");
  });

  it("announces Issues loading/results/errors through the existing list container", () => {
    const nodes = pageJsx("Issues.tsx");
    const container = nodes.find((node) => attr(node, "ref") === "{listRef}")!;
    expect(attr(container, "aria-live")).toBe('"polite"');
    expect(attr(container, "aria-busy")).toBe("{listBusy}");
    expect(attr(container, "role")).toBe('{error ? "alert" : undefined}');
    expect(container.parent.getText()).toContain("error={error as Error | null}");
    const readonly = nodes.find((node) => attr(node, "role") === '"status"')!;
    expect(attr(readonly, "aria-live")).toBe('"polite"');
  });
});
