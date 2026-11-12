#!/usr/bin/env bash
# Linux installer. From a checkout: deploy/install-linux.sh --name ... --relay ... --token ...
# From a new PC, piping this file re-fetches deploy/install.sh and runs it.
set -euo pipefail
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "install-linux.sh is for Linux. On macOS use install-macos.sh. On Windows use install-windows.ps1." >&2
  exit 1
fi
export GROKCODE_INSTALL_OS=linux
here=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi
if [[ -n "$here" && -f "$here/install.sh" ]]; then
  exec bash "$here/install.sh" "$@"
fi
tmp=$(mktemp)
curl -fsSL "https://raw.githubusercontent.com/pilppilo/grokcode/main/deploy/install.sh" -o "$tmp"
exec bash "$tmp" "$@"
