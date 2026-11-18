use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{read_stdin_bounded, sha256_file_hex};

const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;
const MAX_DETAIL_UTF16: usize = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineChecksReq {
    checks: Vec<CheckInput>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CheckInput {
    #[serde(rename_all = "camelCase")]
    FileGlob {
        display_path: String,
        resolved_path: String,
        glob: String,
        min_count: usize,
    },
    #[serde(rename_all = "camelCase")]
    FileExists {
        display_path: String,
        resolved_path: String,
    },
    #[serde(rename_all = "camelCase")]
    MinSizeBytes {
        display_path: String,
        resolved_path: String,
        min_bytes: u64,
    },
    #[serde(rename_all = "camelCase")]
    ContentSha256 {
        display_path: String,
        resolved_path: String,
        sha256: String,
    },
}

#[derive(Serialize)]
struct CheckResult {
    kind: &'static str,
    path: String,
    ok: bool,
    detail: String,
}

#[derive(Serialize)]
struct MachineChecksOut {
    results: Vec<CheckResult>,
}

#[derive(Clone, Copy)]
enum GlobToken {
    DoubleStarSlash,
    DoubleStar,
    Star,
    Literal(char),
}

fn compile_glob(glob: &str) -> Vec<GlobToken> {
    let chars: Vec<char> = glob.chars().collect();
    let mut tokens = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' {
            if chars.get(i + 1) == Some(&'*') {
                if chars.get(i + 2) == Some(&'/') {
                    tokens.push(GlobToken::DoubleStarSlash);
                    i += 3;
                } else {
                    tokens.push(GlobToken::DoubleStar);
                    i += 2;
                }
            } else {
                tokens.push(GlobToken::Star);
                i += 1;
            }
        } else {
            tokens.push(GlobToken::Literal(chars[i]));
            i += 1;
        }
    }
    tokens
}

pub(crate) fn glob_matches(glob: &str, candidate: &str) -> bool {
    let tokens = compile_glob(glob);
    let text: Vec<char> = candidate.chars().collect();
    let m = text.len();
    let mut next = vec![false; m + 1];
    next[m] = true;

    for token in tokens.into_iter().rev() {
        let mut curr = vec![false; m + 1];
        match token {
            GlobToken::Literal(ch) => {
                for j in 0..m {
                    curr[j] = text[j] == ch && next[j + 1];
                }
            }
            GlobToken::DoubleStar => {
                let mut any_true = false;
                for j in (0..=m).rev() {
                    if next[j] {
                        any_true = true;
                    }
                    curr[j] = any_true;
                }
            }
            GlobToken::Star => {
                curr[m] = next[m];
                for j in (0..m).rev() {
                    curr[j] = next[j] || (text[j] != '/' && curr[j + 1]);
                }
            }
            GlobToken::DoubleStarSlash => {
                let mut seen_slash_after = false;
                for j in (0..=m).rev() {
                    let slash_hit = j < m && text[j] == '/' && next[j + 1];
                    if slash_hit {
                        seen_slash_after = true;
                    }
                    curr[j] = next[j] || seen_slash_after;
                }
            }
        }
        next = curr;
    }
    next[0]
}

fn clamp_detail(detail: &str) -> String {
    let mut utf16_len = 0_usize;
    for (byte_idx, ch) in detail.char_indices() {
        let w = ch.len_utf16();
        if utf16_len + w > MAX_DETAIL_UTF16 {
            let mut out = detail[..byte_idx].to_string();
            out.push('…');
            return out;
        }
        utf16_len += w;
    }
    detail.to_string()
}

