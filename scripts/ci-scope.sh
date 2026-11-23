#!/usr/bin/env bash
# [CI-REDUCE 2026-11-13] PR CI 범위 판정기 — 이번 이벤트에서 무엇을 돌릴지 한 곳에서 정한다.
#
# 왜: pr.yml 은 PR push 마다 전량을 돌렸다(성공 run 40~45분). 이 스크립트가 판정을 소유하고
#   pr.yml 은 출력만 소비한다. 판정 규칙을 워크플로 `if:` 에 복제하지 않는다(행렬 시험이 실제 경로를 검증 못 함).
#
# 판정 순서(계약 — 순서 자체가 의미를 갖는다):
#   ① EVENT_NAME=workflow_dispatch, INPUT_SCOPE=full  → fast=heavy=full=true (수동 전체 실행)
#   ② EVENT_NAME=workflow_dispatch, 그 밖(policy)     → fast=heavy=true, full=false (lockfile 봇 경로)
#   ③ EVENT_ACTION=labeled ∧ EVENT_LABEL≈CI_FULL_LABEL(대소문자 무시)
#                                                     → fast=heavy=full=true, consume_label=true (**one-shot** — 드래프트여도 실행)
#   ④ PR_DRAFT=true                                   → 전부 false
#   ⑤ EVENT_ACTION=ready_for_review                   → fast=heavy=full=true
#   ⑥ 그 밖(opened/synchronize/reopened/무관 labeled)  → fast=heavy=true, full=false
#   ⑦ 변경 파일이 전부 문서                            → heavy=false, full=false (①을 제외)
#
# 라벨은 one-shot: 라벨을 단 이벤트(③)만 전체 스위트를 켜고 pr.yml 이 라벨을 떼낸다(consume_label).
#   이후 push·무관 labeled 는 ci-full 이 PR_LABELS 에 남아 있어도 ⑥으로만 판정한다.
#   ③을 ④보다 앞에 두는 이유: 가드 통과 전 gh pr ready 에 도달 못 하므로 라벨을 드래프트로 막으면 영구 미병합.
#
# rust_changed: false 는 "Rust 무관" 증명이 있을 때만 — RUST_CHANGED_FILE_LIST 가 존재·비어있지 않고,
#   비어있지 않은 줄이 1개 이상이며, Git-quote 된 경로(^".*"$)가 0개이고, Rust 경로 패턴 매치가 0개일 때만.
#   그 외(목록 없음/빈 파일/quote/패턴 매치/dispatch)는 전부 true(닫힘). rust_changed=true 이면
#   docs_only 도 강제 false — rs→md 리네임이 3-dot name-only 의 새 이름만 보고 Rust/전체 CI 를 우회하지 못하게.
#
# 입력(전부 env): EVENT_NAME, EVENT_ACTION, EVENT_LABEL, PR_DRAFT, PR_LABELS, INPUT_SCOPE,
#   CI_FULL_LABEL, CHANGED_FILE_LIST(경로), RUST_CHANGED_FILE_LIST(경로)
# 출력(stdout key=value, GITHUB_OUTPUT 이 있으면 같이 append):
#   fast, heavy, full, docs_only, consume_label, rust_changed, reason
#
# 주의: 목록을 못 받으면(빈 목록/파일 없음) 문서 전용으로 보지 않는다. 모르는 상태에서는 CI 를 더 돌리는 쪽이 안전하다.
#   `set -e` 를 쓰지 않는다. 출력 append 실패가 CI 판정 자체를 실패로 바꾸면 안 된다.
set -uo pipefail

EVENT_NAME=${EVENT_NAME:-}
EVENT_ACTION=${EVENT_ACTION:-}
EVENT_LABEL=${EVENT_LABEL:-}
PR_DRAFT=${PR_DRAFT:-}
PR_LABELS=${PR_LABELS:-}
INPUT_SCOPE=${INPUT_SCOPE:-}
CI_FULL_LABEL=${CI_FULL_LABEL:-ci-full}
CHANGED_FILE_LIST=${CHANGED_FILE_LIST:-}
RUST_CHANGED_FILE_LIST=${RUST_CHANGED_FILE_LIST:-}

is_true() { case "${1:-}" in true|TRUE|True|1) return 0;; *) return 1;; esac; }

