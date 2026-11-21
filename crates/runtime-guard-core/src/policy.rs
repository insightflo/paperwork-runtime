// Broad-scan policy ported from runtime-broad-scan-command-policy.ts.
use crate::{clean_shell_token, shell_tokenize, JS_WS_INNER};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ScanInput {
    pub command: String,
    pub allowed_paths: Vec<String>,
    pub allowed_directories: Vec<String>,
    pub working_directory: Option<String>,
    pub repo_search_root: Option<String>,
    pub shell_variables: HashMap<String, String>,
    pub stdin_from_pipe: bool,
}
// Tab-joined "label<TAB>pattern" rows; `~` marks the JS-\s class placeholder.
const PATTERNS: &str = "find .\t(^|~)find~+\ngit ls-files\t(^|~)git~+ls-files(~|$)\ntree\t(^|~)tree(~|$)\nls -R\t(^|~)ls~+-(?:[A-Za-z]*R[A-Za-z]*)(~|$)\nrg with a root target\t(^|~)rg~+\ngrep -R without path\t(^|~)grep~+-(?:[^\\n]*R|R[^\\n]*)(~|$)";
pub(crate) fn find_runtime_broad_scan_command(input: &ScanInput) -> Option<&'static str> {
    let w = format!("[{JS_WS_INNER}]");
    for entry in PATTERNS.lines() {
        let (label, pattern) = entry.split_once('\t').unwrap_or(("", entry));
        let re = Regex::new(&format!("(?i){pattern}").replace('~', &w)).expect("static pattern");
        if re.is_match(&input.command) {
            return evaluate_candidate(label, input);
        }
    }
    None
}
fn evaluate_candidate(label: &'static str, input: &ScanInput) -> Option<&'static str> {
    match label {
        "find ." => evaluate_find_command(input),
        "git ls-files" => (!is_repo_search_allowed(input)).then_some(label),
        "rg with a root target" | "grep -R without path" => evaluate_search_command(label, input),
        _ if is_repo_scoped_discovery(input) => None,
        _ if all_explicit_targets_allowed(input) && !has_repo_wide_target(input) => None,
        _ => Some(label),
    }
}
fn evaluate_find_command(input: &ScanInput) -> Option<&'static str> {
    let tokens = shell_tokenize(&input.command);
    // JS findIndex returns -1 when absent; startIndex + 1 == 0 scans from the top.
    let start = tokens
        .iter()
        .position(|t| t.to_lowercase() == "find")
        .map_or(0, |i| i + 1);
    // `--` is the options terminator, not a flag: skip it, keep scanning targets.
    let targets: Vec<String> = tokens[start..]
        .iter()
        .take_while(|t| !t.starts_with('-') || t.as_str() == "--")
        .filter(|t| t.as_str() != "--")
        .map(|t| clean_shell_token(&resolve_shell_variable_token(t, &input.shell_variables)))
        .collect();
    let blocked = targets.iter().any(|t| is_broad_scan_target(t, input))
        || (targets.is_empty() && !is_repo_scoped_discovery(input));
    blocked.then_some("find .")
}
fn evaluate_search_command(label: &'static str, input: &ScanInput) -> Option<&'static str> {
    let executable = label.split(' ').next().unwrap_or("grep");
    let targets = extract_search_target_paths(&input.command, executable);
    if targets.iter().any(|t| is_broad_scan_target(t, input)) {
        return Some(label);
    }
    let pathless = targets.is_empty();
    let in_repo = is_repo_search_allowed(input)
        && (pathless || targets.iter().all(|t| is_path_inside_repo_root(t, input)));
    if in_repo || executable == "rg" || (input.stdin_from_pipe && pathless) {
        return None;
    }
    if pathless || !targets.iter().all(|t| is_allowed_target_path(t, input)) {
        return Some(label);
    }
    None
}
fn all_explicit_targets_allowed(input: &ScanInput) -> bool {
    let targets = explicit_target_paths(&input.command, &input.shell_variables);
    !targets.is_empty() && targets.iter().all(|t| is_allowed_target_path(t, input))
}
fn has_repo_wide_target(input: &ScanInput) -> bool {
    shell_tokenize(&input.command).iter().any(|t| {
        is_repo_wide_target_token(&resolve_shell_variable_token(t, &input.shell_variables))
    })
}
fn is_repo_wide_target_token(token: &str) -> bool {
    let n = clean_shell_token(token).to_lowercase();
    matches!(n.as_str(), "." | "./" | "$pwd" | "$(pwd)" | "`pwd`")
}
fn dot_alnum_end(s: &str) -> bool {
    s.rfind('.').is_some_and(|i| {
        let suf = &s[i + 1..];
        !suf.is_empty() && suf.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}
fn explicit_target_paths(command: &str, vars: &HashMap<String, String>) -> Vec<String> {
    shell_tokenize(command)
        .iter()
        .filter(|t| !t.starts_with('-'))
        .map(|t| clean_shell_token(&resolve_shell_variable_token(t, vars)))
        .filter(|t| !t.is_empty() && !is_repo_wide_target_token(t))
        .filter(|t| t.contains('/') || dot_alnum_end(t))
        .collect()
}
// rg/grep options consuming a value token. TS checks the lowercased token, so
// uppercase-only entries (-A/-B/-C) never match; -T hits -t via lowercase.
const VALUE_OPTIONS: &str = "e f file g glob type t type-not context after-context before-context";
fn extract_search_target_paths(command: &str, executable: &str) -> Vec<String> {
    let tokens = shell_tokenize(command);
    let Some(cmd) = tokens.iter().position(|t| t.to_lowercase() == executable) else {
        return Vec::new();
    };
    let mut positional = Vec::new();
    let mut pattern_provided = false;
    let mut i = cmd + 1;
    while i < tokens.len() {
        let token = &tokens[i];
        if !token.starts_with('-') {
            positional.push(clean_shell_token(token));
            i += 1;
            continue;
        }
        // `--` lands here too: it matches no option branch, so it just skips
        // itself. rg: -f supplies the pattern, so later positionals are targets.
        let opt = token.to_lowercase();
        let file_opt = opt == "-f" || opt == "--file" || opt.starts_with("--file=");
        if file_opt && executable != "rg" {
            return Vec::new();
        }
        pattern_provided |=
            file_opt || opt.starts_with("-e") || opt == "--regexp" || opt.starts_with("--regexp=");
        if VALUE_OPTIONS
            .split(' ')
            .any(|o| o == opt.trim_start_matches('-'))
            && i + 1 < tokens.len()
        {
            i += 1;
        }
        i += 1;
    }
    // positional[0] is the pattern unless an option supplied it. rg only: also
    // recover absolute targets merged into the pattern token by escaped-quote
    // forms; gated to backslash-bearing tokens so a bare regex stays pathless.
    let embedded: Vec<String> = if executable == "rg" {
        positional
            .iter()
            .flat_map(|t| embedded_absolute_targets(t))
            .collect()
    } else {
        Vec::new()
    };
    let skip = usize::from(!pattern_provided);
    let mut out: Vec<String> = Vec::new();
    for t in positional.iter().skip(skip).cloned().chain(embedded) {
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}
fn embedded_absolute_targets(token: &str) -> Vec<String> {
    if !token.contains('\\') {
        return Vec::new();
    }
    let w = JS_WS_INNER;
    Regex::new(&format!(r#"/(?:[^{w}"\\|;&<>]+/)*[^{w}"\\|;&<>]+"#))
        .expect("static pattern")
        .find_iter(token)
        .map(|m| clean_shell_token(m.as_str()))
        .collect()
}
fn is_broad_scan_target(token: &str, input: &ScanInput) -> bool {
    let normalized = clean_shell_token(token).to_lowercase();
    if matches!(normalized.as_str(), "/" | ".." | "../" | "${pwd}")
        || is_repo_wide_target_token(token)
    {
        return true;
    }
    let wd = input.working_directory.as_deref();
    let Some(resolved) = resolve_with_workdir(&clean_shell_token(token), wd) else {
        return false;
    };
    let matches_root =
        |v: Option<&str>| v.is_some_and(|s| s.starts_with('/') && normalize_abs(s) == resolved);
    matches_root(wd) || matches_root(input.repo_search_root.as_deref())
}
// Shared resolve: absolute targets normalize; relative targets join an
// absolute workingDirectory, otherwise unresolved.
fn resolve_with_workdir(cleaned: &str, workdir: Option<&str>) -> Option<String> {
    if cleaned.is_empty() {
        None
    } else if cleaned.starts_with('/') {
        Some(normalize_abs(cleaned))
    } else {
        workdir
            .filter(|wd| wd.starts_with('/'))
            .map(|wd| normalize_abs(&format!("{wd}/{cleaned}")))
    }
}
fn is_allowed_target_path(target: &str, input: &ScanInput) -> bool {
    let normalized = clean_shell_token(target);
    if is_repo_wide_target_token(&normalized) || !is_explicit_single_file_target(&normalized) {
        return false;
    }
    let wd = input.working_directory.as_deref();
    let Some(resolved) = resolve_path(&normalized, wd) else {
        return false;
    };
    input
        .allowed_paths
        .iter()
        .any(|p| resolve_path(p, wd).as_deref() == Some(resolved.as_str()))
        || input.allowed_directories.iter().any(|d| {
            resolve_path(d, wd).is_some_and(|dir| {
                let rel = path_relative(&dir, &resolved);
                !rel.is_empty() && !rel.starts_with("..") && !rel.starts_with('/')
            })
        })
}
fn resolve_path(value: &str, workdir: Option<&str>) -> Option<String> {
    let normalized = clean_shell_token(value);
    if normalized.is_empty() || normalized.split('/').any(|s| s == "..") {
        return None;
    }
    resolve_with_workdir(&normalized, workdir)
}
fn is_explicit_single_file_target(target: &str) -> bool {
    // The last split segment is the file name; suf = text after its last ".".
    let name = target.rsplit('/').next().unwrap_or("");
    let suf = name.rfind('.').map(|i| &name[i + 1..]).unwrap_or("");
    !target.is_empty()
        && !target
            .bytes()
            .any(|b| matches!(b, b'*' | b'?' | b'[' | b']' | b'{' | b'}'))
        && !target.ends_with('/')
        && !suf.is_empty()
        && suf
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphanumeric() || (i > 0 && (b == b'_' || b == b'-')))
}
fn resolve_shell_variable_token(token: &str, vars: &HashMap<String, String>) -> String {
    let normalized = clean_shell_token(token);
    let name = normalized
        .strip_prefix("${")
        .and_then(|s| s.strip_suffix('}'))
        .or_else(|| normalized.strip_prefix('$'))
        .filter(|n| {
            n.bytes()
                .next()
                .is_some_and(|b| b.is_ascii_lowercase() || b == b'_')
                && n.bytes()
                    .skip(1)
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        });
    name.and_then(|n| vars.get(n).cloned())
        .unwrap_or(normalized)
}
fn is_repo_search_allowed(input: &ScanInput) -> bool {
    matches!(input.repo_search_root.as_deref(), Some(r) if r.starts_with('/'))
}
fn is_repo_scoped_discovery(input: &ScanInput) -> bool {
    let targets = explicit_target_paths(&input.command, &input.shell_variables);
    is_repo_search_allowed(input)
        && (targets.is_empty()
            || targets.iter().any(|t| is_repo_wide_target_token(t))
            || targets.iter().all(|t| is_path_inside_repo_root(t, input)))
}
fn is_path_inside_repo_root(target: &str, input: &ScanInput) -> bool {
    input.repo_search_root.as_deref().is_some_and(|root| {
        resolve_path(target, input.working_directory.as_deref()).is_some_and(|resolved| {
            let rel = path_relative(root, &resolved);
            !rel.is_empty() && !rel.starts_with("..") && !rel.starts_with('/')
        })
    })
}
// POSIX node:path helpers: normalize collapses ".", ".." and empty segments
// (".." can never climb above the filesystem root); relative works on segments.
fn normalize_abs(p: &str) -> String {
    let segs = p.split('/').fold(Vec::new(), |mut out, s| {
        match s {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
        out
    });
    format!("/{}", segs.join("/"))
}
fn path_relative(from: &str, to: &str) -> String {
    let (fs, ts) = (normalize_abs(from), normalize_abs(to));
    let f = fs.split('/').filter(|s| !s.is_empty()).collect::<Vec<_>>();
    let t = ts.split('/').filter(|s| !s.is_empty()).collect::<Vec<_>>();
    let i = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    format!("{}{}", "../".repeat(f.len() - i), t[i..].join("/"))
}
