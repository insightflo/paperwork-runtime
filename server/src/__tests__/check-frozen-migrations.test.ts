import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFrozenMigrations } from "../../../scripts/check-frozen-migrations.mjs";

const MIGRATIONS_DIR = "packages/db/src/migrations";
const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

const dirs: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeRepoFile(cwd: string, rel: string, content: string) {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function journal(entries: Array<Record<string, unknown>>) {
  return `${JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2)}\n`;
}

function entry(idx: number, when: number, tag: string) {
  return { idx, version: "7", when, tag, breakpoints: true };
}

function baseJournal() {
  return journal([entry(0, 1000, "0000_init"), entry(1, 2000, "0001_second")]);
}

/**
 * Creates a temp git repo whose HEAD ("main") contains two frozen migrations.
 * Tests then mutate the working tree; the checker compares worktree files
 * against the committed base ref.
 */
function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "frozen-migrations-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeRepoFile(dir, `${MIGRATIONS_DIR}/0000_init.sql`, "create table a (id int);\n");
  writeRepoFile(dir, `${MIGRATIONS_DIR}/0001_second.sql`, "create table b (id int);\n");
  writeRepoFile(dir, JOURNAL_PATH, baseJournal());
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

function check(cwd: string) {
  return checkFrozenMigrations({ cwd, baseRef: "HEAD" });
}

function addMigration(cwd: string, tag: string, idx: number, when: number) {
  writeRepoFile(cwd, `${MIGRATIONS_DIR}/${tag}.sql`, `-- ${tag}\n`);
  const journalPath = join(cwd, JOURNAL_PATH);
  const parsed = JSON.parse(readFileSync(journalPath, "utf8"));
  parsed.entries.push(entry(idx, when, tag));
  writeFileSync(journalPath, journal(parsed.entries));
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("checkFrozenMigrations", () => {
  it("passes on a valid additive migration", () => {
    const dir = setupRepo();
    addMigration(dir, "0002_third", 2, 3000);
    const { ok, errors } = check(dir);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects a modified existing SQL file", () => {
    const dir = setupRepo();
    writeRepoFile(dir, `${MIGRATIONS_DIR}/0000_init.sql`, "create table a (id int, extra text);\n");
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("modified existing migration file: 0000_init.sql"))).toBe(true);
  });

  it("rejects a deleted existing SQL file", () => {
    const dir = setupRepo();
    rmSync(join(dir, MIGRATIONS_DIR, "0001_second.sql"));
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("deleted existing migration file: 0001_second.sql"))).toBe(true);
  });

  it("rejects a mutated existing journal entry", () => {
    const dir = setupRepo();
    writeRepoFile(
      dir,
      JOURNAL_PATH,
      journal([entry(0, 1000, "0000_init"), entry(1, 9999, "0001_second")]),
    );
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("mutated journal entry: 0001_second"))).toBe(true);
  });

  it("rejects a removed existing journal entry", () => {
    const dir = setupRepo();
    writeRepoFile(dir, JOURNAL_PATH, journal([entry(0, 1000, "0000_init")]));
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("removed journal entry: 0001_second"))).toBe(true);
  });

  it("rejects an orphan SQL file without a journal tag", () => {
    const dir = setupRepo();
    writeRepoFile(dir, `${MIGRATIONS_DIR}/0002_orphan.sql`, "-- orphan\n");
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("orphan migration file(s) 0002_orphan.sql"))).toBe(true);
  });

  it("rejects a journal-only entry without a SQL file", () => {
    const dir = setupRepo();
    writeRepoFile(dir, JOURNAL_PATH, journal([
      entry(0, 1000, "0000_init"),
      entry(1, 2000, "0001_second"),
      entry(2, 3000, "0002_ghost"),
    ]));
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes('orphan journal tag "0002_ghost"'))).toBe(true);
  });

  it("rejects duplicate journal tags sharing one SQL file", () => {
    const dir = setupRepo();
    writeRepoFile(dir, `${MIGRATIONS_DIR}/0002_dup.sql`, "-- dup\n");
    writeRepoFile(dir, JOURNAL_PATH, journal([
      entry(0, 1000, "0000_init"),
      entry(1, 2000, "0001_second"),
      entry(2, 3000, "0002_dup"),
      entry(3, 4000, "0002_dup"),
    ]));
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes('duplicate journal tag "0002_dup"'))).toBe(true);
  });

  it("rejects non-monotonic idx on a new entry", () => {
    const dir = setupRepo();
    writeRepoFile(dir, JOURNAL_PATH, journal([
      entry(0, 1000, "0000_init"),
      entry(1, 2000, "0001_second"),
      entry(5, 3000, "0002_third"),
    ]));
    writeRepoFile(dir, `${MIGRATIONS_DIR}/0002_third.sql`, "-- third\n");
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("non-monotonic idx"))).toBe(true);
  });

  it("rejects non-monotonic when on a new entry", () => {
    const dir = setupRepo();
    writeRepoFile(dir, JOURNAL_PATH, journal([
      entry(0, 1000, "0000_init"),
      entry(1, 2000, "0001_second"),
      entry(2, 1500, "0002_third"),
    ]));
    writeRepoFile(dir, `${MIGRATIONS_DIR}/0002_third.sql`, "-- third\n");
    const { ok, errors } = check(dir);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("non-monotonic when"))).toBe(true);
  });
});
