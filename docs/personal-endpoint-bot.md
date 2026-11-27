# Personal Endpoint Bot — 빠른 시작 / Quickstart & Security

`paperwork-bot`은 Paperwork 서버와 로컬 PC를 잇는 가벼운 Rust 네이티브 실행 파일입니다.
Mac/Linux/Windows용 모듈이 있으며, 허용 폴더의 파일 조회·쓰기·셸 실행을 제공합니다.
A lightweight native endpoint for folder-scoped local work connected to Paperwork.

**현재 범위 / Current boundary:** 설정·진단·스캔·감사 조회 CLI는 구현되어 있습니다.
개인 endpoint의 페어링·작업 폴링 모듈은 있지만, `main.rs`에 이를 시작하는 CLI는 없습니다.
아래 설치만으로 서버 연결이나 채널 작업 실행이 완료되지는 않습니다.
Setup works locally; end-to-end endpoint execution is not wired into this CLI yet.

## 1. 설치 / Install

저장소 루트에서 실행하세요. Bash, Rust/Cargo, 이미 존재하는 허용 폴더가 필요합니다.
Replace the example server and folder with your own values.

```bash
bash scripts/install-paperwork-bot.sh --server https://paperwork.example.com --name my-mac --folder "$HOME/work"
```

- 스크립트는 저장소에서 release 빌드를 수행합니다. 자동 다운로드는 하지 않습니다.
  저장소 밖에서는 `PATH`의 기존 `paperwork-bot`을 사용합니다.
- 지원: macOS/Linux, `arm64`/`aarch64`/`x86_64`. Windows용 Bash 설치 경로는 없습니다.
- 저장소 빌드 실행 파일: `target/release/paperwork-bot`.
- 설치 설정: `~/.paperwork-bot/config.json`; 디렉터리 `0700`, 파일 `0600`.
- 설치 옵션: `--server URL`, `--name NAME`, 반복 가능한 `--folder PATH`,
  `--pair-code CODE`, `-h`/`--help`.
  기본 서버는 `https://paperwork.insightflo.si`, 이름은 짧은 호스트명입니다.
- **주의 / Installer mismatch:** 스크립트가 출력하는 `install-service`는 CLI에 없습니다.
  `--pair-code`는 안내문만 출력하며, `init`에는 페어링 기능이 없습니다.
  출력된 next steps를 서비스 설치·페어링 완료 절차로 사용하지 마세요.

## 2. 실제 CLI / Exact commands

아래는 저장소 루트의 macOS/Linux 예시입니다. Windows에서는 준비된 `.exe`를 사용하세요.
`<...>`는 바꿔 넣을 값, `[...]`는 선택 항목입니다.

```text
paperwork-bot init --server <url> --name <endpoint> [--folder <path> ...] [--config <path>]
paperwork-bot detect-clis
paperwork-bot endpoint-doctor [--config <path>] [--json]
paperwork-bot endpoint-scan --folder <path> [--max-files <n>] [--max-depth <n>]
paperwork-bot endpoint-audit --log <path> [--limit <n>]
paperwork-bot render-service --os <macos|linux|windows> --server <url> --name <endpoint> [--binary <path>] [--config <path>]
```

### 설정·진단 / Configure & check

```bash
./target/release/paperwork-bot init --server https://paperwork.example.com --name my-mac --folder "$HOME/work"
./target/release/paperwork-bot detect-clis
./target/release/paperwork-bot endpoint-doctor --json
```

- `init`: JSON 설정을 기록하며 연결·페어링은 하지 않습니다. `--folder`는 반복 가능합니다.
  URL은 HTTPS, 로컬 개발만 `http://localhost` 또는 `http://127.0.0.1`을 허용합니다.
- `init`/`endpoint-doctor`/`render-service` 기본 설정은 `~/.paperwork/endpoint.json`입니다.
  홈은 `HOME`, 없으면 `USERPROFILE`을 사용합니다.
  설치 스크립트의 설정과 다르므로, 설치 설정을 검사하려면 아래처럼 지정하세요.

```bash
./target/release/paperwork-bot endpoint-doctor --config "$HOME/.paperwork-bot/config.json"
```

- `detect-clis`: `PATH`에서 `pi`, `claude`, `codex`, `agy`, `opencode`, `cursor`, `gemini`를
  탐색하고 가용 여부·경로를 JSON으로 출력합니다. 도구를 설치하거나 실행하지 않습니다.
- `endpoint-doctor`: 로컬 설정 권한·폴더 존재·설정 옆 `outbox/` 또는 부모의 쓰기 가능 여부를
  검사합니다. 기본은 사람이 읽는 요약, `--json`은 JSON입니다. 준비됨은 종료 코드 0, 실패는 1.
  네트워크 연결은 검사하지 않으며, CLI 미발견 경고만으로 실패하지 않습니다.
  설정의 폴더는 단순 경로 목록이므로 진단에서는 모두 `ro`로 취급합니다.

### 파일 스캔·감사 조회 / Scan & inspect audit

```bash
./target/release/paperwork-bot endpoint-scan --folder "$HOME/work" --max-files 500 --max-depth 3
./target/release/paperwork-bot endpoint-audit --log /absolute/path/to/audit.jsonl --limit 20
```

- 스캔은 경로·크기·수정 시각의 정렬된 JSON 목록입니다. 파일 내용은 읽지 않습니다.
  기본 상한은 50,000개·깊이 12입니다. `.git`, `node_modules`, `target`, `dist`, `.next`를
  건너뛰며, 상한에 걸리면 `truncated: true`입니다.
