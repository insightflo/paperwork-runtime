// crates/qa-file-owner/src/publish.rs
//
// [purpose] publish op — item validation, preflight gate, then ordered atomic application
//   under the held guards.

use crate::protocol::{py_err, py_repr, refuse, sha256_hex, Denied, MAX_FILE_BYTES};
use crate::publish_io::{classify, fsync_dir, io_report, parent_str, write_atomically, ClassRow, Item};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::os::unix::io::RawFd;

fn int_field(obj: &Map<String, Value>, key: &str) -> Result<u64, Denied> {
    if let Some(Value::Number(n)) = obj.get(key) {
        if let Some(v) = n.as_u64() {
            return Ok(v);
        }
    }
    Err(refuse("bad_items", format!("item.{key} must be a non-negative integer")))
}

fn hex64(obj: &Map<String, Value>, key: &str) -> bool {
    matches!(obj.get(key), Some(Value::String(s))
        if s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

pub(crate) fn handle_publish(msg: &Map<String, Value>, guards: &HashMap<String, RawFd>) -> Result<Value, Denied> {
    let items = match msg.get("items") {
        Some(Value::Array(a)) if !a.is_empty() => a,
        _ => return Err(refuse("bad_items", "items must be a non-empty list")),
    };
    let mut plan: Vec<(String, Item)> = Vec::with_capacity(items.len());
    let mut seen: HashSet<String> = HashSet::new();
    for entry in items {
        let obj = match entry.as_object() {
            Some(o) => o,
            None => return Err(refuse("bad_items", "each item must be an object")),
        };
        let target_v = obj.get("target");
        let target = match target_v.and_then(Value::as_str) {
            Some(t) if guards.contains_key(t) => t.to_string(),
            _ => {
                return Err(refuse(
                    "item_out_of_scope",
                    format!("target is not a held guard target: {}", py_repr(target_v)),
                ))
            }
        };
        if !seen.insert(target.clone()) {
            return Err(refuse(
                "duplicate_items",
                format!("duplicate publish item for target: {target}"),
            ));
        }
        if !hex64(obj, "beforeSha256") || !hex64(obj, "afterSha256") {
            return Err(refuse(
                "bad_items",
                "item.beforeSha256/afterSha256 must be lowercase hex sha256 strings",
            ));
        }
        let before_size = int_field(obj, "beforeSize")?;
        let after_size = int_field(obj, "afterSize")?;
        let raw_b64 = match obj.get("bytesB64") {
            None => "",
            Some(Value::String(s)) => s.as_str(),
            Some(_) => {
                return Err(refuse(
                    "bad_items",
                    "bytesB64 is not valid base64: argument must be an ASCII string",
                ))
            }
        };
        let data = B64
            .decode(raw_b64.as_bytes())
            .map_err(|e| refuse("bad_items", format!("bytesB64 is not valid base64: {e}")))?;
        if data.len() > MAX_FILE_BYTES {
            return Err(refuse("bytes_over_cap", format!("desired bytes exceed cap for {target}")));
        }
        let item = Item {
            before_sha: obj["beforeSha256"].as_str().expect("hex64 checked").to_string(),
            after_sha: obj["afterSha256"].as_str().expect("hex64 checked").to_string(),
            before_size,
            after_size,
            data,
        };
        if sha256_hex(&item.data) != item.after_sha || item.data.len() as u64 != item.after_size {
            return Err(refuse(
                "identity_mismatch",
                format!("desired bytes do not match declared after identity for {target}"),
            ));
        }
        plan.push((target, item));
    }

    // preflight — every item is classified before anything is written
    let classified: Vec<(String, Item, ClassRow)> = plan
        .into_iter()
        .map(|(target, item)| {
            let row = classify(&target, &item);
            (target, item, row)
        })
        .collect();
    let mut files: Vec<Value> = classified
        .iter()
        .map(|(target, _item, row)| {
            json!({
                "target": target,
                "status": row.status,
                "detail": row.detail,
                "observedSha256": row.digest,
                "observedSize": row.size,
            })
        })
        .collect();

    let held_cause = files
        .iter()
        .find(|f| f["status"] == "mismatch_held")
        .and_then(|f| f["detail"].as_str().map(str::to_string));
    if let Some(cause) = held_cause {
        for f in files.iter_mut() {
            if f["status"] == "apply" || f["status"] == "already_applied" {
                f["status"] = json!("held");
                f["detail"] = json!("not written: preflight held before any write");
            }
        }
        return Ok(json!({
            "type": "publish_result", "ok": false, "outcome": "held", "files": files,
            "detail": format!("preflight held: {cause}"),
        }));
    }
    let io_cause = files
        .iter()
        .find(|f| f["status"] == "io_error")
        .and_then(|f| f["detail"].as_str().map(str::to_string));
    if let Some(cause) = io_cause {
        return Ok(io_report(files, format!("preflight io failure: {cause}")));
    }

    let mut results: Vec<Value> = Vec::with_capacity(classified.len());
    for (index, (target, item, row)) in classified.iter().enumerate() {
        if row.status == "already_applied" {
            // directory barrier first — a rename could have died before its dir fsync
            if let Err(e) = fsync_dir(parent_str(target)) {
                let failure = format!("directory barrier failed: {}", py_err(&e));
                let mut failed = files[index].clone();
                failed["status"] = json!("io_error");
                failed["detail"] = json!(failure);
                let mut combined = results;
                combined.push(failed);
                combined.extend(files[index + 1..].iter().cloned());
                return Ok(io_report(
                    combined,
                    format!("publication io failure at {target}: {failure}"),
                ));
            }
            results.push(json!({
                "target": target,
                "status": "already_applied",
                "detail": "verified at declared after identity under held guard",
                "observedSha256": row.digest,
                "observedSize": row.size,
            }));
            continue;
        }
        let failure = match write_atomically(target, &item.data, row.mode, &item.after_sha, item.after_size) {
            Ok(None) => None,
            Ok(Some(msg)) => Some(msg),
            Err(e) => Some(format!("io failure: {}", py_err(&e))),
        };
        if let Some(failure) = failure {
            let mut failed = files[index].clone();
            failed["status"] = json!("io_error");
            failed["detail"] = json!(failure);
            let mut combined = std::mem::take(&mut results);
            combined.push(failed);
            combined.extend(files[index + 1..].iter().cloned());
            return Ok(io_report(
                combined,
                format!("publication io failure at {target}: {failure}"),
            ));
        }
        results.push(json!({
            "target": target,
            "status": "applied",
            "detail": format!("exclusive temp + atomic rename + readback verified ({} bytes)", item.data.len()),
            "observedSha256": item.after_sha,
            "observedSize": item.after_size,
        }));
    }
    let count = results.len();
    Ok(json!({
        "type": "publish_result", "ok": true, "outcome": "published", "files": results,
        "detail": format!("{count} files at declared after identity under held guard"),
    }))
}
