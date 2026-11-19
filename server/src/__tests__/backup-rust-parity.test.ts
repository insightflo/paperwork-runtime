// @vitest-environment node
// Rust `paperclip-db-backup` parity matrix against the TS implementation:
// 4-way backup/restore equivalence, fail-closed error handling, snapshot
// isolation race, URL-param fallback, and a multi-thousand-row benchmark.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runDatabaseBackup, runDatabaseRestore } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const gunzipAsync = promisify(gunzip);
// The server package does not depend on `postgres` directly; reach the raw
// client through the @paperclipai/db pool (drizzle's $client passthrough).
type Sql = ReturnType<typeof createDb>["$client"];
const poolFor = (connectionString: string): Sql => createDb(connectionString).$client;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const databaseNames = ["matrix_source", "t_rust", "t_ts", "t_mixed", "t_plain", "t_options", "race_source", "race_target", "fail_source", "corrupt_target", "bench_source", "bench_target"];

let root = "";
let bin = "";
let savedBin: string | undefined;
let source: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let admin: Sql | undefined;
const urls: Record<string, string> = {};

const rustOn = () => { process.env.PAPERCLIP_DB_BACKUP_BIN = bin; };
const rustOff = () => { delete process.env.PAPERCLIP_DB_BACKUP_BIN; };

async function withDatabase<T>(connectionString: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  const db = createDb(connectionString);
  try { return await work(db.$client); } finally { await db.$client.end({ timeout: 5 }); }
}

async function dumpMatrix(sql: Sql) {
  return await sql<Record<string, unknown>[]>`
    SELECT id, label, phase::text AS phase, payload::text AS payload, price::text AS price,
      tags::text[] AS tags, ratio::text AS ratio, made_at::text AS made_at, note, secret_note
    FROM public.matrix_rows ORDER BY id`;
}

type BackupOutcome = { ok: true; backupFile: string } | { ok: false; error: unknown };

