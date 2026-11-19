// Streaming PostgreSQL backup writer matching packages/db/src/backup-lib.ts contracts:
// section order, breakpoint framing, count-before-exclude data loop, dollar-quoted
// literals, rollback of the .partial file plus newly created dirs.
use std::{collections::{HashMap, HashSet}, fs::{self, File}, io::{self, BufWriter, Write}, path::{Path, PathBuf}, str::FromStr, time::Duration};
use chrono::{SecondsFormat, Utc};
use flate2::{write::GzEncoder, Compression};
use postgres::{Config, IsolationLevel, NoTls, Transaction};

pub(crate) const STATEMENT_BREAKPOINT: &str = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

pub(crate) struct BackupParams<'a> {
    pub(crate) connection_string: &'a str, pub(crate) backup_file: &'a str,
    pub(crate) connect_timeout_seconds: i64, pub(crate) include_migration_journal: bool,
    pub(crate) exclude_tables: &'a HashSet<String>, pub(crate) nullify_columns: &'a HashMap<String, HashSet<String>>,
}

pub(crate) fn strip_nul(s: &str) -> String { s.replace('\u{0000}', "") }

// Deterministic collision-free dollar quoting: $paperclip$...$paperclip$ unless the
// payload already contains that tag, then $paperclip_1$, $paperclip_2$, ...
pub(crate) fn dollar_quote(value: &str) -> String {
    let mut n: usize = 0;
    loop {
        let tag = if n == 0 { "$paperclip$".to_owned() } else { format!("$paperclip_{n}$") };
        if !value.contains(&tag) { return format!("{tag}{value}{tag}"); }
        n += 1;
    }
}

fn q(v: &str) -> String { format!("\"{}\"", v.replace('"', "\"\"")) }

fn qq(schema: &str, name: &str) -> String { format!("{}.{}", q(schema), q(name)) }

// Non-boolean columns arrive as Option<String> via ::text projection. Integers and
// finite floats restore unquoted; NaN/Infinity and all other types are dollar-quoted.
fn format_value(data_type: &str, v: Option<String>) -> String {
    let Some(s) = v else { return "NULL".to_owned() };
    match data_type {
        "smallint" | "integer" | "bigint" if s.parse::<i64>().is_ok() => s,
        "real" | "double precision" => match s.parse::<f64>() { Ok(f) if f.is_finite() => s, _ => dollar_quote(&strip_nul(&s)) },
        _ => dollar_quote(&strip_nul(&s)),
    }
}

// Removes the .partial file and any ancestor directories this run created (empty
// only), in reverse order — the failure dir disappears when a backup fails.
pub(crate) struct DirGuard { partial: PathBuf, created: Vec<PathBuf>, armed: bool }

impl DirGuard {
    pub(crate) fn new(partial: PathBuf, created: Vec<PathBuf>) -> Self { Self { partial, created, armed: true } }
    pub(crate) fn disarm(&mut self) { self.armed = false; }
    fn cleanup(&mut self) {
        if !self.armed { return; }
        self.armed = false;
        let _ = fs::remove_file(&self.partial);
        for dir in self.created.iter().rev() { let _ = fs::remove_dir(dir); }
    }
}

impl Drop for DirGuard {
    fn drop(&mut self) { self.cleanup(); }
}

// Creates missing ancestor directories of `file`, recording each new dir in order.
pub(crate) fn ensure_parent_dirs(file: &Path, created: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut missing: Vec<PathBuf> = Vec::new();
    let mut cur = file.parent();
    while let Some(dir) = cur {
        if dir.as_os_str().is_empty() || dir.is_dir() { break; }
        missing.push(dir.to_path_buf());
        cur = dir.parent();
    }
    for dir in missing.iter().rev() {
        match fs::create_dir(dir) { Ok(()) => created.push(dir.clone()), Err(e) if e.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => {}, Err(e) => return Err(e) }
    }
    Ok(())
}

struct Out { w: GzEncoder<BufWriter<File>> }

impl Out {
    fn emit(&mut self, line: &str) -> io::Result<()> { writeln!(self.w, "{line}") }
    fn stmt(&mut self, s: &str) -> io::Result<()> { writeln!(self.w, "{s}\n{STATEMENT_BREAKPOINT}") }
    fn finish(self) -> io::Result<BufWriter<File>> { self.w.finish() }
}

