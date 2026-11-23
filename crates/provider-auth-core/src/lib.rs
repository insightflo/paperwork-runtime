//! provider-auth-core: metadata-only auth evidence probes for provider CLIs.
//! Never opens or reads credential file bytes (lstat/stat only), never spawns
//! processes, and contains no unsafe code.
#![forbid(unsafe_code)]

pub use paperclip_provider_runtime_core::ProviderId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Upper bound for a plausible credential file; anything larger is a probe error.
const MAX_CREDENTIAL_BYTES: u64 = 65_536;

/// Read-only environment snapshot consulted by the probes; injectable so tests
/// never mutate process env.
#[derive(Debug, Clone, Default)]
pub struct ProbeEnv {
    vars: BTreeMap<String, String>,
}
impl ProbeEnv {
    pub fn from_process() -> Self {
        Self { vars: std::env::vars_os().filter_map(|(k, v)| k.into_string().ok().zip(v.into_string().ok())).collect() }
    }
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        Self { vars: pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect() }
    }
    pub fn get(&self, key: &str) -> Option<&str> { self.vars.get(key).map(String::as_str) }
}

/// Metadata fingerprint of one credential path: size/mtime/inode only, never
/// content. Advisory — lstat+stat is not atomic, so a racing rename can blend
/// two states; not guaranteed content-change detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProbeMeta {
    pub exists: bool, pub is_symlink: bool, pub size_bytes: u64, pub mtime_epoch_ms: i64, pub inode: u64,
}

/// Evidence classification. `ProbeError` outranks every `*_present` verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalAuthEvidence {
    ApiKeyEnvPresent, CredentialFilePresent, ManagedEnvPresent, Missing, ProbeError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthStatus {
    pub provider: ProviderId,
    pub evidence: LocalAuthEvidence,
    #[serde(skip_serializing_if = "Option::is_none")] pub env_var: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub credential_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")] pub credential_meta: Option<FileProbeMeta>,
    #[serde(skip_serializing_if = "Option::is_none")] pub error_path: Option<PathBuf>,
    /// Auxiliary config paths observed (metadata only; never auth evidence).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub auxiliary_present: Vec<PathBuf>,
}

/// Pure structured description of how an operator logs in; nothing is spawned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginActionPlan {
    pub provider: ProviderId,
    pub command: String,
    pub args: Vec<String>,
    pub interactive: bool,
    pub notes: Vec<String>,
}
enum Probe {
    Hit(FileProbeMeta), Missing, Error,
}

fn mtime_ms(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX)).unwrap_or(0)
}
#[cfg(unix)]
fn inode_of(m: &std::fs::Metadata) -> u64 { use std::os::unix::fs::MetadataExt; m.ino() }
#[cfg(not(unix))]
fn inode_of(_: &std::fs::Metadata) -> u64 { 0 }

/// lstat the path — no open(). Missing -> Missing; a symlink is followed with
/// stat only (still no open) and ANY follow-up failure, including a dangling
/// link's NotFound, is Error. Non-regular, empty, oversized -> Error.
fn probe_path(path: &Path) -> Probe {
    let lm = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) => return if e.kind() == std::io::ErrorKind::NotFound { Probe::Missing } else { Probe::Error },
    };
    let is_symlink = lm.file_type().is_symlink();
    let m = if is_symlink {
        match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => return Probe::Error,
        }
    } else {
        lm
    };
    if !m.is_file() || !(1..=MAX_CREDENTIAL_BYTES).contains(&m.len()) { return Probe::Error; }
    Probe::Hit(FileProbeMeta { exists: true, is_symlink, size_bytes: m.len(), mtime_epoch_ms: mtime_ms(&m), inode: inode_of(&m) })
}