fn list_files_relative(root_dir: &Path) -> std::io::Result<Vec<String>> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) -> std::io::Result<()> {
        for entry_res in fs::read_dir(dir)? {
            let entry = entry_res?;
            let ft = entry.file_type()?;
            let name = entry.file_name();
            let seg = name.to_string_lossy();
            let rel = if prefix.is_empty() {
                seg.into_owned()
            } else {
                format!("{prefix}/{seg}")
            };
            if ft.is_dir() {
                walk(&entry.path(), &rel, out)?;
            } else if ft.is_file() {
                out.push(rel);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root_dir, "", &mut out)?;
    Ok(out)
}

fn evaluate_check(check: CheckInput) -> CheckResult {
    let kind = match &check {
        CheckInput::FileGlob { .. } => "file_glob",
        CheckInput::FileExists { .. } => "file_exists",
        CheckInput::MinSizeBytes { .. } => "min_size_bytes",
        CheckInput::ContentSha256 { .. } => "content_sha256",
    };
    let display_path = match &check {
        CheckInput::FileGlob { display_path, .. }
        | CheckInput::FileExists { display_path, .. }
        | CheckInput::MinSizeBytes { display_path, .. }
        | CheckInput::ContentSha256 { display_path, .. } => display_path.clone(),
    };
    let res: Result<(bool, String), std::io::Error> = (|| match check {
        CheckInput::FileGlob { resolved_path, glob, min_count, .. } => {
            let meta = fs::metadata(&resolved_path)?;
            if !meta.is_dir() {
                return Ok((false, "not a directory".to_string()));
            }
            let files = list_files_relative(Path::new(&resolved_path))?;
            let count = files.iter().filter(|f| glob_matches(&glob, f)).count();
            let ok = count >= min_count;
            let detail = if ok {
                format!("matched {count} file(s) >= {min_count}")
            } else {
                format!("matched {count} file(s), required >= {min_count}")
            };
            Ok((ok, detail))
        }
        CheckInput::FileExists { resolved_path, .. } => {
            let ok = fs::metadata(&resolved_path)?.is_file();
            Ok((ok, if ok { "file exists" } else { "not a regular file" }.to_string()))
        }
        CheckInput::MinSizeBytes { resolved_path, min_bytes, .. } => {
            let meta = fs::metadata(&resolved_path)?;
            let ok = meta.is_file() && meta.len() >= min_bytes;
            let detail = if ok {
                format!("size {} >= {min_bytes}", meta.len())
            } else {
                format!("size {} < {min_bytes}", meta.len())
            };
            Ok((ok, detail))
        }
        CheckInput::ContentSha256 { resolved_path, sha256, .. } => {
            let expected = sha256.to_lowercase();
            let digest = sha256_file_hex(&resolved_path)?;
            let ok = digest == expected;
            let detail = if ok {
                "sha256 matches".to_string()
            } else {
                format!("sha256 mismatch (expected {expected}, got {digest})")
            };
            Ok((ok, detail))
        }
    })();

    match res {
        Ok((ok, detail)) => CheckResult { kind, path: display_path, ok, detail },
        Err(err) => CheckResult { kind, path: display_path, ok: false, detail: clamp_detail(&err.to_string()) },
    }
}

pub(crate) fn run_machine_checks(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: paperclip-fs-scan machine-checks".to_string());
    }
    let raw = read_stdin_bounded(MAX_STDIN_BYTES)?;
    let req: MachineChecksReq = serde_json::from_slice(&raw).map_err(|err| err.to_string())?;
    let results = req.checks.into_iter().map(evaluate_check).collect();
    println!("{}", serde_json::to_string(&MachineChecksOut { results }).map_err(|err| err.to_string())?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::glob_matches;

    #[test]
    fn glob_matches_regex_contract() {
        assert!(glob_matches("*.html", "a.html"));
        assert!(!glob_matches("*.html", "nested/a.html"));
        assert!(glob_matches("**/*.png", "a.png"));
        assert!(glob_matches("**/*.png", "nested/a.png"));
        assert!(glob_matches("**/*.png", "nested/deep/a.png"));
        assert!(!glob_matches("**/*.png", "a.jpg"));
        assert!(glob_matches("a/**/b.txt", "a/b.txt"));
        assert!(glob_matches("a/**/b.txt", "a/x/y/b.txt"));
        assert!(!glob_matches("a/**/b.txt", "a/xb.txt"));
        assert!(glob_matches("**/a", "/a"));
        assert!(!glob_matches("**/a", "ba"));
        assert!(glob_matches("report[1].html", "report[1].html"));
        assert!(!glob_matches("report[1].html", "report1.html"));
    }
}
