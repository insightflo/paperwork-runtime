# Workflow Harness & Selective Rust Architecture

Status: Architecture reference
Last updated: 2026-11-27
Audience: Runtime maintainers, reviewers, and operators

이 문서는 Papercompany 런타임의 두 가지 설계 축을 정리한다: (1) Rust와 TypeScript의
역할 경계, (2) 워크플로 실행 하네스의 기본 요소와 `BOT_GOVERNANCE_ENGINE` 출시 절차.

This document defines two design axes of the Papercompany runtime: (1) the Rust/TypeScript
boundary, and (2) the workflow execution harness primitives and the `BOT_GOVERNANCE_ENGINE`
rollout.

## 1. Selective Rust vs TypeScript boundary

Rust는 **결정론(determinism)과 프로세스 격리**이 필요한 좁은 영역에만 쓴다.
나머지 전부는 TypeScript로 둔다. / Rust is used only where determinism and process
isolation are mandatory; everything else stays in TypeScript.

| Domain | Language | Home | Reason |
| --- | --- | --- | --- |
| Bot daemon, UDS control socket, channel/terminal relay | Rust | `crates/bot-runtime` | Long-lived process, fail-closed control plane |
| Process supervisor (isolated env, crash-loop backoff, PID tracking) | Rust | `crates/process-supervisor` | Child lifecycle must survive the TS event loop |
| Streaming secret redactor (chunk-safe across boundaries) | Rust | `crates/redactor-core`, `log-redactor` | Same rules for live streams and persisted logs |
| Deterministic governance policy (bot kind / callable-by rank) | Rust | `crates/bot-runtime` (`governance.rs`) | Pure function, snapshot-testable, no LLM input |
| EWMA attribution gate | Rust | `crates/bot-runtime` | Fixed-point math, identical on every platform |
| CRUD, REST API, RBAC, activity logging | TypeScript | `server/`, `packages/` | Fast iteration, Drizzle schema coupling |
| UI, board, dashboards | TypeScript | `ui/` | Browser target only |

경계 규칙 / Boundary rules:

- Rust 크레이트는 **계약(contract)만** 노출한다: versioned JSON over UDS or a typed TS
  client. No shared DB access from Rust unless the crate already owns that table.
- TypeScript은 Rust 결과를 **표시·기록**할 뿐이다. Rust가 내린 판정을 TS에서 재해석하지
  않는다. / TypeScript displays and records Rust verdicts; it never re-interprets them.
- 계약은 **Paperwork-native clean-room**으로 작성한다. 외부 프로젝트의 소스, 상수, 테이플
  픽스처를 복사하지 않는다. 참조는 동작 사양(spec) 수준에서만 한다. Every contract is
  authored clean-room from the written specification; no source, constants, or fixtures
  are copied from external projects.
- 새 Rust 크레이트는 위 표의 역할 중 하나에 들어가지 않으면 TS로 시작한다. A new Rust
  crate must map to one of the rows above; otherwise start in TypeScript.

## 2. Workflow execution harness primitives

하네스는 미션 실행 중 에이전트 호출을 어떻게 보내고, 언제 끊고, 언제 막을지를 정한다.
모든 판정은 구조화된 레코드에서 나온다. / The harness decides how agent calls are
routed, when they are cut off, and when they are blocked. Every verdict derives from a
structured record.

### 2.1 Dispatch routing

| Route | When | Effect |
| --- | --- | --- |
| `sharp` | Task is well-specified, single-owner | One agent, one worktree, no advisor |
| `split` | Task has ≥2 independent sub-goals | Fan-out to N workers; each owns disjoint files |
| `escalate_advisor` | Ambiguity, cross-repo impact, or repeated rework | Pause dispatch; request an advisor review first |

라우팅 입력은 기계 판독 가능한 필드만 사용한다 (scope flags, file list, rework count).
자연어 프롬프트에서 라우트를 추론하지 않는다. / Routing consumes only machine-readable
fields; it is never inferred from prompt prose.

### 2.2 Stall watchdog

| State | Threshold | Meaning | Action |
| --- | --- | --- | --- |
| `stalled` | 5 min with no heartbeat progress | Worker alive but not advancing | Emit warning; advisor may be requested |
| `timed_out` | 15 min total | Hard stop | Cancel, record structured timeout, bounded re-dispatch |

"Progress" means a new structured heartbeat record, not stdout activity. 자연어 출력은
진행 증거가 아니다. / Natural-language output is never progress evidence.

### 2.3 Advisor gates (fail-closed, JSON-only)

Three gates sit between an advisor and execution. An advisor submits a **versioned,
schema-validated JSON** verdict; anything else is rejected.

| Gate | Checks | On failure |
| --- | --- | --- |
| `G1` | Schema and version of the advisor submission | Reject; do not parse |
| `G2` | Verdict value is in the allowed enum and bound to the current run/step | Reject; re-dispatch within the existing retry budget |
| `G3` | Required evidence fields are present and non-stale | Reject; block the step as unresolved |

금지: 마커 문자열, 제목 키워드, 코드 블록에서 JSON 추출, 정규식 폴백. 마크다운·주석·
stdout/stderr은 표시용일 뿐이며 실행 권한이 없다. / Forbidden: marker strings,
title keywords, JSON extraction from prose, regex fallbacks. Markdown, comments, and
stdout/stderr are display-only and carry no execution authority.

### 2.4 EWMA attribution

신뢰 가중치는 지수 가중 이동 평균으로 계산한다. / Trust weights use an exponentially
weighted moving average.

- `gamma = 0.92`: previous weight retained per observation.
- `verifier-reject weight = 2.0`: a rejected verification counts twice a normal outcome.
- Update: `w' = gamma * w + (1 - gamma) * (2.0 if rejected else 1.0)`.
- 산출값은 라우팅 입력일 뿐이다. 임계값 통과가 자동 승인을 만들지 않는다. / The output
  is a routing input only; crossing a threshold never grants approval by itself.

## 3. `BOT_GOVERNANCE_ENGINE` rollout

환경 변수 하나로 거버넌스 평가기를 선택한다. / A single environment variable selects
the governance evaluator.

| Value | Behavior |
| --- | --- |
| `node` (default) | TypeScript evaluator is authoritative |
| `shadow` | Rust evaluator runs in parallel; TS stays authoritative; divergences are logged |
| `rust` | Rust evaluator is authoritative; any Rust error **fails closed** (deny) |

알 수 없는 값은 `rust`와 같게 fail-closed 처리한다. / Unknown values fail closed as `rust`.

출시 단계 / Rollout steps:

1. **Baseline** — run `node` in all environments; record governance decisions with a
   schema-version tag so later comparison is exact.
2. **Shadow** — enable `shadow` on one company; compare Rust vs TS verdicts; any
   divergence is a blocking defect, not a warning to tune away.
3. **Expand** — extend `shadow` to all companies; require zero divergence for the agreed
   observation window.
4. **Cut over** — switch to `rust`; keep `node` reachable by rollback only.
5. **Retire** — remove the TS evaluator once `rust` has been the sole authority for a full
   release cycle.

각 단계는 명시적 승인 지점에서 멈춘다. 자동 진행은 없다. / Each step stops at an
explicit approval point; nothing advances automatically.

## 4. Related documents

- `doc/SPEC-implementation.md` — V1 build contract
- `doc/operations/runtime-readiness-boundaries.md` — engine cutover readiness
- `docs/agents-runtime.md` — heartbeat execution model
