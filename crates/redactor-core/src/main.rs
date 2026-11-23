//! redactor-core CLI: JSON-in/JSON-out subcommands for the control plane.
//! Usage: paperclip-redactor-core redact-text '<json-args>'
//! Args: {"text": "...", "chunks": ["..."], "byteChunks": [[104,..], ..],
//!        "extraSecrets": ["..."], "maxBufferBytes": n, "maxScanBytes": n}
//! Output: {"output": "..."} — or {"error": "..."} with exit code 1.
use paperclip_redactor_core::{RedactorConfig, StreamingRedactor};
use serde_json::{json, Value};
use std::process;

fn byte_chunks(v: &Value) -> Result<Vec<Vec<u8>>, String> {
    let Some(items) = v.get("byteChunks").and_then(Value::as_array) else { return Ok(Vec::new()) };
    items.iter().map(|c| {
        c.as_array().map(|a| a.iter().map(|n| n.as_u64().and_then(|x| u8::try_from(x).ok()).ok_or("byteChunks entries must be 0-255".to_string())).collect::<Result<Vec<u8>, String>>())
            .ok_or_else(|| "byteChunks must be arrays".to_string()).and_then(|r| r)
    }).collect()
}

fn run() -> Result<Value, String> {
    let s = std::env::args().nth(2).ok_or("usage: paperclip-redactor-core redact-text '<json>'")?;
    let a: Value = serde_json::from_str(&s).map_err(|e| format!("bad json arg: {e}"))?;
    let cfg: RedactorConfig = serde_json::from_value(a.clone()).map_err(|e| format!("bad config: {e}"))?;
    let (mut rd, mut out) = (StreamingRedactor::new(cfg), String::new());
    if let Some(t) = a.get("text").and_then(Value::as_str) { out.push_str(&rd.push_chunk(t)); }
    if let Some(chs) = a.get("chunks").and_then(Value::as_array) {
        for c in chs {
            match c.as_str() {
                Some(t) => out.push_str(&rd.push_chunk(t)),
                None => return Err("chunks entries must be strings".into()),
            }
        }
    }
    for b in byte_chunks(&a)? { out.push_str(&rd.push_bytes(&b)); }
    out.push_str(&rd.finish());
    Ok(json!({ "output": out }))
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    match (cmd.as_str(), run()) {
        ("redact-text", Ok(v)) => println!("{v}"),
        ("redact-text", Err(e)) => { println!("{}", json!({ "error": e })); process::exit(1); }
        _ => { println!("{}", json!({ "error": "usage: paperclip-redactor-core redact-text '<json>'" })); process::exit(1); }
    }
}