fn env_val<'a>(env: &'a ProbeEnv, key: &str) -> Option<&'a str> {
    env.get(key).filter(|v| !v.trim().is_empty())
}
fn dir_or_home(env: &ProbeEnv, key: &str, rel: &[&str]) -> Option<PathBuf> {
    if let Some(d) = env_val(env, key) { return Some(PathBuf::from(d)); }
    let mut p = PathBuf::from(env_val(env, "HOME")?);
    for seg in rel { p.push(seg); }
    Some(p)
}
fn credential_paths(p: ProviderId, env: &ProbeEnv) -> Vec<PathBuf> {
    let (dir, names): (Option<PathBuf>, &[&str]) = match p {
        ProviderId::Claude => (dir_or_home(env, "CLAUDE_CONFIG_DIR", &[".claude"]), &[".credentials.json", "credentials.json"]),
        ProviderId::Codex => (dir_or_home(env, "CODEX_HOME", &[".codex"]), &["auth.json"]),
        ProviderId::Pi => (dir_or_home(env, "PI_CODING_AGENT_DIR", &[".pi", "agent"]), &["auth.json"]),
        _ => (None, &[]),
    };
    dir.map(|d| names.iter().map(|n| d.join(n)).collect()).unwrap_or_default()
}
fn aux_paths(p: ProviderId, env: &ProbeEnv) -> Vec<PathBuf> {
    match p {
        ProviderId::Pi => dir_or_home(env, "PI_CODING_AGENT_DIR", &[".pi", "agent"]).map(|d| vec![d.join("models.json")]).unwrap_or_default(),
        ProviderId::Commandcode => env_val(env, "HOME").map(|h| PathBuf::from(h).join(".commandcode")).into_iter().collect(),
        _ => vec![],
    }
}
/// (env var, evidence when present, env outranks credential file)
fn env_rule(p: ProviderId) -> (Option<&'static str>, LocalAuthEvidence, bool) {
    use LocalAuthEvidence::*;
    match p {
        ProviderId::Claude => (Some("ANTHROPIC_API_KEY"), ApiKeyEnvPresent, true),
        ProviderId::Codex => (Some("OPENAI_API_KEY"), ApiKeyEnvPresent, true),
        ProviderId::Pi | ProviderId::Commandcode => (Some("PAPERCLIP_API_KEY"), ManagedEnvPresent, false),
        ProviderId::Devin => (None, Missing, false),
    }
}

/// Probe one provider. A probe error on ANY credential path always wins —
/// env credentials can never mask it.
pub fn probe_provider(provider: ProviderId, env: &ProbeEnv) -> ProviderAuthStatus {
    use LocalAuthEvidence::*;
    let (mut hit, mut error_path) = (None, None);
    for path in credential_paths(provider, env) {
        match probe_path(&path) {
            Probe::Hit(m) => { if hit.is_none() { hit = Some((path, m)); } }
            Probe::Missing => {}
            Probe::Error => { error_path = Some(path); break; }
        }
    }
    let (env_key, env_ev, env_first) = env_rule(provider);
    let env_hit = env_key.filter(|k| env_val(env, k).is_some());
    let evidence = if error_path.is_some() { ProbeError } else if env_first && env_hit.is_some() { env_ev } else if hit.is_some() { CredentialFilePresent } else if env_hit.is_some() { env_ev } else { Missing };
    ProviderAuthStatus {
        provider, evidence, error_path,
        env_var: env_hit.map(str::to_string),
        credential_path: hit.as_ref().map(|h| h.0.clone()),
        credential_meta: hit.map(|h| h.1),
        auxiliary_present: aux_paths(provider, env).into_iter().filter(|p| std::fs::symlink_metadata(p).is_ok()).collect(),
    }
}
pub fn probe_all(env: &ProbeEnv) -> Vec<ProviderAuthStatus> {
    [ProviderId::Claude, ProviderId::Codex, ProviderId::Pi, ProviderId::Commandcode, ProviderId::Devin].into_iter().map(|p| probe_provider(p, env)).collect()
}

