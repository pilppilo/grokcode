#!/usr/bin/env bash
# One-command grokcode install for Linux and macOS.
# Writes ~/.config/grokcode/agent.env (mode 600) and registers a user service.
# Tokens are never printed.
#
#   deploy/install.sh --name desktop --relay wss://YOUR_WORKER.workers.dev/agent --token PASTE_TOKEN \
#     --model opencode-go/deepseek-v4.1-flash --set-opencode-model
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  install.sh --name NAME (--relay URL --token TOKEN) [--model provider/model]
             [--password PASSWORD] [--set-opencode-model]
             [--listen HOST:PORT --mcp-token TOKEN] [--mode auto|attach|spawn]

Relay mode is the default. Pass --listen and --mcp-token as well, or instead,
for direct/Tailscale mode. The two modes stay independent.
EOF
}

NAME=""
RELAY=""
TOKEN=""
MODEL=""
PASSWORD=""
LISTEN=""
MCP_TOKEN=""
MODE="attach"
SET_OPENCODE_MODEL=0
REPO_URL="https://github.com/pilppilo/grokcode.git"
INSTALL_DIR=""
START=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME=${2:-}; shift 2 ;;
    --relay) RELAY=${2:-}; shift 2 ;;
    --token) TOKEN=${2:-}; shift 2 ;;
    --model) MODEL=${2:-}; shift 2 ;;
    --password) PASSWORD=${2:-}; shift 2 ;;
    --listen) LISTEN=${2:-}; shift 2 ;;
    --mcp-token) MCP_TOKEN=${2:-}; shift 2 ;;
    --mode) MODE=${2:-}; shift 2 ;;
    --set-opencode-model) SET_OPENCODE_MODEL=1; shift ;;
    --repo) REPO_URL=${2:-}; shift 2 ;;
    --dir) INSTALL_DIR=${2:-}; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

os=$(uname -s)
case "${GROKCODE_INSTALL_OS:-any}" in
  linux)
    [[ "$os" == "Linux" ]] || { echo "install-linux.sh is for Linux (this machine is $os)." >&2; exit 1; }
    ;;
  macos)
    [[ "$os" == "Darwin" ]] || { echo "install-macos.sh is for macOS (this machine is $os)." >&2; exit 1; }
    ;;
  any) ;;
  *) echo "Unknown GROKCODE_INSTALL_OS." >&2; exit 1 ;;
esac
if [[ "$os" != "Linux" && "$os" != "Darwin" ]]; then
  echo "This installer supports Linux and macOS. On Windows run deploy/install-windows.ps1." >&2
  exit 1
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing prerequisite: $1. Install it, then re-run." >&2
    exit 1
  fi
}
need node
need git
need opencode
node_major=$(node -p "Number(process.versions.node.split('.')[0])")
if [[ "$node_major" -lt 20 ]]; then
  echo "Node.js 20 or newer is required (found $(node -v))." >&2
  exit 1
fi

if [[ -z "$NAME" ]]; then
  echo "Pass --name." >&2
  exit 2
fi
if [[ -z "$RELAY" && -z "$LISTEN" ]]; then
  echo "Pass --relay and --token, or --listen and --mcp-token." >&2
  exit 2
fi
if [[ -n "$RELAY" && -z "$TOKEN" ]]; then
  echo "Relay mode needs --token." >&2
  exit 2
fi
if [[ -n "$LISTEN" && -z "$MCP_TOKEN" ]]; then
  echo "Direct mode needs --mcp-token." >&2
  exit 2
fi
if [[ "$SET_OPENCODE_MODEL" -eq 1 && -z "$MODEL" ]]; then
  echo "--set-opencode-model needs --model." >&2
  exit 2
fi
case "$MODE" in
  auto|attach|spawn) ;;
  *) echo "--mode must be auto, attach, or spawn." >&2; exit 2 ;;
esac

script_dir=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi
if [[ -n "$INSTALL_DIR" ]]; then
  repo="$INSTALL_DIR"
elif [[ -n "$script_dir" && -f "$script_dir/../packages/agent/package.json" ]]; then
  repo=$(cd "$script_dir/.." && pwd)
else
  repo="${HOME}/.grokcode/repo"
fi

if [[ -d "$repo/.git" ]]; then
  echo "Updating $repo"
  git -C "$repo" pull --ff-only
elif [[ -f "$repo/packages/agent/package.json" ]]; then
  echo "Using existing checkout at $repo"
else
  mkdir -p "$(dirname "$repo")"
  echo "Cloning into $repo"
  git clone "$REPO_URL" "$repo"