# 라벨 매치는 대소문자 무시 — GitHub Actions `==` 비교와 GitHub 라벨 자체가 case-insensitive 이다.
event_label_lc=$(printf '%s' "$EVENT_LABEL" | tr '[:upper:]' '[:lower:]')
ci_full_lc=$(printf '%s' "$CI_FULL_LABEL" | tr '[:upper:]' '[:lower:]')

# 문서 파일 판정. 마크다운은 어디에 있든 문서로 보고, doc/·docs/ 아래는 문서 산출물 확장자만 인정한다.
is_doc_file() {
  case "$1" in
    *.md | *.mdx) return 0 ;;
    doc/* | docs/*)
      case "$1" in
        *.json | *.yaml | *.yml | *.svg | *.html | *.css | *.txt | *.toml) return 0 ;;
        *.png | *.jpg | *.jpeg | *.gif | *.webp | *.ico) return 0 ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

# 문서 판정: 목록이 없거나 비었으면 "모르는 상태" → false.
docs_only=false
if [ -n "$CHANGED_FILE_LIST" ] && [ -r "$CHANGED_FILE_LIST" ] && [ -s "$CHANGED_FILE_LIST" ]; then
  docs_only=true
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if ! is_doc_file "$path"; then
      docs_only=false
      break
    fi
  done < "$CHANGED_FILE_LIST"
fi

# Rust 변경 판정 — 기본 true(닫힘). rust-changed 목록에는 3-dot·2-dot --no-renames 두 diff 의 합집합이 온다
# (리네임은 삭제+추가로 보이므로 구 경로가 남아 crates/ 매치로 잡힌다).
rust_changed=true
rust_pat='^(crates/|Cargo\.toml$|Cargo\.lock$|\.cargo/|rust-toolchain|clippy\.toml$|\.clippy\.toml$|rustfmt\.toml$|\.rustfmt\.toml$|build\.rs$|scripts/build-rust-workspace\.sh$|\.github/workflows/pr\.yml$|scripts/ci-scope\.sh$)'
if [ "$EVENT_NAME" != workflow_dispatch ] && [ -n "$RUST_CHANGED_FILE_LIST" ] && [ -r "$RUST_CHANGED_FILE_LIST" ] \
  && grep -Eq '[^[:space:]]' "$RUST_CHANGED_FILE_LIST" \
  && ! grep -Eq '^".*"$' "$RUST_CHANGED_FILE_LIST" \
  && ! grep -Eq "$rust_pat" "$RUST_CHANGED_FILE_LIST"; then
  rust_changed=false
fi

# Rust 변경이면 문서 전용 판정을 믿지 않는다 — rs→md 리네임 우회 차단.
[ "$rust_changed" = true ] && docs_only=false

fast=false
heavy=false
full=false
consume_label=false
reason=push-fast-only

if [ "$EVENT_NAME" = workflow_dispatch ]; then
  # 기본값(policy)은 lockfile 봇 경로다 — 봇 PR 은 pull_request 이벤트가 없어 이 워크플로를 dispatch 한다.
  fast=true; heavy=true; full=false; reason=dispatch-policy
  if [ "$INPUT_SCOPE" = full ]; then
    full=true; reason=dispatch-full
  fi
elif [ "$EVENT_ACTION" = labeled ] && [ "$event_label_lc" = "$ci_full_lc" ]; then
  fast=true; heavy=true; full=true; consume_label=true; reason=ci-full-label
elif is_true "$PR_DRAFT"; then
  reason=draft
elif [ "$EVENT_ACTION" = ready_for_review ]; then
  fast=true; heavy=true; full=true; reason=ready_for_review
else
  fast=true; heavy=true; full=false
fi

# 문서 전용은 경량 잡의 무거운 스텝과 전체 스위트를 함께 끈다(수동 dispatch 는 위에서 이미 처리됨).
if [ "$docs_only" = true ] && [ "$EVENT_NAME" != workflow_dispatch ]; then
  heavy=false
  full=false
  reason="${reason}+docs-only"
fi

emit() {
  printf '%s=%s\n' "$1" "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

emit fast "$fast"
emit heavy "$heavy"
emit full "$full"
emit docs_only "$docs_only"
emit consume_label "$consume_label"
emit rust_changed "$rust_changed"
emit reason "$reason"
