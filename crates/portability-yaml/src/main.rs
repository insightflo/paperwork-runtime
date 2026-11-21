//! `paperclip-portability-yaml` — stdin JSON → stdout JSON helper mirroring the
//! hand-rolled YAML emitter / frontmatter builder in
//! `server/src/services/company-portability-yaml.ts` (Stage 5.1).
//!
//! Commands:
//! - `build-markdown`     `{ frontmatter, body }` → `{ markdown }`
//! - `build-yaml-file`    `{ value, preserveEmptyStrings? }` → `{ yaml }`
//! - `strip-empty-values` `{ value, preserveEmptyStrings? }` → `{ value }` (dropped entries become `null`)
//!
//! YAML parsing stays in TS; this binary only performs deterministic renders.

mod emit;

use serde_json::{json, Map, Value};
use std::io::{Read, Write};

const USAGE: &str = "usage: paperclip-portability-yaml <build-markdown|build-yaml-file|strip-empty-values> < input.json > output.json";

fn fail(message: &str) -> ! {
    eprintln!("paperclip-portability-yaml: {message}");
    std::process::exit(1);
}

fn require_object<'a>(value: &'a Value, field: &str) -> &'a Map<String, Value> {
    match value.get(field) {
        Some(Value::Object(object)) => object,
        _ => fail(&format!("input.{field} must be a JSON object")),
    }
}

fn require_str<'a>(value: &'a Value, field: &str) -> &'a str {
    match value.get(field) {
        Some(Value::String(s)) => s.as_str(),
        _ => fail(&format!("input.{field} must be a JSON string")),
    }
}

fn require_value<'a>(value: &'a Value, field: &str) -> &'a Value {
    match value.get(field) {
        Some(value) => value,
        None => fail(&format!("input.{field} is required")),
    }
}

fn optional_flag(value: &Value, field: &str) -> bool {
    match value.get(field) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        _ => fail(&format!("input.{field} must be a boolean")),
    }
}

fn cmd_build_markdown(input: &Value) -> Value {
    let frontmatter = require_object(input, "frontmatter");
    let body = require_str(input, "body");
    json!({ "markdown": emit::build_markdown(frontmatter, body) })
}

fn cmd_build_yaml_file(input: &Value) -> Value {
    let value = require_value(input, "value");
    let preserve_empty_strings = optional_flag(input, "preserveEmptyStrings");
    json!({ "yaml": emit::build_yaml_file(value, preserve_empty_strings) })
}

fn cmd_strip_empty_values(input: &Value) -> Value {
    let value = require_value(input, "value");
    let preserve_empty_strings = optional_flag(input, "preserveEmptyStrings");
    let stripped = emit::strip_empty_values(value, preserve_empty_strings).unwrap_or(Value::Null);
    json!({ "value": stripped })
}

fn main() {
    let command = match std::env::args().nth(1) {
        Some(command) => command,
        None => fail(USAGE),
    };
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        fail("stdin is not valid UTF-8");
    }
    let parsed: Value = match serde_json::from_str(input.as_str()) {
        Ok(parsed) => parsed,
        Err(error) => fail(&format!("invalid input JSON: {error}")),
    };
    let output = match command.as_str() {
        "build-markdown" => cmd_build_markdown(&parsed),
        "build-yaml-file" => cmd_build_yaml_file(&parsed),
        "strip-empty-values" => cmd_strip_empty_values(&parsed),
        other => fail(&format!("unknown command: {other}\n{USAGE}")),
    };
    let payload = serde_json::to_string(&output).expect("output JSON must serialize");
    let mut stdout = std::io::stdout();
    writeln!(stdout, "{payload}").expect("write stdout");
}