/// Pure login-action metadata for operators; this crate never spawns it.
pub fn plan_login(provider: ProviderId) -> LoginActionPlan {
    let (command, args, interactive, notes): (&str, &[&str], bool, &[&str]) = match provider {
        ProviderId::Claude => ("claude", &["login"], true, &["Interactive sign-in; completes in the browser.", "Alternative: export ANTHROPIC_API_KEY."]),
        ProviderId::Codex => ("codex", &["auth", "login"], true, &["Interactive sign-in for the Codex CLI.", "Alternative: export OPENAI_API_KEY; auth.json lives under CODEX_HOME or ~/.codex."]),
        ProviderId::Pi => ("pi", &["auth", "login"], true, &["Interactive; pick the model provider to authenticate.", "Alternative: PAPERCLIP_API_KEY supplies managed auth."]),
        ProviderId::Commandcode => ("", &[], false, &["No local login: Commandcode auth is managed via PAPERCLIP_API_KEY.", "~/.commandcode is auxiliary config only, not a credential."]),
        ProviderId::Devin => ("", &[], false, &["Cloud-managed provider; no local credential or login applies."]),
    };
    LoginActionPlan { provider, command: command.into(), args: args.iter().map(|s| s.to_string()).collect(), interactive, notes: notes.iter().map(|s| s.to_string()).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use LocalAuthEvidence::*;
    fn tmp(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("pac-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    fn env_at(home: &Path, extra: &[(&str, &str)]) -> ProbeEnv {
        let mut p = vec![("HOME", home.to_str().unwrap())];
        p.extend_from_slice(extra);
        ProbeEnv::from_pairs(&p)
    }
    fn put(p: &Path, bytes: usize) { std::fs::create_dir_all(p.parent().unwrap()).unwrap(); std::fs::write(p, vec![b'x'; bytes]).unwrap(); }
    fn claude_cred(home: &Path) -> PathBuf { home.join(".claude").join(".credentials.json") }
    fn codex_auth(home: &Path) -> PathBuf { home.join(".codex").join("auth.json") }
    fn pi_dir(home: &Path) -> PathBuf { home.join(".pi").join("agent") }

    #[test]
    fn claude_env_then_file_then_missing() {
        let d = tmp("cl");
        assert_eq!(probe_provider(ProviderId::Claude, &env_at(&d, &[])).evidence, Missing);
        put(&claude_cred(&d), 10);
        let st = probe_provider(ProviderId::Claude, &env_at(&d, &[]));
        assert_eq!((st.evidence, st.credential_path.as_deref()), (CredentialFilePresent, Some(claude_cred(&d).as_path())));
        let st2 = probe_provider(ProviderId::Claude, &env_at(&d, &[("ANTHROPIC_API_KEY", "k")]));
        assert_eq!((st2.evidence, st2.env_var.as_deref()), (ApiKeyEnvPresent, Some("ANTHROPIC_API_KEY")));
    }
    #[test]
    fn claude_alt_name_and_config_dir() {
        let d = tmp("cl2");
        let cfg = d.join("cfg");
        put(&cfg.join("credentials.json"), 5);
        let st = probe_provider(ProviderId::Claude, &env_at(&d, &[("CLAUDE_CONFIG_DIR", cfg.to_str().unwrap())]));
        assert_eq!(st.evidence, CredentialFilePresent);
    }
    #[test]
    fn codex_env_file_symlink() {
        let d = tmp("cx");
        assert_eq!(probe_provider(ProviderId::Codex, &env_at(&d, &[("OPENAI_API_KEY", "k")])).evidence, ApiKeyEnvPresent);
        let real = d.join("real-auth.json");
        put(&real, 12);
        std::fs::create_dir_all(d.join(".codex")).unwrap();
        std::os::unix::fs::symlink(&real, codex_auth(&d)).unwrap();
        let st = probe_provider(ProviderId::Codex, &env_at(&d, &[]));
        assert_eq!(st.evidence, CredentialFilePresent);
        assert!(st.credential_meta.unwrap().is_symlink);
    }
    #[test]
    fn codex_dangling_symlink_is_probe_error() {
        let d = tmp("cx2");
        std::fs::create_dir_all(d.join(".codex")).unwrap();
        std::os::unix::fs::symlink(d.join("nope"), codex_auth(&d)).unwrap();
        let st = probe_provider(ProviderId::Codex, &env_at(&d, &[("OPENAI_API_KEY", "k")]));
        assert_eq!(st.evidence, ProbeError);
    }
    #[test]
    fn oversized_empty_and_fifo_are_probe_error() {
        let d = tmp("big");
        put(&claude_cred(&d), 65_537);
        assert_eq!(probe_provider(ProviderId::Claude, &env_at(&d, &[("ANTHROPIC_API_KEY", "k")])).evidence, ProbeError);
        let d2 = tmp("empty");
        put(&claude_cred(&d2), 0);
        assert_eq!(probe_provider(ProviderId::Claude, &env_at(&d2, &[])).evidence, ProbeError);
        let d3 = tmp("fifo");
        std::fs::create_dir_all(d3.join(".claude")).unwrap();
        assert!(std::process::Command::new("mkfifo").arg(claude_cred(&d3)).status().unwrap().success());
        assert_eq!(probe_provider(ProviderId::Claude, &env_at(&d3, &[("ANTHROPIC_API_KEY", "k")])).evidence, ProbeError);
    }
    #[test]
    fn pi_file_env_and_models_only() {
        let d = tmp("pi");
        assert_eq!(probe_provider(ProviderId::Pi, &env_at(&d, &[])).evidence, Missing);
        put(&pi_dir(&d).join("models.json"), 8);
        let st = probe_provider(ProviderId::Pi, &env_at(&d, &[]));
        assert_eq!(st.evidence, Missing);
        assert!(st.auxiliary_present.iter().any(|p| p.ends_with("models.json")));
        assert_eq!(probe_provider(ProviderId::Pi, &env_at(&d, &[("PAPERCLIP_API_KEY", "k")])).evidence, ManagedEnvPresent);
        put(&pi_dir(&d).join("auth.json"), 9);
        assert_eq!(probe_provider(ProviderId::Pi, &env_at(&d, &[("PAPERCLIP_API_KEY", "k")])).evidence, CredentialFilePresent);
    }
    #[test]
    fn pi_agent_dir_override() {
        let d = tmp("pi2");
        let pd = d.join("agent");
        put(&pd.join("auth.json"), 4);
        let st = probe_provider(ProviderId::Pi, &env_at(&d, &[("PI_CODING_AGENT_DIR", pd.to_str().unwrap())]));
        assert_eq!(st.evidence, CredentialFilePresent);
    }
    #[test]
    fn commandcode_managed_env_only() {
        let d = tmp("cc");
        assert_eq!(probe_provider(ProviderId::Commandcode, &env_at(&d, &[])).evidence, Missing);
        std::fs::create_dir_all(d.join(".commandcode")).unwrap();
        let st = probe_provider(ProviderId::Commandcode, &env_at(&d, &[]));
        assert_eq!((st.evidence, st.auxiliary_present.as_slice()), (Missing, &[d.join(".commandcode")][..]));
        assert_eq!(probe_provider(ProviderId::Commandcode, &env_at(&d, &[("PAPERCLIP_API_KEY", "k")])).evidence, ManagedEnvPresent);
    }
    #[test]
    fn probe_all_covers_five_and_devin_missing() {
        let all = probe_all(&env_at(&tmp("all"), &[]));
        assert_eq!(all.len(), 5);
        assert!(all.iter().all(|s| s.evidence == Missing));
    }
    #[test]
    fn plan_login_shapes() {
        let c = plan_login(ProviderId::Claude);
        assert_eq!((c.command.as_str(), c.interactive), ("claude", true));
        let x = plan_login(ProviderId::Codex);
        assert_eq!(x.args, vec!["auth".to_string(), "login".to_string()]);
        let p = plan_login(ProviderId::Pi);
        assert!(p.interactive && !p.notes.is_empty());
        let m = plan_login(ProviderId::Commandcode);
        assert!(m.command.is_empty() && !m.interactive && !m.notes.is_empty());
    }
}
