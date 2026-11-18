use std::fmt;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};

use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::{read_stdin_bounded, sha256_file_hex, STREAM_CHUNK_BYTES};

const MAX_STDIN_JSON_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
struct SessionCountOut {
    count: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHashesReq {
    max_bytes: u64,
    paths: Vec<String>,
}

#[derive(Serialize)]
struct FileHashEntry {
    exists: bool,
    sha256: Option<String>,
}

#[derive(Serialize)]
struct FileHashesOut {
    files: Vec<FileHashEntry>,
}

struct StrIsMessage;

impl<'de> Visitor<'de> for StrIsMessage {
    type Value = bool;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<bool, E> {
        Ok(v == "message")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_unit<E: de::Error>(self) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_none<E: de::Error>(self) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<bool, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(false)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(false)
    }
}

struct TypeVal(bool);

impl<'de> Deserialize<'de> for TypeVal {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self(deserializer.deserialize_any(StrIsMessage)?))
    }
}

struct KeyTag(bool);

impl<'de> Deserialize<'de> for KeyTag {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl<'de> Visitor<'de> for KeyVisitor {
            type Value = bool;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("object key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<bool, E> {
                Ok(v == "type")
            }
        }
        Ok(Self(deserializer.deserialize_str(KeyVisitor)?))
    }
}

struct JsonEntryVisitor;

impl<'de> Visitor<'de> for JsonEntryVisitor {
    type Value = bool;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_unit<E: de::Error>(self) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_none<E: de::Error>(self) -> Result<bool, E> {
        Ok(false)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<bool, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(false)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
        let mut is_msg = false;
        while let Some(KeyTag(is_type)) = map.next_key()? {
            if is_type {
                let TypeVal(v) = map.next_value()?;
                is_msg = v;
            } else {
                let _ = map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(is_msg)
    }
}

pub(crate) fn line_is_message(trimmed: &str) -> bool {
    let mut de = serde_json::Deserializer::from_str(trimmed);
    let Ok(matched) = de.deserialize_any(JsonEntryVisitor) else {
        return false;
    };
    de.end().is_ok() && matched
}

pub(crate) fn count_session_messages(path: &str, stop_after: Option<usize>) -> Option<usize> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    if meta.len() == 0 {
        return Some(0);
    }
    let file = File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(STREAM_CHUNK_BYTES, file);
    let mut raw = Vec::with_capacity(4096);
    let mut count = 0_usize;
    loop {
        raw.clear();
        let n = reader.read_until(b'\n', &mut raw).ok()?;
        if n == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line_is_message(trimmed) {
            count += 1;
            if stop_after.is_some_and(|limit| count > limit) {
                break;
            }
        }
    }
    Some(count)
}

pub(crate) fn run_session_count(args: &[String]) -> Result<(), String> {
    let mut file_path: Option<String> = None;
    let mut stop_after: Option<usize> = None;
    let mut idx = 0;
    while idx < args.len() {
        match args[idx].as_str() {
            "--file" => {
                idx += 1;
                file_path = Some(args.get(idx).ok_or("missing --file value")?.clone());
            }
            "--stop-after" => {
                idx += 1;
                let raw = args.get(idx).ok_or("missing --stop-after value")?;
                stop_after = Some(raw.parse::<usize>().map_err(|err| err.to_string())?);
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        idx += 1;
    }
    let target = file_path.ok_or("--file is required")?;
    let out = SessionCountOut {
        count: count_session_messages(&target, stop_after),
    };
    println!("{}", serde_json::to_string(&out).map_err(|err| err.to_string())?);
    Ok(())
}

pub(crate) fn run_file_hashes(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: paperclip-fs-scan file-hashes".to_string());
    }
    let raw = read_stdin_bounded(MAX_STDIN_JSON_BYTES)?;
    let req: FileHashesReq = serde_json::from_slice(&raw).map_err(|err| err.to_string())?;
    let mut files = Vec::with_capacity(req.paths.len());
    for p in &req.paths {
        let Ok(meta) = fs::metadata(p) else {
            files.push(FileHashEntry { exists: false, sha256: None });
            continue;
        };
        if !meta.is_file() {
            files.push(FileHashEntry { exists: false, sha256: None });
            continue;
        }
        let sha256 = if meta.len() <= req.max_bytes {
            sha256_file_hex(p).ok()
        } else {
            None
        };
        files.push(FileHashEntry { exists: true, sha256 });
    }
    println!(
        "{}",
        serde_json::to_string(&FileHashesOut { files }).map_err(|err| err.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::line_is_message;

    #[test]
    fn matches_only_top_level_message_objects() {
        assert!(line_is_message(r#"{"type":"message","body":"ok"}"#));
        assert!(line_is_message(r#"{"type":"other","type":"message"}"#));
        assert!(!line_is_message(r#"{"type":"message","type":"other"}"#));
        assert!(!line_is_message(r#"{"nested":{"type":"message"}}"#));
        assert!(!line_is_message(r#"[{"type":"message"}]"#));
        assert!(!line_is_message(r#""message""#));
        assert!(!line_is_message("null"));
        assert!(!line_is_message(r#"{"type":"message", trailing"#));
        assert!(!line_is_message(r#"{"type":"message"} junk"#));
    }
}
