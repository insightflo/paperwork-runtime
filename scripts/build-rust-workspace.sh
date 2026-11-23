#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target}"
RELEASE_DIR="$TARGET_DIR/release"

cargo build --release --workspace --locked

case "$(uname -s)" in
  Darwin) CDYLIB_EXT="dylib" ;;
  *) CDYLIB_EXT="so" ;;
esac

# Explicit crate-dir -> release artifact map (no globs) to preserve backward
# compatibility with existing parity tests and A1 systemd PAPERCLIP_*_BIN paths.
ARTIFACTS=(
  "artifact-io:paperclip-artifact-io"
  "claude-quota-pty:paperclip-claude-quota-pty"
  "cli-runtime:paperclip-cli-runtime"
  "db-backup:paperclip-db-backup"
  "fs-scan:paperclip-fs-scan"
  "heartbeat-core:paperclip-heartbeat-core"
  "kb-core:paperclip-kb-core"
  "log-redactor:libpaperclip_log_redactor.${CDYLIB_EXT}"
  "mission-core:paperclip-mission-core"
  "ops-control:paperclip-ops-control"
  "paperwork-engine:paperwork-engine"
  "portability-yaml:paperclip-portability-yaml"
  "process-supervisor:paperclip-process-supervisor"
  "provider-auth-core:paperclip-provider-auth-core"
  "provider-runtime-core:paperclip-provider-runtime-core"
  "qa-file-owner:paperclip-qa-file-owner"
  "quota-router:paperclip-quota-router"
  "redactor-core:paperclip-redactor-core"
  "run-log:paperclip-run-log"
  "runtime-guard-core:paperclip-runtime-guard-core"
  "schedule-core:paperclip-schedule-core"
  "settler:paperclip-settler"
  "tool-hygiene-core:paperclip-tool-hygiene-core"
  "verdict-core:paperclip-verdict-core"
  "workflow-core:paperclip-workflow-core"
)

for entry in "${ARTIFACTS[@]}"; do
  crate_dir="${entry%%:*}"
  artifact="${entry#*:}"
  src="$RELEASE_DIR/$artifact"
  if [ ! -f "$src" ]; then
    echo "ERROR: expected release artifact missing: $src" >&2
    exit 1
  fi
  dest_dir="$ROOT_DIR/crates/$crate_dir/target/release"
  mkdir -p "$dest_dir"
  tmp_dest="$dest_dir/.${artifact}.tmp.$$"
  cp -f "$src" "$tmp_dest"
  mv -f "$tmp_dest" "$dest_dir/$artifact"
done

echo "Staged ${#ARTIFACTS[@]} Rust workspace release artifacts from $RELEASE_DIR"
