// Streaming restore: splits the (optionally multi-member gzip) dump on
// STATEMENT_BREAKPOINT while reading in 64 KB chunks, keeping the scan O(N)
// via an incremental search offset, and executes each statement.
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use flate2::read::MultiGzDecoder;
use postgres::{Config, NoTls};

use crate::backup::STATEMENT_BREAKPOINT;

pub(crate) struct RestoreParams<'a> {
    pub(crate) connection_string: &'a str,
    pub(crate) backup_file: &'a str,
    pub(crate) connect_timeout_seconds: i64,
}

#[derive(Debug)]
enum StreamErr {
    Io(std::io::Error),
    Db(postgres::Error),
}

impl From<std::io::Error> for StreamErr {
    fn from(e: std::io::Error) -> Self {
        StreamErr::Io(e)
    }
}

impl From<postgres::Error> for StreamErr {
    fn from(e: postgres::Error) -> Self {
        StreamErr::Db(e)
    }
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// Reads in chunk_size blocks, drains consumed bytes once per read, and only ever rescans
// the tail that could hold a partial breakpoint — the whole pass stays O(N) for
// multi-GB restores with few or huge statements.
fn stream_statements_chunked<R: Read>(
    mut reader: R,
    chunk_size: usize,
    on_stmt: &mut dyn FnMut(&str) -> Result<(), postgres::Error>,
) -> Result<(), StreamErr> {
    let bp = STATEMENT_BREAKPOINT.as_bytes();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; chunk_size];
    let mut search_offset = 0usize;
    loop {
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        let mut consumed = 0usize;
        let mut i = search_offset;
        while let Some(rel) = find_sub(&buf[i..], bp) {
            let abs = i + rel;
            let frame = std::str::from_utf8(&buf[consumed..abs])
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
                .trim();
            if !frame.is_empty() {
                on_stmt(frame)?;
            }
            consumed = abs + bp.len();
            i = consumed;
        }
        if consumed > 0 {
            buf.drain(..consumed);
        }
        search_offset = buf.len().saturating_sub(bp.len() - 1);
    }
    if !buf.is_empty() {
        let frame = std::str::from_utf8(&buf)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
            .trim();
        if !frame.is_empty() {
            on_stmt(frame)?;
        }
    }
    Ok(())
}

// Sanitized error body: "<SEVERITY>: <first line of message, else detail>" plus the
// first 120 chars of the first non-empty non-comment line of the failing statement.
fn db_message(e: &postgres::Error, stmt: Option<&str>) -> String {
    let core = match e.as_db_error() {
        Some(de) => {
            let first = de.message().lines().next().unwrap_or("").trim();
            let msg = if first.is_empty() {
                de.detail().map(|d| d.trim().to_owned()).unwrap_or_default()
            } else {
                first.to_owned()
            };
            if msg.is_empty() {
                format!("{e}")
            } else {
                format!("{}: {}", de.severity(), msg)
            }
        }
        None => format!("{e}"),
    };
    let preview = stmt.and_then(|s| s.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("--")));
    match preview {
        Some(p) => format!("{core} [statement: {}]", p.chars().take(120).collect::<String>()),
        None => core,
    }
}

