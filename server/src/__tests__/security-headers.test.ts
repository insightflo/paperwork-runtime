import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { securityHeadersMiddleware } from "../middleware/security-headers.js";

const headers = [
  ["X-Content-Type-Options", "nosniff", "route-defined"],
  ["Referrer-Policy", "strict-origin-when-cross-origin", "no-referrer"],
  ["X-Frame-Options", "SAMEORIGIN", "DENY"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()", "camera=(self)"],
] as const;

const responses: { label: string; path: string; send: RequestHandler }[] = [
  {
    label: "HTML",
    path: "/",
    send: (_req, res) => { res.type("html").send("<!doctype html><title>Board</title>"); },
  },
  {
    label: "API",
    path: "/api/example",
    send: (_req, res) => { res.json({ ok: true }); },
  },
];

function expectDefaults(response: request.Response, overriddenHeader?: string) {
  for (const [name, value] of headers) {
    if (name !== overriddenHeader) {
      expect(response.headers[name.toLowerCase()]).toBe(value);
    }
  }
}

describe("securityHeadersMiddleware", () => {
  describe.each(responses)("$label responses", ({ label, path, send }) => {
    it("sets all four defaults and preserves the response payload", async () => {
      const app = express();
      app.use(securityHeadersMiddleware());
      app.get(path, send);

      const response = await request(app).get(path).expect(200);

      expectDefaults(response);
      expect(response.headers["cross-origin-opener-policy"]).toBeUndefined();
      if (label === "HTML") {
        expect(response.headers["content-type"]).toMatch(/^text\/html/);
        expect(response.text).toBe("<!doctype html><title>Board</title>");
      } else {
        expect(response.headers["content-type"]).toMatch(/^application\/json/);
        expect(response.body).toEqual({ ok: true });
      }
    });

    describe.each(["before", "after"] as const)("overrides set %s middleware", (order) => {
      it.each(headers)("preserves an explicit %s override", async (name, _default, override) => {
        const app = express();
        const setOverride: RequestHandler = (_req, res, next) => {
          // Header names are case-insensitive, including pre-existing headers.
          res.setHeader(name.toLowerCase(), override);
          next();
        };
        const middleware = securityHeadersMiddleware();
        app.get(path, ...(order === "before" ? [setOverride, middleware] : [middleware, setOverride]), send);

        const response = await request(app).get(path).expect(200);

        expect(response.headers[name.toLowerCase()]).toBe(override);
        expectDefaults(response, name);
      });
    });
  });

  it("preserves explicitly empty headers instead of treating them as absent", async () => {
    const app = express();
    app.use((_req, res, next) => {
      for (const [name] of headers) res.setHeader(name, "");
      next();
    });
    app.use(securityHeadersMiddleware());
    app.get("/", responses[0]!.send);

    const response = await request(app).get("/").expect(200);

    for (const [name] of headers) expect(response.headers[name.toLowerCase()]).toBe("");
  });

  it("can be mounted twice without duplicating header values", async () => {
    const app = express();
    app.use(securityHeadersMiddleware(), securityHeadersMiddleware());
    app.get("/api/example", responses[1]!.send);

    expectDefaults(await request(app).get("/api/example").expect(200));
  });

  it("sets defaults on HEAD responses without adding a body", async () => {
    const app = express();
    app.use(securityHeadersMiddleware());
    app.get("/", responses[0]!.send);

    const response = await request(app).head("/").expect(200);

    expectDefaults(response);
    expect(response.text).toBeUndefined();
  });

  it.each([404, 500])("sets defaults on %s responses", async (status) => {
    const app = express();
    app.use(securityHeadersMiddleware());
    app.get("/api/example", (_req, res) => { res.status(status).json({ error: "example" }); });

    const response = await request(app).get("/api/example").expect(status);

    expectDefaults(response);
    expect(response.body).toEqual({ error: "example" });
  });

  it("preserves redirect destinations and explicitly configured opener policy", async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
      next();
    });
    app.use(securityHeadersMiddleware());
    app.get("/login", (_req, res) => { res.redirect("https://identity.example/authorize"); });

    const response = await request(app).get("/login").expect(302);

    expectDefaults(response);
    expect(response.headers.location).toBe("https://identity.example/authorize");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  });
});
