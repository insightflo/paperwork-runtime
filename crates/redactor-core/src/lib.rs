//! redactor-core: fail-closed streaming secret redactor.
//! Line/record-buffered: partial lines and unclosed PEM blocks are never
//! flushed; buffer/scan limits, invalid UTF-8 and an unclosed PEM block at
//! finish() degrade to `[redacted-unscanned]` rather than leaking raw input.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

const REDACTED: &str = "[redacted]";
const UNSCANNED: &str = "[redacted-unscanned]";
const MIN_EXTRA_SECRET_LEN: usize = 6;
macro_rules! re { ($p:expr) => { LazyLock::new(|| Regex::new($p).expect("valid static regex")) } }
static API_TOKEN_RE: LazyLock<Regex> = re!(r"sk-[A-Za-z0-9._-]{8,}");
static GITHUB_RE: LazyLock<Regex> = re!(r"(?:ghp_|github_pat_)[A-Za-z0-9._-]{8,}");
static AWS_RE: LazyLock<Regex> = re!(r"AKIA[A-Z0-9]{16}");
static BEARER_RE: LazyLock<Regex> = re!(r"(?i)Bearer[ \t]+[A-Za-z0-9._~+/=-]{8,}");
static JWT_RE: LazyLock<Regex> = re!(r"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*");
static URL_CRED_RE: LazyLock<Regex> = re!(r#"(?i)[a-z][a-z0-9+.-]{1,31}://[^\s"'<>@/]{1,256}:[^\s"'<>@/]{1,512}@[^\s"'<>]*"#);
static PEM_SPAN_RE: LazyLock<Regex> = re!(r"(?s)-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----.*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----");
static PEM_BEGIN_RE: LazyLock<Regex> = re!(r"-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----");
static PEM_END_RE: LazyLock<Regex> = re!(r"-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----");
static ASSIGN_RE: LazyLock<Regex> = re!(r#"(?i)[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password)[A-Za-z0-9_.-]*["']?\s*[=:]\s*["']?([^\s"',;)\]}]{4,})"#);
static PATTERNS: &[&LazyLock<Regex>] = &[&API_TOKEN_RE, &GITHUB_RE, &AWS_RE, &BEARER_RE, &JWT_RE, &URL_CRED_RE, &PEM_SPAN_RE];

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactorConfig {
    /// Literal secrets redacted verbatim; entries shorter than 6 bytes are ignored.
    #[serde(default)]
    pub extra_secrets: Vec<String>,
    /// Fail closed when retained unflushed input exceeds this many bytes.
    pub max_buffer_bytes: Option<usize>,
    /// Fail closed on the unscanned tail of a record larger than this many bytes.
    pub max_scan_bytes: Option<usize>,
}

/// Buffers input into complete records (a `\n`-terminated line, or a PEM block
/// spanning its `-----BEGIN` line through the line containing the matching
/// `-----END ... PRIVATE KEY-----` marker) and redacts each record atomically.
pub struct StreamingRedactor {
    cfg: RedactorConfig,
    extra: Vec<String>,
    buf: String,
    pending: Vec<u8>,
    pem_from: Option<usize>,
    pem_hold: Option<usize>,
}

impl StreamingRedactor {
    pub fn new(cfg: RedactorConfig) -> Self {
        let mut extra: Vec<String> = cfg.extra_secrets.iter().filter(|s| s.len() >= MIN_EXTRA_SECRET_LEN).cloned().collect();
        extra.sort_unstable(); extra.dedup();
        Self { extra, cfg, buf: String::new(), pending: Vec::new(), pem_from: None, pem_hold: None }
    }
    pub fn push_chunk(&mut self, chunk: &str) -> String { self.buf.push_str(chunk); self.drain() }
    /// Accepts arbitrary bytes: an incomplete UTF-8 tail is held for the next
    /// call and each invalid sequence fails closed to `[redacted-unscanned]`.
    pub fn push_bytes(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut pending = std::mem::take(&mut self.pending);
        let mut off = 0usize;
        while off < pending.len() {
            match std::str::from_utf8(&pending[off..]) {
                Ok(s) => { self.buf.push_str(s); off = pending.len(); }
                Err(e) => {
                    let valid = off + e.valid_up_to();
                    if let Ok(s) = std::str::from_utf8(&pending[off..valid]) { self.buf.push_str(s); }
                    match e.error_len() {
                        Some(bad) => { self.buf.push_str(UNSCANNED); off = valid + bad; }
                        None => { off = valid; break; }
                    }
                }
            }
        }
        self.pending = pending.split_off(off);
        self.drain()
    }
    /// Flush the remainder: complete records first, then the held tail. An
    /// unclosed PEM block or leftover non-UTF-8 bytes fail closed unscanned.
    pub fn finish(&mut self) -> String {
        let mut out = self.drain();
        if !self.pending.is_empty() { self.pending.clear(); self.buf.push_str(UNSCANNED); }
        if self.pem_from.is_some() {
            self.buf.clear(); out.push_str(UNSCANNED);
        } else {
            let rest = std::mem::take(&mut self.buf);
            out.push_str(&self.scan_record(&rest));
        }
        self.pem_from = None; self.pem_hold = None;
        out
    }
    fn drain(&mut self) -> String {
        let mut out = String::new();
        while let Some(end) = self.record_end() {
            out.push_str(&self.scan_record(&self.buf[..end]));
            self.buf.drain(..end);
        }
        if self.buf.len() > self.cfg.max_buffer_bytes.unwrap_or(usize::MAX) {
            self.buf.clear(); self.pem_from = None; self.pem_hold = None; out.push_str(UNSCANNED);
        }
        out
    }
    /// End offset of the next complete record inside `buf`, or `None` to wait
    /// for more input. After an END marker the block record still extends to
    /// the next `\n`; a same-line second BEGIN starts a new PEM search.
    fn record_end(&mut self) -> Option<usize> {
        if let Some(hold) = self.pem_hold {
            let i = self.buf[hold..].find('\n')?;
            self.pem_hold = None;
            return match PEM_BEGIN_RE.find(&self.buf[hold..hold + i]) {
                Some(b) => { self.pem_from = Some(hold + b.end()); self.record_end() }
                None => Some(hold + i + 1),
            };
        }
        if let Some(from) = self.pem_from {
            return match PEM_END_RE.find_at(&self.buf, from) {
                Some(m) => { self.pem_from = None; self.pem_hold = Some(m.end()); self.record_end() }
                None => None,
            };
        }
        let nl = self.buf.find('\n')?;
        match PEM_BEGIN_RE.find(&self.buf[..nl]) {
            Some(b) => { self.pem_from = Some(b.end()); self.record_end() }
            None => Some(nl + 1),
        }
    }
    fn scan_record(&self, rec: &str) -> String {
        let limit = self.cfg.max_scan_bytes.unwrap_or(usize::MAX);
        if rec.len() <= limit { return redact(rec, &self.extra); }
        let mut cut = limit;
        while !rec.is_char_boundary(cut) { cut -= 1; }
        format!("{}{}", redact(&rec[..cut], &self.extra), UNSCANNED)
    }
}

/// Replace every merged secret span in `text` with `[redacted]`.
fn redact(text: &str, extra: &[String]) -> String {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for re in PATTERNS { spans.extend(re.find_iter(text).map(|m| (m.start(), m.end()))); }
    for c in ASSIGN_RE.captures_iter(text) { if let Some(v) = c.get(1) { spans.push((v.start(), v.end())); } }
    for lit in extra { spans.extend(text.match_indices(lit.as_str()).map(|(i, _)| (i, i + lit.len()))); }
    if spans.is_empty() { return text.to_string(); }
    spans.sort_unstable();
    let (mut out, mut pos) = (String::with_capacity(text.len()), 0usize);
    let (mut s0, mut e0) = spans[0];
    for &(s, e) in &spans[1..] {
        if s <= e0 { e0 = e0.max(e); continue; }
        out.push_str(&text[pos..s0]); out.push_str(REDACTED); pos = e0; s0 = s; e0 = e;
    }
    out.push_str(&text[pos..s0]); out.push_str(REDACTED); out.push_str(&text[e0..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(extra: &[&str]) -> StreamingRedactor { StreamingRedactor::new(RedactorConfig { extra_secrets: extra.iter().map(|s| (*s).to_string()).collect(), ..Default::default() }) }
    fn rl(max_scan_bytes: Option<usize>, max_buffer_bytes: Option<usize>) -> StreamingRedactor { StreamingRedactor::new(RedactorConfig { max_scan_bytes, max_buffer_bytes, ..Default::default() }) }
    fn go(rd: &mut StreamingRedactor, chunks: &[&str]) -> String { let mut o = String::new(); for c in chunks { o.push_str(&rd.push_chunk(c)); } o.push_str(&rd.finish()); o }

    #[test] fn builtins_and_nonsecrets() {
        let input = concat!(
            "tok sk-ant-abc123def456\n", "ghp_abcdefghiJ123\n", "AKIAIOSFODNN7EXAMPLE\n",
            "Authorization: Bearer abcdef123456\n", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0fQ.sig0\n",
            "postgres://u:p@h:5432/db\n", "API_KEY=topsecretvalue\n", "plain line\n",
        );
        let expected = concat!(
            "tok [redacted]\n", "[redacted]\n", "[redacted]\n", "Authorization: [redacted]\n",
            "jwt [redacted]\n", "[redacted]\n", "API_KEY=[redacted]\n", "plain line\n",
        );
        assert_eq!(go(&mut r(&[]), &[input]), expected);
    }
    #[test] fn db_url_across_tiny_chunks() {
        let mut url = String::from("postgres://svc_user:s3cret_pw@db.internal:5432/appdb?");
        while url.len() < 350 { url.push_str("&opt=aaaaaaaaaa"); }
        url.truncate(350); assert_eq!(url.len(), 350);
        let (mut rd, mut o) = (r(&[]), String::new());
        for ch in format!("{url}\n").as_bytes().chunks(7) { o.push_str(&rd.push_bytes(ch)); }
        o.push_str(&rd.finish());
        assert_eq!(o, "[redacted]\n");
    }
    #[test] fn overlapping_literals_merge() {
        assert_eq!(go(&mut r(&["secret_token_alpha", "token_alpha_beta"]), &["xx secret_token_alpha_beta yy\n"]), "xx [redacted] yy\n");
        assert_eq!(go(&mut r(&["abc", "abcde", "abcdef"]), &["abc abcde abcdef\n"]), "abc abcde [redacted]\n");
    }
    #[test] fn literal_overlapping_pem_end_across_chunks() {
        let mut rd = r(&["KEY-----tail99"]); let mut o = String::new();
        for c in ["pre\n-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE K", "EY-----tail99", "\npost\n"] { o.push_str(&rd.push_chunk(c)); }
        o.push_str(&rd.finish());
        assert_eq!(o, "pre\n[redacted]\npost\n");
    }
    #[test] fn pem_end_waits_for_newline() {
        let mut rd = r(&[]);
        assert_eq!(rd.push_chunk("-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----"), "");
        assert_eq!(rd.push_chunk("+rest"), "");
        assert_eq!(rd.push_chunk("\n"), "[redacted]+rest\n");
    }
    #[test] fn scan_limit_cuts_mid_match() {
        let line = format!("padpad sk-ant-{}\n", "x".repeat(80));
        assert_eq!(go(&mut rl(Some(40), None), &[&line]), "padpad [redacted][redacted-unscanned]");
    }
    #[test] fn buffer_limit_fails_closed() {
        let mut rd = rl(None, Some(10));
        assert_eq!(rd.push_chunk("abcdefghij"), "");
        assert_eq!(rd.push_chunk("k"), "[redacted-unscanned]");
        assert_eq!(rd.push_chunk("after\n"), "after\n");
    }
    #[test] fn unclosed_pem_fails_closed_at_finish() {
        let mut rd = r(&[]);
        assert_eq!(rd.push_chunk("ok\n-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n"), "ok\n");
        assert_eq!(rd.finish(), "[redacted-unscanned]");
    }
    #[test] fn split_utf8_and_invalid_bytes() {
        let mut rd = r(&[]); let mut o = String::new();
        assert_eq!(rd.push_bytes(b"a\xe2\x82"), "");
        o.push_str(&rd.push_bytes(b"\xac\xffb\n"));
        assert_eq!(o, "a€[redacted-unscanned]b\n");
        o.push_str(&rd.push_bytes(b"c\xfe"));
        o.push_str(&rd.finish());
        assert_eq!(o, "a€[redacted-unscanned]b\nc[redacted-unscanned]");
    }
}
