# Bot Runtime Security & Redaction Ownership Contract / 봇 런타임 보안·마스킹 책임 계약

Status: Contributor contract (documentation only, no runtime effect)
Last updated: 2026-11-27
Audience: Operators of `paperwork-bot` (Rust daemon) and maintainers of the TypeScript server
Source of truth: `crates/bot-runtime/src/{client,token,executor,control_sock,state,main}.rs`, `crates/ops-control/src/lib.rs`

## 1. Loopback-only HTTP transport / 루프백 전용 HTTP 전송

EN
- `paperwork-bot` uses a zero-dependency `std::net::TcpStream` client (`client.rs::parse_http_url`). It accepts only `http://`; any `https://` base URL is rejected by design with the message `https:// is not supported by the zero-dependency stdlib client; route through localhost/http proxy`.
- The supported deployment is a loopback target: `http://127.0.0.1:3100` (default) or `http://localhost:3100`, i.e. the daemon and the API server share a host. No TLS is terminated inside the daemon.
- Remote or TLS-required deployments must put a local TLS-terminating proxy (loopback `http://` -> remote `https://`) in front of the daemon. The daemon never speaks TLS itself.
- Note: the URL parser validates scheme, host, and port but does not assert that `host` is loopback. "Loopback-only" is an operational contract enforced by configuration (`--server`), not by a host allow-list in code. Tokens must therefore never be pointed at an untrusted `http://` host.

KO
- `paperwork-bot`은 의존성 없는 `std::net::TcpStream` 클라이언트(`client.rs::parse_http_url`)를 쓰며 `http://`만 허용한다. `https://` 기본 URL은 설계상 거부되고 "localhost/http 프록시를 경유하라"는 오류를 낸다.
- 지원 배포는 루프백 대상이다: 기본값 `http://127.0.0.1:3100` 또는 `http://localhost:3100`. 데몬과 API 서버가 같은 호스트에 있고, 데몬 내부에서 TLS를 종료하지 않는다.
- 원격 또는 TLS 필수 환경은 데몬 앞에 로컬 TLS 종료 프록시(루프백 `http://` -> 원격 `https://`)를 둔다. 데몬은 스스로 TLS를 사용하지 않는다.
- 주의: URL 파서는 스킴·호스트·포트만 검증하고 호스트가 루프백인지 코드로 강제하지 않는다. "루프백 전용"은 `--server` 설정으로 지키는 운영 계약이므로, 신뢰할 수 없는 `http://` 호스트를 가리키면 안 된다.

## 2. Secret redaction ownership / 비밀값 마스킹 책임

EN
- Authoritative for raw terminal environment and child output: the Rust daemon. `executor.rs::redact_stream_bytes` runs every stdout/stderr chunk through `paperclip_redactor_core::StreamingRedactor` (seeded with the active `PAPERWORK_TERMINAL_TOKEN` / `PAPERWORK_BOT_TOKEN` values, fail-closed to `[redacted-unscanned]` on invalid UTF-8 or scan-limit overrun) and then applies `token.rs::redact_secrets` (`pcp_term_*`, `pcp_bot_*`, `Bearer *`). Child processes are spawned with `env_clear`, so token env vars never reach them.
- Defense-in-depth only: the TypeScript server. `server/src/services/bot-terminal-channel.ts` keeps `RAW_TOKEN_VALUE_PATTERN` (`pcp_term_|pcp_bot_`) and an `AUDIT_SENSITIVE_KEY_PATTERN` for audit payloads. This never substitutes for daemon-side redaction; it must not be relaxed on the assumption that the daemon "already handled it".
- Tokens are never accepted as CLI arguments (`main.rs::cmd_verify_token` rejects `--token` and any argv starting with `pcp_`), never printed, and `state.json` refuses to persist anything matching a raw token or bearer value (`state.rs::contains_forbidden_secret`).
- Verification: SHA-256 hex digest, constant-time compare (`token.rs::verify_token_sha256`).

KO
- 원천 터미널 환경·자식 프로세스 출력의 마스킹은 Rust 데몬이 권위자다. `executor.rs::redact_stream_bytes`는 모든 stdout/stderr 청크를 `StreamingRedactor`(활성 토큰 값을 시드로 사용, 잘못된 UTF-8이나 스캔 한도 초과 시 `[redacted-unscanned]`으로 실패 폐쇄)에 통과시킨 뒤 `token.rs::redact_secrets`(`pcp_term_*`, `pcp_bot_*`, `Bearer *`)을 적용한다. 자식 프로세스는 `env_clear`로 실행되어 토큰 환경변수를 받지 못한다.
- TypeScript 서버(`bot-terminal-channel.ts`의 `RAW_TOKEN_VALUE_PATTERN`, `AUDIT_SENSITIVE_KEY_PATTERN`)는 심층 방어일 뿐이며 데몬 쪽 마스킹을 대체하지 않는다. "데몬이 이미 처리했다"는 이유로 완화하지 않는다.
- 토큰은 CLI 인자로 받지 않고(`--token`, `pcp_`로 시작하는 인자 거부), 출력하지 않으며, `state.json`도 원본 토큰·Bearer 값을 포함하면 저장을 거부한다.
- 검증은 SHA-256 hex 다이제스트 + 상수 시간 비교(`verify_token_sha256`)다.