pub(crate) fn run(p: &BackupParams) -> Result<(String, u64), String> {
    let mut config = Config::from_str(p.connection_string).map_err(|e| format!("invalid connection string: {e}"))?;
    config.connect_timeout(Duration::from_secs(p.connect_timeout_seconds.max(1) as u64));
    let mut client = config.connect(NoTls).map_err(|e| format!("connect failed: {e}"))?;
    let mut tx = client.build_transaction().isolation_level(IsolationLevel::RepeatableRead).read_only(true).start().map_err(|e| format!("start transaction failed: {e}"))?;
    let partial = PathBuf::from(format!("{}.{}.{}.partial", p.backup_file, std::process::id(), Utc::now().timestamp_millis()));
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    ensure_parent_dirs(&partial, &mut created_dirs).map_err(|e| format!("create backup dir failed: {e}"))?;
    let mut guard = DirGuard::new(partial.clone(), created_dirs);
    let file = File::create(&partial).map_err(|e| format!("create backup file failed: {e}"))?;
    let mut out = Out { w: GzEncoder::new(BufWriter::with_capacity(64 * 1024, file), Compression::default()) };
    write_dump(&mut tx, &mut out, p).map_err(|e| format!("backup failed: {e}"))?;
    let writer = out.finish().map_err(|e| format!("gzip finish failed: {e}"))?;
    let file = writer.into_inner().map_err(|e| format!("flush backup file failed: {e}"))?;
    file.sync_all().map_err(|e| format!("sync backup file failed: {e}"))?;
    let size = file.metadata().map_err(|e| format!("stat backup file failed: {e}"))?.len();
    fs::rename(&partial, p.backup_file).map_err(|e| format!("finalize backup file failed: {e}"))?;
    guard.disarm();
    let _ = tx.rollback();
    Ok((p.backup_file.to_owned(), size))
}

