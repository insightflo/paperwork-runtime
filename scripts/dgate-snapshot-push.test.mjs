import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  buildPushUrl,
  buildSnapshotUrl,
  parseConfig,
  pushOnce,
  runLoop,
  UsageError,
} from "./dgate-snapshot-push.mjs";

const TOKEN = "unit-test-token-never-log";
const COMPANY_ID = "company one";
const SCRIPT = path.join(import.meta.dirname, "dgate-snapshot-push.mjs");

function startStub(responder) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const request = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization ?? null,
        contentType: req.headers["content-type"] ?? null,
        body: bodyText ? JSON.parse(bodyText) : null,
      };
      seen.push(request);
      const out = responder(request) ?? { status: 404, body: { error: "not found" } };
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  return {
    seen,
    ready: () => listening,
    get url() { return `http://127.0.0.1:${server.address().port}`; },
    async close() {
      const closed = once(server, "close");
      server.closeAllConnections();
      server.close();
      await closed;
    },
  };
}

async function unusedPort() {
  const server = http.createServer();
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const port = server.address().port;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

async function runCli(args, env = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

function snapshotResponder(snapshot, fetchedAt) {
  return (request) => {
    if (request.method === "GET" && request.url === "/api/snapshot") {
      return { status: 200, body: snapshot };
    }
    if (request.method === "POST" && request.url === "/api/companies/company%20one/dashboard/dgate/snapshot") {
      return { status: 200, body: { ok: true, fetchedAt } };
    }
    return null;
  };
}

test("URL helpers normalize trailing slashes, /api bases, and company id encoding", () => {
  assert.equal(
    buildSnapshotUrl("http://127.0.0.1:4747/"),
    "http://127.0.0.1:4747/api/snapshot",
  );
  assert.equal(
    buildSnapshotUrl("http://127.0.0.1:4747/api/"),
    "http://127.0.0.1:4747/api/snapshot",
  );
  assert.equal(
    buildSnapshotUrl("http://127.0.0.1:4747/api/snapshot/"),
    "http://127.0.0.1:4747/api/snapshot",
  );
  assert.equal(
    buildPushUrl("https://paperwork.example/", COMPANY_ID),
    "https://paperwork.example/api/companies/company%20one/dashboard/dgate/snapshot",
  );
  assert.equal(
    buildPushUrl("https://paperwork.example/api/", "abc"),
    "https://paperwork.example/api/companies/abc/dashboard/dgate/snapshot",
  );
});

test("parseConfig reads env fallbacks", () => {
  const config = parseConfig([], {
    DGATE_WEB_URL: "http://dgate.example/",
    PAPERWORK_URL: "https://paperwork.example/api/",
    PAPERWORK_COMPANY_ID: "company-1",
    PAPERWORK_API_TOKEN: TOKEN,
  });
  assert.equal(config.dgateUrl, "http://dgate.example/");
  assert.equal(config.paperworkUrl, "https://paperwork.example/api/");
  assert.equal(config.companyId, "company-1");
  assert.equal(config.intervalMs, 5000);
  assert.equal(config.once, false);
});

test("invalid bearer tokens are rejected without echoing the token", async () => {
  const badToken = `${TOKEN}\nembedded`;
  await assert.rejects(
    pushOnce({
      dgateUrl: "http://127.0.0.1:9",
      paperworkUrl: "http://127.0.0.1:9",
      companyId: "company-1",
      token: badToken,
      fetchImpl: async () => { throw new Error("fetch should not be called"); },
    }),
    (error) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /printable ASCII/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );

  const run = await runCli([
    "--once",
    "--dgate-url", "http://127.0.0.1:9",
    "--paperwork-url", "http://127.0.0.1:9",
    "--company-id", "company-1",
    "--token", badToken,
  ]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /printable ASCII/);
  assert.equal(run.stderr.includes(TOKEN), false);
  assert.equal(run.stdout.includes(TOKEN), false);
});

test("pushOnce forwards the snapshot and bearer token without exposing the token in its result", async (t) => {
  const snapshot = { workers: 3, nested: { active: true } };
  const fetchedAt = "2026-11-26T00:00:00.000Z";
  const stub = startStub(snapshotResponder(snapshot, fetchedAt));
  await stub.ready();
  t.after(() => stub.close());

  const result = await pushOnce({
    dgateUrl: `${stub.url}/`,
    paperworkUrl: `${stub.url}/api/`,
    companyId: COMPANY_ID,
    token: TOKEN,
  });

  assert.equal(result.status, 200);
  assert.equal(result.fetchedAt, fetchedAt);
  assert.equal(result.snapshotUrl, `${stub.url}/api/snapshot`);
  assert.equal(result.pushUrl, `${stub.url}/api/companies/company%20one/dashboard/dgate/snapshot`);
  assert.equal(stub.seen.length, 2);
  assert.equal(stub.seen[0].method, "GET");
  assert.equal(stub.seen[0].auth, null);
  assert.equal(stub.seen[1].method, "POST");
  assert.equal(stub.seen[1].auth, `Bearer ${TOKEN}`);
  assert.match(stub.seen[1].contentType, /application\/json/);
  assert.deepEqual(stub.seen[1].body, snapshot);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("CLI --once succeeds, forwards auth, and never prints the token", async (t) => {
  const snapshot = { workers: 1, open_forks: 0 };
  const stub = startStub(snapshotResponder(snapshot, "2026-11-26T00:00:01.000Z"));
  await stub.ready();
  t.after(() => stub.close());

  const run = await runCli([
    "--once",
    "--dgate-url", stub.url,
    "--paperwork-url", stub.url,
    "--company-id", COMPANY_ID,
    "--token", TOKEN,
  ]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /pushed snapshot/);
  assert.equal(stub.seen.length, 2);
  assert.equal(stub.seen[1].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(stub.seen[1].body, snapshot);
  assert.equal(run.stdout.includes(TOKEN), false);
  assert.equal(run.stderr.includes(TOKEN), false);
});

test("CLI --once reports offline dg serve cleanly without a stack trace or token leak", async () => {
  const port = await unusedPort();
  const run = await runCli([
    "--once",
    "--dgate-url", `http://127.0.0.1:${port}`,
    "--paperwork-url", "http://127.0.0.1:9",
    "--company-id", "company-1",
    "--token", TOKEN,
  ]);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /push failed:/);
  assert.match(run.stderr, /fetch failed|ECONNREFUSED|timed out/i);
  assert.equal(run.stderr.includes(TOKEN), false);
  assert.equal(run.stdout.includes(TOKEN), false);
  assert.equal(/\n\s+at\s/.test(run.stderr), false);
});

test("runLoop backs off after transient failures and continues without crashing", async (t) => {
  const snapshot = { workers: 2 };
  let snapshotReady = false;
  const stub = startStub((request) => {
    if (request.method === "GET" && request.url === "/api/snapshot") {
      return snapshotReady
        ? { status: 200, body: snapshot }
        : { status: 503, body: { error: "dg serve is starting" } };
    }
    if (request.method === "POST" && request.url === "/api/companies/company%20one/dashboard/dgate/snapshot") {
      return { status: 200, body: { ok: true, fetchedAt: "2026-11-26T00:00:02.000Z" } };
    }
    return null;
  });
  await stub.ready();
  t.after(() => stub.close());

  const controller = new AbortController();
  const delays = [];
  const errors = [];
  const sleepImpl = (ms) => {
    delays.push(ms);
    if (delays.length === 2) snapshotReady = true;
    if (delays.length === 3) controller.abort();
    return Promise.resolve();
  };

  const status = await runLoop({
    dgateUrl: stub.url,
    paperworkUrl: stub.url,
    companyId: COMPANY_ID,
    token: TOKEN,
    intervalMs: 100,
  }, {
    signal: controller.signal,
    sleepImpl,
    log: () => {},
    error: (message) => errors.push(message),
  });

  assert.equal(status, 0);
  assert.deepEqual(delays, [100, 200, 100]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /HTTP 503/);
  assert.equal(stub.seen.filter((request) => request.method === "GET").length, 3);
  assert.equal(stub.seen.filter((request) => request.method === "POST").length, 1);
  assert.equal(errors.join("\n").includes(TOKEN), false);
});