- `endpoint-scan`은 `--folder`를 직접 받으며 저장된 허용 폴더 설정을 읽지 않습니다.
- 감사 경로는 실제 로그 위치로 바꾸세요. CLI에 기본 감사 로그 경로는 없습니다.
  최근 항목 기본 20개를 오래된 순서로 출력합니다. 파일이 없으면 `[]`이며 만들지 않습니다.
  `--limit 0`은 빈 목록입니다. 조회 명령 자체가 실행 감사 기록을 생성하지는 않습니다.

### 서비스 텍스트 생성 / Render service text

```bash
./target/release/paperwork-bot render-service --os linux --server https://paperwork.example.com --name my-mac
```

`macos`는 LaunchAgent plist, `linux`는 systemd 사용자 서비스, `windows`는 PowerShell
예약 작업 등록 스크립트를 **표준 출력으로만** 생성합니다. 설치하거나 시작하지 않습니다.
`--binary` 기본값은 현재 실행 파일, `--config` 기본값은 위 endpoint 설정입니다.
**현재 생성물은 최상위 `--config`로 실행하도록 되어 있어 `main.rs`의 명령 구문과 맞지 않습니다.**
Generated service text is not a working autostart recipe for this CLI revision.

## 3. 폴더 권한과 보안 / Folder permissions & security

| 항목 / Control | 실제 동작 / Implemented behavior |
| --- | --- |
| `ro` (read only) | 허용 폴더 읽기·목록 조회. 쓰기와 셸 실행은 거절합니다. |
| `rw` (read/write) | 파일 읽기·쓰기·목록 조회와 해당 폴더에서의 셸 실행을 허용합니다. |
| 경로 제한 / Containment | 로컬 파일 도구는 실제 경로를 정규화하고 허용 루트 밖이면 거절합니다. 겹친 권한은 `ro`가 우선합니다. |
| 심볼릭 링크 / Symlinks | 스캔은 링크를 건너뛰고 링크인 루트를 거절합니다. 파일 도구는 링크의 실제 목적지가 허용 범위인지 검사합니다. |
| 셸 / Shell | Unix는 `sh -c`, Windows는 `cmd /C`. 작업 디렉터리에 `rw`가 필요합니다. |
| 파괴 명령 차단 / Destructive shell denylist | 현재 `local_tools::run_local_shell`에는 차단 목록이 없습니다. `rw`가 파괴 명령의 안전성을 보장하지 않습니다. |
| 자격증명·감사 / Credentials & audit | `endpoint_pairing` 자격증명 기록과 `AuditLogger` 로그는 Unix에서 `0600`입니다. Windows ACL을 설정하는 코드는 없습니다. |
| 비밀 가림 / Secret redaction | 감사 `summary`의 Bearer 값, `sk-`/`ghp_`/`xoxb-` 키, `key=`/`token=`/`password=` 값을 가립니다. 모든 필드·파일 내용의 비밀을 지우는 기능은 아닙니다. |

Fail-closed는 안전하게 허용 여부를 판단할 수 없으면 거절한다는 뜻입니다.
`init --folder`에는 `ro`/`rw` 지정 옵션이 없으며, 설정은 경로 문자열만 저장합니다.
권한 모드는 실행 모듈에 전달되는 `FolderGrant`의 값입니다. `--mode` 같은 옵션은 없습니다.
셸의 **작업 디렉터리만** 제한하며 명령 안의 절대 경로·네트워크 접근을 격리하지 않습니다.
Folder grants are not an OS sandbox. 실행 계정의 권한으로 명령이 동작합니다.

## 4. 협업 채널 / Collaboration channels

서버의 endpoint 채널 라우팅이 연결되고 기기가 페어링·온라인 상태인 환경에서의 문법입니다.
현재 CLI의 설치·`init`만으로 이 조건이 충족되지는 않습니다.
These are channel messages, not `paperwork-bot` CLI subcommands.

```text
@my-mac list /absolute/allowed/folder
@my-mac read /absolute/allowed/folder/README.md
@my-mac run /absolute/allowed/folder -- echo hello
```

`@<botName>`을 메시지 처음에 쓰고 한 줄로 보내세요. 이름에는 영문·숫자·`.`·`_`·`-`를 씁니다.
`run`은 작업 폴더와 명령 사이에 ` -- `가 필요하며 `rw` 권한이 필요합니다.
등록 이름·회사·온라인 상태·허용 폴더를 먼저 확인하세요.
“Queued task”는 접수이며 실행 완료가 아닙니다. 실제 결과를 별도로 확인하세요.

## 구현 근거 / Source reference

- [Installer](../scripts/install-paperwork-bot.sh), [CLI](../crates/bot-runtime/src/main.rs)
- [Config/service renderers](../crates/bot-runtime/src/service_install.rs), [Local tools](../crates/bot-runtime/src/local_tools.rs)
- [Doctor](../crates/bot-runtime/src/endpoint_doctor.rs), [Scan](../crates/bot-runtime/src/endpoint_watch.rs)
- [Credentials](../crates/bot-runtime/src/endpoint_pairing.rs), [Audit](../crates/bot-runtime/src/endpoint_audit.rs)
- [Channel syntax](../server/src/services/endpoint-channel-dispatch.ts)