## 3. UDS control socket and atomic state / UDS 제어 소켓과 원자적 상태 저장

EN
- Control socket path: `$XDG_RUNTIME_DIR/paperwork-bot/<terminal-id>/control.sock` (absolute `XDG_RUNTIME_DIR` required; falls back to the temp dir). Commands: `status`, `drain`, `shutdown` as JSON lines.
- Directory contract (`control_sock.rs::ensure_and_validate_socket_dir` + `ops-control::validate_control_socket_dir`): created with mode `0700`; canonicalized; leaf must be owned by the effective uid and have mode exactly `0700`; every ancestor is opened `O_NOFOLLOW` (symlink anywhere fails closed) and must be owned by root or the euid and not group/world-writable unless sticky. A pre-existing `0755` directory is rejected, not fixed.
- Socket file: created via `UnixListener::bind`, then `chmod 0600`. An existing non-socket file at that path is never overwritten.
- State persistence (`state.rs::save_state_atomic`): serialize -> refuse raw secrets -> write `.<name>.<nonce>.tmp` with `create_new` + mode `0600` -> `sync_all` -> re-assert `0600` -> `rename` over `state.json` -> `fsync` parent dir. The temp file is removed on any failure. Parent directories are created `0700`.
- Wire-prefix compatibility: the daemon and server today issue and validate only `pcp_term_*` and `pcp_bot_*`. The bare `pcp_<hex>` prefix still issued for legacy agent API keys (`server/src/services/agents.ts::createToken`) is accepted by the server's agent-auth path but is not a bot/terminal token. Prefix redactors match `pcp_term_`/`pcp_bot_` only, so a bare `pcp_` value is masked only via `Bearer ` handling or the daemon's `extra_secrets` seeding. Do not introduce new bare-`pcp_` tokens on the bot wire.

KO
- 제어 소켓 경로는 `$XDG_RUNTIME_DIR/paperwork-bot/<terminal-id>/control.sock`(절대 경로 요구, 없으면 임시 디렉터리)이며 `status`/`drain`/`shutdown` JSON 명령을 받는다.
- 디렉터리 계약: `0700`으로 생성·정규화하고, 말단은 euid 소유·모드 정확히 `0700`, 모든 상위 경로는 `O_NOFOLLOW`로 열어 심링크가 있으면 실패 폐쇄, root 또는 euid 소유이며 그룹/기타 쓰기 금지(sticky 제외). 이미 `0755`인 디렉터리는 고치지 않고 거부한다.
- 소켓 파일은 바인드 후 `0600`으로 설정하며, 그 경로에 소켓이 아닌 파일이 있으면 덮어쓰지 않는다.
- 상태 저장: 직렬화 -> 원본 비밀값 거부 -> `0600` 임시 파일(`create_new`) -> `sync_all` -> `0600` 재확인 -> `rename` -> 부모 디렉터리 `fsync`. 실패 시 임시 파일을 제거한다.
- 와이어 접두사 호환: 봇/터미널 토큰은 `pcp_term_*`/`pcp_bot_*`만 유효하다. 레거시 에이전트 API 키용 bare `pcp_<hex>`(`agents.ts::createToken`)는 에이전트 인증 경로에서만 받으며 봇 와이어 토큰이 아니다. 접두사 마스커는 두 접두사만 매치하므로 bare `pcp_` 값은 `Bearer ` 처리나 `extra_secrets` 시드로만 가려진다. 봇 와이어에 bare `pcp_` 토큰을 새로 도입하지 않는다.

## 4. `eval-policy` parity oracle / `eval-policy` 패리티 오라클

EN
- `paperwork-bot eval-policy` reads a `PolicyEvalRequest` JSON from stdin and prints a deterministic `GovernanceDecision`. It is a test-time parity oracle for `server/src/__tests__/bot-governance-rust-parity.test.ts` (skipped when cargo/the binary is unavailable).
- Live server governance stays in TypeScript. The request path must not `execFileSync`/`spawnSync` the Rust binary per request; spawning is confined to that test.

KO
- `eval-policy`는 표준입력의 `PolicyEvalRequest` JSON을 결정적 `GovernanceDecision`으로 출력하며, 패리티 테스트(바이너리 없으면 건너뜀)의 테스트 시점 오라클이다.
- 실제 서버 거버넌스는 TypeScript에 남고, 요청 경로에서 Rust 바이너리를 요청마다 spawn하지 않는다. spawn은 해당 테스트로 한정된다.