pub(crate) fn run(p: &RestoreParams) -> Result<(), String> {
    let basename = Path::new(&p.backup_file)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.backup_file.to_owned());
    let fail = |msg: String| format!("Failed to restore {basename}: {msg}");
    let mut config = Config::from_str(p.connection_string).map_err(|e| fail(format!("invalid connection string: {e}")))?;
    config.connect_timeout(Duration::from_secs(p.connect_timeout_seconds.max(1) as u64));
    let mut client = config.connect(NoTls).map_err(|e| fail(format!("{e}")))?;
    client.batch_execute("SELECT 1").map_err(|e| fail(db_message(&e, None)))?;
    let path = Path::new(&p.backup_file);
    let file = File::open(path).map_err(|e| fail(format!("{e}")))?;
    let is_gz = path.extension().and_then(|e| e.to_str()) == Some("gz");
    let reader: Box<dyn Read> = if is_gz {
        Box::new(MultiGzDecoder::new(BufReader::with_capacity(64 * 1024, file)))
    } else {
        Box::new(BufReader::with_capacity(64 * 1024, file))
    };
    let mut failed_stmt: Option<String> = None;
    let result = stream_statements_chunked(reader, 64 * 1024, &mut |stmt: &str| {
        let r = client.batch_execute(stmt);
        if r.is_err() {
            failed_stmt = Some(stmt.to_owned());
        }
        r
    });
    result.map_err(|e| match e {
        StreamErr::Io(e) => fail(format!("{e}")),
        StreamErr::Db(e) => fail(db_message(&e, failed_stmt.as_deref())),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{dollar_quote, ensure_parent_dirs, strip_nul, DirGuard};
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::fs;
    use std::io::Write as IoWrite;

    fn collect<R: Read>(r: R, chunk: usize) -> Result<Vec<String>, StreamErr> {
        let mut out: Vec<String> = Vec::new();
        stream_statements_chunked(r, chunk, &mut |s| {
            out.push(s.to_owned());
            Ok(())
        })?;
        Ok(out)
    }

    fn gzip_bytes(content: &[u8]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(content).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn splits_breakpoints_across_utf8_and_chunk_boundaries() {
        let stmt1 = "INSERT INTO \"t\" VALUES ('안녕하세요 世界 🌏');";
        let stmt2 = "INSERT INTO \"t\" VALUES (2);";
        let mut content = format!("{stmt1}\n{}\n{stmt2}\n", STATEMENT_BREAKPOINT);
        content.push_str(STATEMENT_BREAKPOINT);
        content.push_str("\n-- trailing comment\n");
        for chunk in [1usize, 3, 7, 64, 1024, 64 * 1024] {
            let frames = collect(content.as_bytes(), chunk).unwrap();
            assert_eq!(frames, vec![stmt1.to_owned(), stmt2.to_owned(), "-- trailing comment".to_owned()], "chunk={chunk}");
        }
    }

    #[test]
    fn handles_breakpoint_and_utf8_straddling_the_64k_edge() {
        // Multibyte character straddles the 65536-byte chunk edge.
        let prefix = format!("{}한", "a".repeat(65534));
        let content = format!("{prefix}\n{}\nINSERT INTO \"t\" VALUES (1);\n", STATEMENT_BREAKPOINT);
        let frames = collect(content.as_bytes(), 64 * 1024).unwrap();
        assert_eq!(frames, vec![prefix, "INSERT INTO \"t\" VALUES (1);".to_owned()]);
        // Breakpoint itself straddles the edge (starts 20 bytes before it).
        let head = "b".repeat(65536 - 20);
        let content2 = format!("{head}{}\nINSERT INTO \"t\" VALUES (2);\n", STATEMENT_BREAKPOINT);
        let frames2 = collect(content2.as_bytes(), 64 * 1024).unwrap();
        assert_eq!(frames2, vec![head, "INSERT INTO \"t\" VALUES (2);".to_owned()]);
    }

    #[test]
    fn scans_large_statement_without_breakpoint() {
        let big = format!("INSERT INTO \"t\" VALUES ('{}');", "y".repeat(3 * 1024 * 1024));
        let mut content = format!("{big}\n{}\nINSERT INTO \"t\" VALUES (1);\n", STATEMENT_BREAKPOINT);
        content.push_str(STATEMENT_BREAKPOINT);
        content.push('\n');
        let frames = collect(content.as_bytes(), 64 * 1024).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], big);
    }

    #[test]
    fn restores_multi_member_gzip_and_rejects_corrupt() {
        let part1 = format!("INSERT INTO \"a\" VALUES (1);\n{}\n", STATEMENT_BREAKPOINT);
        let part2 = format!("INSERT INTO \"b\" VALUES ('한글');\n{}\n", STATEMENT_BREAKPOINT);
        let mut bytes = gzip_bytes(part1.as_bytes());
        bytes.extend_from_slice(&gzip_bytes(part2.as_bytes()));
        let frames = collect(MultiGzDecoder::new(&bytes[..]), 64 * 1024).unwrap();
        let expected = vec!["INSERT INTO \"a\" VALUES (1);".to_owned(), "INSERT INTO \"b\" VALUES ('한글');".to_owned()];
        assert_eq!(frames, expected);
        let corrupt = b"not-a-gzip-backup";
        assert!(collect(MultiGzDecoder::new(&corrupt[..]), 64 * 1024).is_err());
    }

    #[test]
    fn dollar_quotes_are_collision_safe_and_strip_nul() {
        assert_eq!(strip_nul("a\u{0}b"), "ab");
        assert_eq!(dollar_quote("plain"), "$paperclip$plain$paperclip$");
        assert_eq!(dollar_quote("has $paperclip$ inside"), "$paperclip_1$has $paperclip$ inside$paperclip_1$");
        assert_eq!(dollar_quote("$paperclip$ and $paperclip_1$"), "$paperclip_2$$paperclip$ and $paperclip_1$$paperclip_2$");
    }

    #[test]
    fn dir_guard_rolls_back_created_dirs_and_partial() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("paperclip-db-backup-test-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let deep = root.join("a").join("b").join("c");
        let file = deep.join("backup.partial");
        let mut created = Vec::new();
        ensure_parent_dirs(&file, &mut created).unwrap();
        assert_eq!(created.len(), 3);
        fs::write(&file, b"partial").unwrap();
        let guard = DirGuard::new(file.clone(), created);
        drop(guard);
        assert!(!file.exists());
        assert!(!deep.exists());
        assert!(root.exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
