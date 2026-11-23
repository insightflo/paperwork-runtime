#!/usr/bin/env node
/**
 * check-frozen-migrations.mjs
 *
 * Frozen-migration guardrail. Once a migration has landed on the base ref it
 * is immutable: editing or deleting an existing *.sql file, mutating or
 * removing an existing _journal.json entry, breaking idx/when monotonicity,
 * duplicating journal tags, or adding a migration file/tag without its
 * 1-to-1 counterpart is rejected.
 *
 * Usage:
 *   node scripts/check-frozen-migrations.mjs [--base <ref>]
 *
 * Library:
 *   import { checkFrozenMigrations } from "./check-frozen-migrations.mjs";
 *   const { ok, errors } = checkFrozenMigrations({ cwd, baseRef });
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS_DIR = "packages/db/src/migrations";
const JOURNAL_REL = `${MIGRATIONS_DIR}/meta/_journal.json`;
const BASE_SQL_RE = /^packages\/db\/src\/migrations\/[^/]+\.sql$/;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitShowOrNull(cwd, baseRef, path) {
  try {
    return execFileSync("git", ["show", `${baseRef}:${path}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function listBaseSqlFiles(cwd, baseRef) {
  const out = git(cwd, ["ls-tree", "-r", "--name-only", baseRef, "--", MIGRATIONS_DIR]);
  return out
    .split("\n")
    .filter((p) => BASE_SQL_RE.test(p))
    .map((p) => p.split("/").pop());
}

function parseJournal(raw, label, errors) {
  if (raw == null) {
    errors.push(`${label} _journal.json not found`);
    return null;
  }
  try {
    const entries = JSON.parse(raw)?.entries;
    if (!Array.isArray(entries)) {
      errors.push(`${label} _journal.json has no entries array`);
      return null;
    }
    return entries;
  } catch {
    errors.push(`${label} _journal.json is not valid JSON`);
    return null;
  }
}

function canonicalEntry(entry) {
  return JSON.stringify(
    Object.keys(entry)
      .sort()
      .map((k) => [k, entry[k]]),
  );
}

export function checkFrozenMigrations({ cwd = process.cwd(), baseRef = "origin/main" } = {}) {
  const errors = [];
  const migrationsAbs = join(cwd, MIGRATIONS_DIR);

  let curSqlFiles;
  try {
    curSqlFiles = readdirSync(migrationsAbs)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return { ok: false, errors: [`migrations directory not found: ${MIGRATIONS_DIR}`] };
  }
  const curSql = new Set(curSqlFiles);

  let baseSqlFiles;
  try {
    baseSqlFiles = listBaseSqlFiles(cwd, baseRef);
  } catch (err) {
    return {
      ok: false,
      errors: [`unable to list migrations at ${baseRef}: ${err?.message ?? err}`],
    };
  }
  const baseSql = new Set(baseSqlFiles);

  for (const file of baseSql) {
    if (!curSql.has(file)) {
      errors.push(`deleted existing migration file: ${file}`);
      continue;
    }
    const baseContent = gitShowOrNull(cwd, baseRef, `${MIGRATIONS_DIR}/${file}`);
    const curContent = readFileSync(join(migrationsAbs, file), "utf8");
    if (baseContent !== curContent) {
      errors.push(`modified existing migration file: ${file}`);
    }
  }

  const curJournalRaw = (() => {
    try {
      return readFileSync(join(cwd, JOURNAL_REL), "utf8");
    } catch {
      return null;
    }
  })();
  const baseJournalRaw = gitShowOrNull(cwd, baseRef, JOURNAL_REL);
  const curEntries = parseJournal(curJournalRaw, "current", errors);
  const baseEntries = parseJournal(baseJournalRaw, `base ${baseRef}`, errors);

  if (curEntries && baseEntries) {
    const baseTags = new Set(baseEntries.map((e) => e?.tag));
    const curByTag = new Map();
    for (const e of curEntries) {
      const tag = e?.tag;
      if (typeof tag === "string" && !curByTag.has(tag)) curByTag.set(tag, e);
    }

    for (const be of baseEntries) {
      const ce = curByTag.get(be?.tag);
      if (!ce) {
        errors.push(`removed journal entry: ${be?.tag ?? "(missing tag)"}`);
      } else if (canonicalEntry(ce) !== canonicalEntry(be)) {
        errors.push(`mutated journal entry: ${be.tag}`);
      }
    }

    const tagCounts = new Map();
    for (const e of curEntries) {
      const tag = e?.tag;
      if (typeof tag === "string") tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    for (const [tag, n] of tagCounts) {
      if (n > 1) errors.push(`duplicate journal tag "${tag}" appears ${n} times`);
    }

    // Monotonic idx/when is enforced only for NEW journal entries: historical
    // journals may contain gaps or out-of-order `when` values that are already
    // frozen, so base entries update the running prev but are never flagged.
    let prevIdx = -1;
    let prevWhen = -Infinity;
    curEntries.forEach((e, i) => {
      const tag = typeof e?.tag === "string" ? e.tag : `entry[${i}]`;
      const isNew = typeof e?.tag === "string" && !baseTags.has(e.tag);
      if (
        isNew &&
        (!Number.isInteger(e?.idx) || e.idx !== prevIdx + 1)
      ) {
        errors.push(
          `journal entry ${i} (${tag}) has non-monotonic idx ${e?.idx}; expected ${prevIdx + 1}`,
        );
      }
      if (
        isNew &&
        (typeof e?.when !== "number" || !Number.isFinite(e.when) || e.when <= prevWhen)
      ) {
        errors.push(`journal entry ${i} (${tag}) has non-monotonic when ${e?.when}`);
      }
      if (Number.isInteger(e?.idx)) prevIdx = e.idx;
      if (typeof e?.when === "number" && Number.isFinite(e.when)) prevWhen = e.when;
    });

    const newTagCounts = new Map();
    for (const e of curEntries) {
      const tag = e?.tag;
      if (typeof tag === "string" && !baseTags.has(tag)) {
        newTagCounts.set(tag, (newTagCounts.get(tag) ?? 0) + 1);
      }
    }
    const newSqlCounts = new Map();
    for (const file of curSqlFiles) {
      if (!baseSql.has(file)) {
        const tag = file.slice(0, -".sql".length);
        newSqlCounts.set(tag, (newSqlCounts.get(tag) ?? 0) + 1);
      }
    }
    for (const [tag, n] of newSqlCounts) {
      const m = newTagCounts.get(tag) ?? 0;
      if (m !== n) {
        errors.push(
          `orphan migration file(s) ${tag}.sql: ${n} file(s) but ${m} new journal entr${m === 1 ? "y" : "ies"}`,
        );
      }
    }
    for (const [tag, m] of newTagCounts) {
      const n = newSqlCounts.get(tag) ?? 0;
      if (n !== m) {
        errors.push(
          `orphan journal tag "${tag}": ${m} new entr${m === 1 ? "y" : "ies"} but ${n} migration file(s)`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function parseArgs(argv) {
  let baseRef = "origin/main";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") baseRef = argv[++i] ?? baseRef;
    else if (argv[i].startsWith("--base=")) baseRef = argv[i].slice("--base=".length);
  }
  return { baseRef };
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const { baseRef } = parseArgs(process.argv.slice(2));
  const { ok, errors } = checkFrozenMigrations({ cwd: process.cwd(), baseRef });
  if (ok) {
    console.log(`check-frozen-migrations: OK (base ${baseRef})`);
  } else {
    for (const e of errors) console.error(`check-frozen-migrations: ${e}`);
    process.exit(1);
  }
}