async function waitForChildCountLock(monitor: Sql, database: string, outcome: Promise<BackupOutcome>): Promise<number | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const settled = await Promise.race([outcome, Promise.resolve(null)]);
    if (settled && !settled.ok) throw settled.error;
    const rows = await monitor<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = ${database} AND state = 'active' AND wait_event_type = 'Lock'
        AND lower(query) LIKE '%count(*)%' AND lower(query) LIKE '%zz_child%'
      LIMIT 1`;
    if (rows[0]) return Number(rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "backup-rust-parity-"));
  const build = spawnSync("cargo", ["build", "--release", "--manifest-path", join(repoRoot, "crates", "db-backup", "Cargo.toml")], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(`cargo build failed: ${build.stderr}`);
  bin = [join(repoRoot, "crates", "db-backup", "target", "release", "paperclip-db-backup"), join(repoRoot, "target", "release", "paperclip-db-backup")].find(existsSync) ?? "";
  if (!bin) throw new Error("paperclip-db-backup release binary missing after cargo build");
  savedBin = process.env.PAPERCLIP_DB_BACKUP_BIN;
  source = await startEmbeddedPostgresTestDatabase("backup-rust-parity-");
  const adminUrl = new URL(source.connectionString);
  adminUrl.pathname = "/postgres";
  admin = poolFor(adminUrl.toString());
  for (const name of databaseNames) {
    const url = new URL(source.connectionString);
    url.pathname = `/${name}`;
    urls[name] = url.toString();
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  }
}, 240_000);

afterAll(async () => {
  if (savedBin === undefined) rustOff(); else process.env.PAPERCLIP_DB_BACKUP_BIN = savedBin;
  await admin?.end();
  await source?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("rust paperclip-db-backup parity", () => {
  it("keeps the 4-way rust/ts matrix identical and honors backup options", async () => {
    await withDatabase(urls.matrix_source, async (sql) => {
      for (const statement of [
        "CREATE TYPE public.matrix_phase AS ENUM ('ready', 'running')",
        "CREATE TABLE public.matrix_rows (id serial PRIMARY KEY, label text NOT NULL UNIQUE, phase public.matrix_phase NOT NULL, payload jsonb, price numeric(12,6), tags text[], ratio double precision, made_at timestamptz NOT NULL, note text, secret_note text)",
        "CREATE TABLE public.zz_matrix (id serial PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.matrix_rows(id))",
        "CREATE INDEX matrix_rows_label_idx ON public.matrix_rows (label)",
        "CREATE TABLE public.zz_secret (id integer PRIMARY KEY, secret text NOT NULL)",
        "CREATE SCHEMA drizzle",
        "CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint NOT NULL)",
        "INSERT INTO public.matrix_rows (label, phase, payload, price, tags, ratio, made_at, note, secret_note) VALUES ('$paperclip$ literal', 'ready', '{\"nested\":null,\"flag\":true}', 1234.567891, NULL, 0.5, '2026-10-28T00:00:00Z', NULL, 'keep-me'), ('json object payload', 'running', '{\"kind\":\"object\"}', -0.000001, NULL, -2.25, '2026-10-29T12:34:56.789Z', 'plain', NULL)",
        "INSERT INTO public.zz_matrix (parent_id) VALUES (1), (2)",
        "INSERT INTO public.zz_secret (id, secret) VALUES (1, 'classified')",
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('migration-1', 1)",
      ]) await sql.unsafe(statement);
    });
    // The JS implementation cannot serialize non-finite floats (unquoted
    // `NaN` identifier) or Postgres array literals (JSON `[]` syntax), so the
    // finite, array-free snapshot below is what the ts backup legs round-trip;
    // non-finite rows and text[] values are added afterwards and only the
    // rust-written archive carries them.
    const expectedFinite = await withDatabase(urls.matrix_source, dumpMatrix);
    expect(expectedFinite).toHaveLength(2);

    rustOff();
    const tsBackup = await runDatabaseBackup({ connectionString: urls.matrix_source, backupDir: join(root, "m-ts"), retentionDays: 1, filenamePrefix: "ts" });
    rustOn();
    await runDatabaseRestore({ connectionString: urls.t_mixed, backupFile: tsBackup.backupFile });
    const plainFile = join(root, "plain.sql");
    await writeFile(plainFile, await gunzipAsync(await readFile(tsBackup.backupFile)));
    await runDatabaseRestore({ connectionString: urls.t_plain, backupFile: plainFile });
    await withDatabase(urls.matrix_source, async (sql) => {
      await sql.unsafe("INSERT INTO public.matrix_rows (label, phase, payload, price, tags, ratio, made_at, note, secret_note) VALUES ('not-a-number', 'ready', '{}', 1.5, ARRAY['nan'], 'NaN'::float8, '2026-10-30T00:00:00Z', NULL, 'secret-nan'), ('null vs json null', 'running', 'null', -1.5, ARRAY['inf', 'alpha\"quote'], 'Infinity'::float8, '2026-10-30T01:00:00Z', NULL, NULL)");
    });
    const expected = await withDatabase(urls.matrix_source, dumpMatrix);
    expect(expected).toHaveLength(4);
    expect(expected[2]?.ratio).toBe("NaN");
    expect(expected[3]?.ratio).toBe("Infinity");
    expect(expected[3]?.payload).toBe("null"); // jsonb 'null' survives the rust archive (the JS path collapses it to SQL NULL)
    expect(expected[3]?.tags).toEqual(["inf", 'alpha"quote']);

    const rustBackup = await runDatabaseBackup({ connectionString: urls.matrix_source, backupDir: join(root, "m-rust"), retentionDays: 1, filenamePrefix: "rust" });
    await runDatabaseRestore({ connectionString: urls.t_rust, backupFile: rustBackup.backupFile });
    const optsBackup = await runDatabaseBackup({ connectionString: urls.matrix_source, backupDir: join(root, "m-opts"), retentionDays: 1, filenamePrefix: "opts", includeMigrationJournal: true, excludeTables: ["zz_secret"], nullifyColumns: { matrix_rows: ["secret_note"] } });
    await runDatabaseRestore({ connectionString: urls.t_options, backupFile: optsBackup.backupFile });
    rustOff();
    await runDatabaseRestore({ connectionString: urls.t_ts, backupFile: rustBackup.backupFile });

    for (const [target, expectedRows] of [[urls.t_rust, expected], [urls.t_ts, expected], [urls.t_mixed, expectedFinite], [urls.t_plain, expectedFinite]] as const) {
      expect(await withDatabase(target, dumpMatrix)).toEqual(expectedRows);
    }
    const structure = (await withDatabase(urls.t_rust, async (sql) => (await sql<{ enum_exists: boolean; fk_count: number; unique_count: number; index_exists: boolean; journal_absent: boolean; secret_rows: number; next_child_id: number }[]>`
      SELECT to_regtype('public.matrix_phase') IS NOT NULL AS enum_exists,
        (SELECT count(*)::int FROM pg_constraint WHERE contype = 'f' AND conname = 'zz_matrix_parent_id_fkey') AS fk_count,
        (SELECT count(*)::int FROM pg_constraint WHERE contype = 'u' AND conname = 'matrix_rows_label_key') AS unique_count,
        to_regclass('public.matrix_rows_label_idx') IS NOT NULL AS index_exists,
        to_regclass('drizzle.__drizzle_migrations') IS NULL AS journal_absent,
        (SELECT count(*)::int FROM public.zz_secret) AS secret_rows,
        nextval(pg_get_serial_sequence('public.zz_matrix', 'id'))::int AS next_child_id`)[0]));
    expect(structure).toMatchObject({ enum_exists: true, fk_count: 1, unique_count: 1, index_exists: true, journal_absent: true, secret_rows: 1, next_child_id: 3 });
    const options = await withDatabase(urls.t_options, async (sql) => ({
      rows: await dumpMatrix(sql),
      secretRows: await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM public.zz_secret`,
      journal: await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    }));
    expect(options.rows).toEqual(expected.map((row) => ({ ...row, secret_note: null })));
    expect(Number(options.secretRows[0]?.count)).toBe(0); // excludeTables drops zz_secret rows, not its schema
    expect(Number(options.journal[0]?.count)).toBe(1);
  }, 120_000);

  it("fails closed on terminated locked backups and corrupt archives", async () => {
    await withDatabase(urls.fail_source, async (sql) => {
      await sql.unsafe("CREATE TABLE public.aa_parent (id integer PRIMARY KEY)");
      await sql.unsafe("CREATE TABLE public.zz_child (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.aa_parent(id))");
      await sql.unsafe("INSERT INTO public.aa_parent (id) VALUES (1)");
      await sql.unsafe("INSERT INTO public.zz_child (id, parent_id) VALUES (1, 1)");
    });
    const locker = await poolFor(urls.fail_source).reserve();
    const monitor = poolFor(urls.fail_source);
    const failureDir = join(root, "fail-backup");
    let held = false;
    try {
      await locker.unsafe("BEGIN");
      await locker.unsafe("LOCK TABLE public.zz_child IN ACCESS EXCLUSIVE MODE");
      held = true;
      rustOn();
      const outcome = runDatabaseBackup({ connectionString: urls.fail_source, backupDir: failureDir, retentionDays: 1 })
        .then((result) => ({ ok: true as const, backupFile: result.backupFile }), (error) => ({ ok: false as const, error }));
      const pid = await waitForChildCountLock(monitor, "fail_source", outcome);
      expect(pid).not.toBeNull();
      const terminated = await monitor<{ terminated: boolean }[]>`SELECT pg_terminate_backend(${pid}) AS terminated`;
      expect(terminated[0]?.terminated).toBe(true);
      const failed = await outcome;
      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("expected the terminated backup to fail");
      // The helper reports its own failure (fail-closed pass-through; the JS
      // fallback never re-runs the terminated backup). backup.rs does not yet
      // format the terminated-backend SQL message like restore.rs does.
      expect(String((failed.error as Error).message)).toContain("backup failed");
      expect(existsSync(failureDir)).toBe(false);
    } finally {
      if (held) await locker.unsafe("ROLLBACK").catch(() => {});
      await locker.release();
      await monitor.end({ timeout: 5 });
    }

    const corruptFile = join(root, "corrupt.sql.gz");
    await writeFile(corruptFile, "not-a-gzip-backup");
    const restoreError = await runDatabaseRestore({ connectionString: urls.corrupt_target, backupFile: corruptFile }).then(() => null, (error: Error) => error);
    expect(restoreError).toBeInstanceOf(Error);
    const message = String(restoreError?.message);
    expect(message).toMatch(/^Failed to restore corrupt\.sql\.gz: /);
    expect(message.match(/Failed to restore/g)).toHaveLength(1);
    expect(await withDatabase(urls.corrupt_target, async (sql) => (await sql<{ empty: boolean }[]>`SELECT to_regclass('public.aa_parent') IS NULL AS empty`)[0])).toMatchObject({ empty: true });
  }, 120_000);

  it("sees one consistent snapshot under a concurrent write race", async () => {
    await withDatabase(urls.race_source, async (sql) => {
      await sql.unsafe("CREATE TABLE public.aa_parent (id integer PRIMARY KEY, label text NOT NULL)");
      await sql.unsafe("CREATE TABLE public.zz_child (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.aa_parent(id))");
      await sql.unsafe("INSERT INTO public.aa_parent (id, label) VALUES (1, 'before-1'), (2, 'before-2')");
      await sql.unsafe("INSERT INTO public.zz_child (id, parent_id) VALUES (1, 1), (2, 2)");
    });
    const locker = await poolFor(urls.race_source).reserve();
    const monitor = poolFor(urls.race_source);
    let held = false;
    try {
      await locker.unsafe("BEGIN");
      await locker.unsafe("LOCK TABLE public.zz_child IN ACCESS EXCLUSIVE MODE");
      held = true;
      rustOn();
      const outcome = runDatabaseBackup({ connectionString: urls.race_source, backupDir: join(root, "race"), retentionDays: 1 })
        .then((result) => ({ ok: true as const, backupFile: result.backupFile }), (error) => ({ ok: false as const, error }));
      const pid = await waitForChildCountLock(monitor, "race_source", outcome);
      expect(pid).not.toBeNull();
      await withDatabase(urls.race_source, (writer) => writer.unsafe("INSERT INTO public.aa_parent (id, label) VALUES (4, 'ordinary-write')"));
      await locker.unsafe("UPDATE public.aa_parent SET label = 'after-1' WHERE id = 1");
      await locker.unsafe("INSERT INTO public.aa_parent (id, label) VALUES (3, 'after-3')");
      await locker.unsafe("INSERT INTO public.zz_child (id, parent_id) VALUES (3, 3)");
      await locker.unsafe("COMMIT");
      held = false;
      const result = await outcome;
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      await runDatabaseRestore({ connectionString: urls.race_target, backupFile: result.backupFile });
    } finally {
      if (held) await locker.unsafe("ROLLBACK").catch(() => {});
      await locker.release();
      await monitor.end({ timeout: 5 });
    }
    const snapshot = await withDatabase(urls.race_target, async (sql) => ({
      parents: await sql<{ id: number; label: string }[]>`SELECT id, label FROM public.aa_parent ORDER BY id`,
      orphans: await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM public.zz_child c LEFT JOIN public.aa_parent p ON p.id = c.parent_id WHERE p.id IS NULL`,
    }));
    expect(snapshot.parents).toEqual([{ id: 1, label: "before-1" }, { id: 2, label: "before-2" }]);
    expect(Number(snapshot.orphans[0]?.count)).toBe(0);
  }, 120_000);

  it("falls back to the JS implementation for rust-unsupported URL params", async () => {
    const attempt = (connectionString: string) => runDatabaseBackup({ connectionString, backupDir: join(root, "fallback"), retentionDays: 1, filenamePrefix: "fb" })
      .then((result) => `ok:${result.sizeBytes > 0}`, (error) => `err:${String((error as Error).message).slice(0, 60)}`);
    rustOff();
    const baseline = await attempt(urls.matrix_source);
    rustOn();
    const rustBaseline = await attempt(urls.matrix_source);
    expect(baseline).toBe("ok:true");
    expect(rustBaseline).toBe(baseline);
    const schemaParam = await attempt(`${urls.matrix_source}?schema=public`);
    rustOff();
    expect(schemaParam).toBe(await attempt(`${urls.matrix_source}?schema=public`));
    rustOn();
    const hostParam = await attempt(`${urls.matrix_source}?host=/tmp`);
    rustOff();
    expect(hostParam).toBe(await attempt(`${urls.matrix_source}?host=/tmp`));
  }, 120_000);

  it("benchmarks a multi-thousand-row rust backup and restore", async () => {
    await withDatabase(urls.bench_source, async (sql) => {
      await sql.unsafe("CREATE TABLE public.bench (id serial PRIMARY KEY, payload jsonb NOT NULL)");
      await sql.unsafe("INSERT INTO public.bench (payload) SELECT jsonb_build_object('i', g, 'text', repeat('x', 64)) FROM generate_series(1, 5000) g");
    });
    rustOn();
    const rssBefore = process.memoryUsage().rss;
    const startedAt = Date.now();
    const backup = await runDatabaseBackup({ connectionString: urls.bench_source, backupDir: join(root, "bench"), retentionDays: 1, filenamePrefix: "bench" });
    const backedUpAt = Date.now();
    await runDatabaseRestore({ connectionString: urls.bench_target, backupFile: backup.backupFile });
    const restoredAt = Date.now();
    const count = await withDatabase(urls.bench_target, async (sql) => (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM public.bench`)[0]);
    const rssDeltaMb = ((process.memoryUsage().rss - rssBefore) / 1_048_576).toFixed(1);
    console.log(`[benchmark] db-backup rows=5000 backupMs=${backedUpAt - startedAt} restoreMs=${restoredAt - backedUpAt} sizeBytes=${backup.sizeBytes} rssDeltaMb=${rssDeltaMb}`);
    expect(Number(count?.count)).toBe(5000);
  }, 120_000);
});
