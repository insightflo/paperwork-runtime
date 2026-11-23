use paperclip_claude_quota_pty::{PtyProbeSpec, ScheduledInput};

pub(super) fn probe_spec() -> Result<PtyProbeSpec, String> {
    let mut args = std::env::args_os().skip(1);
    let timeout_ms = match args.next() {
        None => 12000,
        Some(flag) if flag == "--timeout-ms" => args
            .next()
            .and_then(|value| value.to_str()?.parse::<u64>().ok())
            .ok_or("--timeout-ms needs an unsigned integer")?
            .clamp(1000, 60000),
        Some(flag) => return Err(format!("unknown flag: {flag:?}")),
    };
    if let Some(flag) = args.next() {
        return Err(format!("unexpected argument: {flag:?}"));
    }
    let program = match std::env::var("CLAUDE_CLI_PATH") {
        Ok(path) if std::path::Path::new(&path).is_absolute() => path,
        Err(std::env::VarError::NotPresent) => "claude".into(),
        _ => return Err("CLAUDE_CLI_PATH must be a non-empty absolute UTF-8 path".into()),
    };
    Ok(PtyProbeSpec {
        program,
        args: vec!["--tools".into(), "".into()],
        timeout_ms,
        strip_anthropic_env: true,
        inputs: [(2000, &b"/usage\r"[..]), (8000, b"\x1b"), (9000, b"\x03")]
            .into_iter()
            .map(|(delay_ms, bytes)| ScheduledInput { delay_ms, bytes: bytes.to_vec() })
            .collect(),
    })
}