fi

echo "Building grokcode"
( cd "$repo" && npm ci && npm run build )

cfg_dir="${HOME}/.config/grokcode"
mkdir -p "$cfg_dir"
chmod 700 "$cfg_dir"
env_file="$cfg_dir/agent.env"

# Pass only the values this run was given. Ambient secrets are not copied.
write_env=(
  env
  -u GROKCODE_MACHINE_NAME
  -u GROKCODE_RELAY_URL
  -u GROKCODE_MACHINE_TOKEN
  -u GROKCODE_LISTEN
  -u GROKCODE_MCP_TOKEN
  -u OPENCODE_PASSWORD
  -u GROKCODE_DEFAULT_MODEL
  -u GROKCODE_OPENCODE_MODE
  "GROKCODE_MACHINE_NAME=$NAME"
  "GROKCODE_OPENCODE_MODE=$MODE"
)
[[ -n "$RELAY" ]] && write_env+=("GROKCODE_RELAY_URL=$RELAY")
[[ -n "$TOKEN" ]] && write_env+=("GROKCODE_MACHINE_TOKEN=$TOKEN")
[[ -n "$LISTEN" ]] && write_env+=("GROKCODE_LISTEN=$LISTEN")
[[ -n "$MCP_TOKEN" ]] && write_env+=("GROKCODE_MCP_TOKEN=$MCP_TOKEN")
[[ -n "$PASSWORD" ]] && write_env+=("OPENCODE_PASSWORD=$PASSWORD")
[[ -n "$MODEL" ]] && write_env+=("GROKCODE_DEFAULT_MODEL=$MODEL")
"${write_env[@]}" node "$repo/packages/agent/dist/write-config.js" --out "$env_file"
chmod 600 "$env_file"

if [[ "$SET_OPENCODE_MODEL" -eq 1 ]]; then
  node "$repo/packages/agent/dist/opencode-config.js" --model "$MODEL" --home "$HOME"
fi

node_bin=$(command -v node)
oc_dir=$(dirname "$(command -v opencode)")
node_dir=$(dirname "$node_bin")
mkdir -p "${HOME}/.local/bin"
wrapper="${HOME}/.local/bin/grokcode-agent"
path_value="${node_dir}:${oc_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cat > "$wrapper" <<EOF
#!/bin/sh
export PATH=$(printf '%q' "$path_value")
log="\$HOME/.config/grokcode/agent.log"
if [ -f "\$log" ]; then
  size=\$(wc -c < "\$log" 2>/dev/null || echo 0)
  if [ "\$size" -gt 1048576 ]; then
    mv "\$log" "\$log.1" 2>/dev/null || true
  fi
fi
exec $(printf '%q' "$node_bin") $(printf '%q' "$repo/packages/agent/dist/cli.js")
EOF
chmod 755 "$wrapper"

if [[ "$os" == "Linux" ]]; then
  unit_dir="${HOME}/.config/systemd/user"
  mkdir -p "$unit_dir"
  cp "$repo/deploy/grokcode-agent.service" "$unit_dir/grokcode-agent.service"
  systemctl --user daemon-reload
  systemctl --user enable grokcode-agent
  if [[ "$START" -eq 1 ]]; then
    systemctl --user restart grokcode-agent
  fi
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" 2>/dev/null || true
  fi
  echo "Enabled systemd user service grokcode-agent."
else
  plist_dir="${HOME}/Library/LaunchAgents"
  mkdir -p "$plist_dir" "$cfg_dir"
  plist="${plist_dir}/com.grokcode.agent.plist"
  sed "s#YOUR_HOME#${HOME//#/}#g" "$repo/deploy/com.grokcode.agent.plist" > "$plist"
  launchctl bootout "gui/${UID}/com.grokcode.agent" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID}" "$plist"
  launchctl enable "gui/${UID}/com.grokcode.agent" || true
  if [[ "$START" -eq 1 ]]; then
    launchctl kickstart -k "gui/${UID}/com.grokcode.agent"
  fi
  echo "Enabled LaunchAgent com.grokcode.agent."
fi

echo "Installed grokcode for machine ${NAME}."
echo "Config: ${env_file}"
if [[ -n "$RELAY" ]]; then echo "Relay: configured"; fi
if [[ -n "$LISTEN" ]]; then echo "Direct listener: configured"; fi
if [[ -n "$MODEL" ]]; then echo "Default model: ${MODEL}"; fi
echo "Logs: ${cfg_dir}/agent.log"