fn write_dump(tx: &mut Transaction<'_>, out: &mut Out, p: &BackupParams) -> Result<(), Box<dyn std::error::Error>> {
    // Every catalog column is explicitly cast: rust-postgres FromSql rejects
    // sql_identifier/name[] domain types (WrongType errors).
    tx.batch_execute("SET LOCAL timezone = 'UTC'; SET LOCAL datestyle = 'ISO, YMD';")?;
    let include = p.include_migration_journal;
    out.emit("-- Paperclip database backup")?;
    out.emit(&format!("-- Created: {}", Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)))?;
    out.emit("")?;
    out.stmt("BEGIN;")?;
    out.stmt("SET LOCAL session_replication_role = replica;")?;
    out.stmt("SET LOCAL client_min_messages = warning;")?;
    out.emit("")?;
    let raw_tables: Vec<(String, String)> = tx.query("SELECT table_schema::text AS s, table_name::text AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND (table_schema = 'public' OR ($1::boolean AND table_schema = 'drizzle' AND table_name = '__drizzle_migrations')) ORDER BY table_schema, table_name", &[&include])?.iter().map(|r| (r.get::<_, String>(0), r.get::<_, String>(1))).collect();
    let tables: Vec<&(String, String)> = raw_tables.iter().collect();
    let included: HashSet<String> = tables.iter().map(|(s, t)| format!("{s}.{t}")).collect();
    let enums: Vec<(String, Vec<String>)> = tx.query("SELECT t.typname::text AS n, array_agg(e.enumlabel::text ORDER BY e.enumsortorder)::text[] AS l FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY t.typname", &[])?.iter().map(|r| (r.get::<_, String>(0), r.get::<_, Vec<String>>(1))).collect();
    for (name, labels) in &enums {
        let ls = labels.iter().map(|l| format!("'{}'", l.replace('\'', "''"))).collect::<Vec<_>>().join(", ");
        out.stmt(&format!("CREATE TYPE \"public\".\"{name}\" AS ENUM ({ls});"))?;
    }
    if !enums.is_empty() { out.emit("")?; }

    struct SeqDef {
        schema: String, name: String, data_type: String,
        start: String, min: String, max: String, inc: String, cycle: String,
        owner_schema: Option<String>, owner_table: Option<String>, owner_column: Option<String>,
    }
    let sequences: Vec<SeqDef> = tx.query("SELECT s.sequence_schema::text AS s, s.sequence_name::text AS n, s.data_type::text AS dt, s.start_value::text AS sv, s.minimum_value::text AS mn, s.maximum_value::text AS mx, s.increment::text AS inc, s.cycle_option::text AS cy, tblns.nspname::text AS os, tbl.relname::text AS ot, attr.attname::text AS oc FROM information_schema.sequences s JOIN pg_class seq ON seq.relname = s.sequence_name JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = s.sequence_schema LEFT JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a' LEFT JOIN pg_class tbl ON tbl.oid = dep.refobjid LEFT JOIN pg_namespace tblns ON tblns.oid = tbl.relnamespace LEFT JOIN pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = dep.refobjsubid WHERE s.sequence_schema = 'public' OR ($1::boolean AND s.sequence_schema = 'drizzle') ORDER BY s.sequence_schema, s.sequence_name", &[&include])?.iter().map(|r| SeqDef { schema: r.get(0), name: r.get(1), data_type: r.get(2), start: r.get(3), min: r.get(4), max: r.get(5), inc: r.get(6), cycle: r.get(7), owner_schema: r.get(8), owner_table: r.get(9), owner_column: r.get(10) }).collect();
    let sequences: Vec<SeqDef> = sequences.into_iter().filter(|s| match &s.owner_table {
        Some(t) => included.contains(&format!("{}.{}", s.owner_schema.as_deref().unwrap_or("public"), t)),
        None => true,
    }).collect();
    let mut schemas: Vec<String> = tables.iter().map(|(s, _)| s.clone()).collect();
    schemas.extend(sequences.iter().map(|s| s.schema.clone()));
    let mut extra: Vec<String> = schemas.into_iter().collect::<HashSet<_>>().into_iter().filter(|s| s != "public").collect();
    extra.sort();
    if !extra.is_empty() {
        out.emit("-- Schemas")?;
        for s in &extra { out.stmt(&format!("CREATE SCHEMA IF NOT EXISTS {};", q(s)))?; }
        out.emit("")?;
    }
    if !sequences.is_empty() {
        out.emit("-- Sequences")?;
        for s in &sequences {
            let qn = qq(&s.schema, &s.name);
            out.stmt(&format!("DROP SEQUENCE IF EXISTS {qn} CASCADE;"))?;
            let cycle = if s.cycle == "YES" { " CYCLE" } else { " NO CYCLE" };
            out.stmt(&format!("CREATE SEQUENCE {qn} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {}{};", s.data_type, s.inc, s.min, s.max, s.start, cycle))?;
        }
        out.emit("")?;
    }

    for (schema, table) in &tables {
        let qtn = qq(schema, table);
        let columns = tx.query("SELECT column_name::text AS cn, data_type::text AS dt, udt_name::text AS un, is_nullable::text AS inul, column_default::text AS cd, character_maximum_length::int AS cl, numeric_precision::int AS np, numeric_scale::int AS ns FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", &[schema, table])?;
        out.emit(&format!("-- Table: {schema}.{table}"))?;
        out.stmt(&format!("DROP TABLE IF EXISTS {qtn} CASCADE;"))?;
        let mut defs: Vec<String> = Vec::new();
        for r in &columns {
            let (name, data_type, udt, nullable): (String, String, String, String) = (r.get(0), r.get(1), r.get(2), r.get(3));
            let (default, char_len, num_prec, num_scale): (Option<String>, Option<i32>, Option<i32>, Option<i32>) = (r.get(4), r.get(5), r.get(6), r.get(7));
            let type_str = if data_type == "USER-DEFINED" { format!("\"{udt}\"") } else if data_type == "ARRAY" { format!("{}[]", udt.trim_start_matches('_')) } else if data_type == "character varying" { char_len.map_or_else(|| "varchar".to_owned(), |n| format!("varchar({n})")) } else if data_type == "numeric" { match (num_prec, num_scale) { (Some(pr), Some(sc)) => format!("numeric({pr}, {sc})"), (Some(pr), None) => format!("numeric({pr})"), (None, _) => data_type.clone() } } else { data_type.clone() };
            let mut d = format!("  \"{name}\" {type_str}");
            if let Some(dv) = default { d.push_str(&format!(" DEFAULT {dv}")); }
            if nullable == "NO" { d.push_str(" NOT NULL"); }
            defs.push(d);
        }
        let pks = tx.query("SELECT c.conname::text AS cn, array_agg(a.attname::text ORDER BY array_position(c.conkey, a.attnum))::text[] AS cols FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey) WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'p' GROUP BY c.conname", &[schema, table])?;
        for r in &pks {
            let cname: String = r.get(0);
            let cols: Vec<String> = r.get(1);
            defs.push(format!("  CONSTRAINT \"{}\" PRIMARY KEY ({})", cname, cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ")));
        }
        out.stmt(&format!("CREATE TABLE {qtn} (\n{}\n);", defs.join(",\n")))?;
        out.emit("")?;
    }

    let owned: Vec<&SeqDef> = sequences.iter().filter(|s| s.owner_table.is_some() && s.owner_column.is_some()).collect();
    if !owned.is_empty() {
        out.emit("-- Sequence ownership")?;
        for s in &owned {
            let target = qq(s.owner_schema.as_deref().unwrap_or("public"), s.owner_table.as_deref().unwrap());
            out.stmt(&format!("ALTER SEQUENCE {} OWNED BY {}.{};", qq(&s.schema, &s.name), target, q(s.owner_column.as_deref().unwrap())))?;
        }
        out.emit("")?;
    }

    let uniques: Vec<(String, String, String, Vec<String>)> = tx.query("SELECT c.conname::text AS cn, n.nspname::text AS s, t.relname::text AS t, array_agg(a.attname::text ORDER BY array_position(c.conkey, a.attnum))::text[] AS cols FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey) WHERE c.contype = 'u' AND (n.nspname = 'public' OR ($1::boolean AND n.nspname = 'drizzle')) GROUP BY c.conname, n.nspname, t.relname ORDER BY n.nspname, t.relname, c.conname", &[&include])?.iter().filter(|r| included.contains(&format!("{}.{}", r.get::<_, String>(1), r.get::<_, String>(2)))).map(|r| (r.get(0), r.get(1), r.get(2), r.get(3))).collect();
    if !uniques.is_empty() {
        out.emit("-- Unique constraints")?;
        for (cname, s, t, cols) in &uniques {
            out.stmt(&format!("ALTER TABLE {} ADD CONSTRAINT \"{}\" UNIQUE ({});", qq(s, t), cname, cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ")))?;
        }
        out.emit("")?;
    }

    let indexes: Vec<String> = tx.query("SELECT schemaname::text AS s, tablename::text AS t, indexdef::text AS d FROM pg_indexes WHERE (schemaname = 'public' OR ($1::boolean AND schemaname = 'drizzle')) AND indexname NOT IN (SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = pg_indexes.schemaname) ORDER BY schemaname, tablename, indexname", &[&include])?.iter().filter(|r| included.contains(&format!("{}.{}", r.get::<_, String>(0), r.get::<_, String>(1)))).map(|r| r.get::<_, String>(2)).collect();
    if !indexes.is_empty() {
        out.emit("-- Indexes")?;
        for def in &indexes { out.stmt(&format!("{def};"))?; }
        out.emit("")?;
    }

    // Foreign keys come strictly after unique constraints and indexes.
    let fk_rows = tx.query("SELECT c.conname::text AS cn, srcn.nspname::text AS ss, src.relname::text AS st, array_agg(sa.attname::text ORDER BY key_pair.ordinality)::text[] AS sc, tgtn.nspname::text AS ts, tgt.relname::text AS tt, array_agg(ta.attname::text ORDER BY key_pair.ordinality)::text[] AS tc, CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END::text AS ur, CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END::text AS dr FROM pg_constraint c JOIN pg_class src ON src.oid = c.conrelid JOIN pg_namespace srcn ON srcn.oid = src.relnamespace JOIN pg_class tgt ON tgt.oid = c.confrelid JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS key_pair(source_attnum, target_attnum, ordinality) ON true JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = key_pair.source_attnum JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = key_pair.target_attnum WHERE c.contype = 'f' AND (srcn.nspname = 'public' OR ($1::boolean AND srcn.nspname = 'drizzle')) GROUP BY c.conname, srcn.nspname, src.relname, tgtn.nspname, tgt.relname, c.confupdtype, c.confdeltype ORDER BY srcn.nspname, src.relname, c.conname", &[&include])?;
    let mut fk_stmts: Vec<String> = Vec::new();
    for r in &fk_rows {
        let (cname, ss, st, ts, tt, ur, dr): (String, String, String, String, String, String, String) = (r.get(0), r.get(1), r.get(2), r.get(4), r.get(5), r.get(7), r.get(8));
        let (src_cols, tgt_cols): (Vec<String>, Vec<String>) = (r.get(3), r.get(6));
        if included.contains(&format!("{ss}.{st}")) && included.contains(&format!("{ts}.{tt}")) {
            let sc = src_cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");
            let tc = tgt_cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");
            fk_stmts.push(format!("ALTER TABLE {} ADD CONSTRAINT \"{}\" FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {};", qq(&ss, &st), cname, sc, qq(&ts, &tt), tc, ur, dr));
        }
    }
    if !fk_stmts.is_empty() {
        out.emit("-- Foreign keys")?;
        for s in &fk_stmts { out.stmt(s)?; }
        out.emit("")?;
    }

    // Data: the count query runs BEFORE the exclude/empty check over the raw table
    // list, matching backup-lib.ts and the waitForChildCountLock test contract.
    for (schema, table) in &raw_tables {
        let qtn = qq(schema, table);
        let n: i32 = tx.query_one(&format!("SELECT count(*)::int AS n FROM {qtn}"), &[])?.get(0);
        if p.exclude_tables.contains(table.as_str()) || n == 0 { continue; }
        let nullified = p.nullify_columns.get(table.as_str());
        let cols = tx.query("SELECT column_name::text AS cn, data_type::text AS dt FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", &[schema, table])?;
        let mut col_names: Vec<String> = Vec::new();
        let mut types: Vec<String> = Vec::new();
        let mut is_bool: Vec<bool> = Vec::new();
        let mut projections: Vec<String> = Vec::new();
        for r in &cols {
            let (name, dt): (String, String) = (r.get(0), r.get(1));
            col_names.push(q(&name));
            if nullified.is_some_and(|set| set.contains(&name)) {
                is_bool.push(false); types.push("NULL".to_owned()); projections.push("NULL::text".to_owned());
            } else if dt == "boolean" {
                is_bool.push(true); types.push(dt); projections.push(q(&name));
            } else {
                is_bool.push(false); types.push(dt);
                projections.push(format!("CASE WHEN {} IS NULL THEN NULL ELSE {}::text END", q(&name), q(&name)));
            }
        }
        out.emit(&format!("-- Data for: {schema}.{table} ({n} rows)"))?;
        let stmt = tx.prepare(&format!("SELECT {} FROM {}", projections.join(", "), qtn))?;
        let portal = tx.bind(&stmt, &[])?;
        loop {
            let rows = tx.query_portal(&portal, 500)?;
            if rows.is_empty() { break; }
            for row in &rows {
                let values: Vec<String> = is_bool.iter().zip(types.iter()).enumerate().map(|(i, (&b, dt))| if b {
                    match row.get::<_, Option<bool>>(i) { None => "NULL".to_owned(), Some(true) => "true".to_owned(), Some(false) => "false".to_owned() }
                } else {
                    format_value(dt, row.get::<_, Option<String>>(i))
                }).collect();
                out.stmt(&format!("INSERT INTO {qtn} ({}) VALUES ({});", col_names.join(", "), values.join(", ")))?;
            }
        }
        out.emit("")?;
    }

    if !sequences.is_empty() {
        out.emit("-- Sequence values")?;
        for s in &sequences {
            let qn = qq(&s.schema, &s.name);
            let row = tx.query_one(&format!("SELECT last_value::text, is_called FROM {qn}"), &[])?;
            let last: String = row.get(0);
            let called: bool = row.get(1);
            let skip = s.owner_table.as_ref().is_some_and(|t| p.exclude_tables.contains(t));
            if !skip {
                out.stmt(&format!("SELECT setval('{}', {}, {});", qn.replace('\'', "''"), last, if called { "true" } else { "false" }))?;
            }
        }
        out.emit("")?;
    }
    out.stmt("COMMIT;")?;
    out.emit("")?;
    Ok(())
}
