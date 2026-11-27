#!/usr/bin/env bash
# Install the Paperwork personal endpoint bot: build/fetch the binary, write
# ~/.paperwork-bot/config.json (0600), and print the exact service-registration
# next steps for macOS LaunchAgent or Linux systemd --user.
#
# Usage: scripts/install-paperwork-bot.sh [--server URL] [--name NAME]
#                                         [--folder PATH] [--pair-code CODE]
set -euo pipefail

SERVER_URL="https://paperwork.insightflo.si"
ENDPOINT_NAME="$(hostname -s)"
PAIR_CODE=""
FOLDERS=()

usage() {
  cat <<'EOF'
Usage: install-paperwork-bot.sh [options]
  --server URL       Paperwork server URL (default: https://paperwork.insightflo.si)
  --name NAME        Endpoint name (default: short hostname)
  --folder PATH      Allowed folder, repeatable
  --pair-code CODE   Pairing code shown on the Paperwork board (optional)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER_URL="${2:?--server requires a value}"; shift 2 ;;
    --name) ENDPOINT_NAME="${2:?--name requires a value}"; shift 2 ;;
    --folder) FOLDERS+=("${2:?--folder requires a value}"); shift 2 ;;
    --pair-code) PAIR_CODE="${2:?--pair-code requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

OS="$(uname -s)"
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64) ARCH="x86_64" ;;
  *) echo "error: unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../crates/bot-runtime/Cargo.toml" ]; then
  echo "==> building paperwork-bot ($OS/$ARCH) from crates/bot-runtime"
  cargo build --release --manifest-path "$SCRIPT_DIR/../crates/bot-runtime/Cargo.toml"
  BOT_BIN="$SCRIPT_DIR/../target/release/paperwork-bot"
elif command -v paperwork-bot >/dev/null 2>&1; then
  BOT_BIN="$(command -v paperwork-bot)"
else
  echo "error: paperwork-bot not found; run inside the repo or install the binary first" >&2
  exit 1
fi

CONFIG_DIR="$HOME/.paperwork-bot"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

FOLDERS_JSON=""
SEP=""
for f in ${FOLDERS[@]+"${FOLDERS[@]}"}; do
  FOLDERS_JSON="$FOLDERS_JSON$SEP\"$(json_escape "$f")\""
  SEP=", "
done

{
  printf '{\n'
  printf '  "server_url": "%s",\n' "$(json_escape "$SERVER_URL")"
  printf '  "endpoint_name": "%s",\n' "$(json_escape "$ENDPOINT_NAME")"
  printf '  "allowed_folders": [%s]\n' "$FOLDERS_JSON"
  printf '}\n'
} > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

echo "==> binary: $BOT_BIN"
echo "==> config: $CONFIG_FILE (0600)"
echo
echo "Next steps:"
echo "  1) $BOT_BIN doctor"
case "$OS" in
  Darwin)
    echo "  2) $BOT_BIN install-service"
    echo "     (writes ~/Library/LaunchAgents/si.insightflo.paperwork-bot.plist and runs:"
    echo "      launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/si.insightflo.paperwork-bot.plist)"
    ;;
  Linux)
    echo "  2) $BOT_BIN install-service"
    echo "     (writes ~/.config/systemd/user/paperwork-bot.service and runs:"
    echo "      systemctl --user daemon-reload && systemctl --user enable --now paperwork-bot.service)"
    ;;
  *) echo "error: unsupported OS: $OS" >&2; exit 2 ;;
esac
if [ -n "$PAIR_CODE" ]; then
  echo "  3) $BOT_BIN init --pair-code $PAIR_CODE"
fi
