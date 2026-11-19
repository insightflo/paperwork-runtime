// paperclip-db-backup: streaming PostgreSQL backup/restore CLI.
// JSON config arrives on stdin (never argv) so `ps` cannot leak the connection string.
mod backup;
mod restore;

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::process::exit;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRequest {
    connection_string: String,
    backup_file: String,
    connect_timeout_seconds: Option<i64>,
    include_migration_journal: Option<bool>,
    exclude_tables: Option<Vec<String>>,
    nullify_columns: Option<HashMap<String, Vec<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreRequest {
    connection_string: String,
    backup_file: String,
    connect_timeout_seconds: Option<i64>,
}

fn read_stdin_json() -> Result<String, String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut stdin = std::io::stdin().lock();
    loop {
        let n = stdin.read(&mut chunk).map_err(|e| format!("read stdin failed: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 1024 * 1024 {
            return Err("stdin config exceeds 1 MiB".to_owned());
        }
    }
    if buf.is_empty() {
        return Err("empty stdin config".to_owned());
    }
    String::from_utf8(buf).map_err(|e| format!("stdin is not valid UTF-8: {e}"))
}

fn normalize_set(values: Option<Vec<String>>) -> HashSet<String> {
    values.unwrap_or_default().into_iter().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).collect()
}

fn normalize_nullify(values: Option<HashMap<String, Vec<String>>>) -> HashMap<String, HashSet<String>> {
    let mut out: HashMap<String, HashSet<String>> = HashMap::new();
    for (table, cols) in values.unwrap_or_default() {
        let table = table.trim().to_owned();
        if table.is_empty() {
            continue;
        }
        let set: HashSet<String> = cols.into_iter().map(|c| c.trim().to_owned()).filter(|c| !c.is_empty()).collect();
        if !set.is_empty() {
            out.insert(table, set);
        }
    }
    out
}

fn main() {
    let command = std::env::args().nth(1).unwrap_or_default();
    let config = match read_stdin_json() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("paperclip-db-backup: {e}");
            exit(2);
        }
    };
    match command.as_str() {
        "backup" => {
            let req: BackupRequest = match serde_json::from_str(&config) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("paperclip-db-backup: invalid JSON config: {e}");
                    exit(2);
                }
            };
            let exclude_tables = normalize_set(req.exclude_tables.clone());
            let nullify_columns = normalize_nullify(req.nullify_columns.clone());
            let params = backup::BackupParams {
                connection_string: &req.connection_string,
                backup_file: &req.backup_file,
                connect_timeout_seconds: req.connect_timeout_seconds.unwrap_or(5),
                include_migration_journal: req.include_migration_journal.unwrap_or(false),
                exclude_tables: &exclude_tables,
                nullify_columns: &nullify_columns,
            };
            match backup::run(&params) {
                Ok((backup_file, size_bytes)) => {
                    println!("{}", serde_json::json!({ "backupFile": backup_file, "sizeBytes": size_bytes }));
                }
                Err(e) => {
                    eprintln!("{e}");
                    exit(1);
                }
            }
        }
        "restore" => {
            let req: RestoreRequest = match serde_json::from_str(&config) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("paperclip-db-backup: invalid JSON config: {e}");
                    exit(2);
                }
            };
            let params = restore::RestoreParams {
                connection_string: &req.connection_string,
                backup_file: &req.backup_file,
                connect_timeout_seconds: req.connect_timeout_seconds.unwrap_or(5),
            };
            match restore::run(&params) {
                Ok(()) => println!("{}", serde_json::json!({ "ok": true })),
                Err(e) => {
                    eprintln!("{e}");
                    exit(1);
                }
            }
        }
        _ => {
            eprintln!("usage: paperclip-db-backup <backup|restore>  (JSON config on stdin)");
            exit(2);
        }
    }
}
