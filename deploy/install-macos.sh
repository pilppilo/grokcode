#!/usr/bin/env bash
# macOS installer. From a checkout: deploy/install-macos.sh --name ... --relay ... --token ...
# From a new Mac, piping this file re-fetches deploy/install.sh and runs it.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-macos.sh is for macOS. On Linux use install-linux.sh. On Windows use install-windows.ps1." >&2
  exit 1
fi
export GROKCODE_INSTALL_OS=macos
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
