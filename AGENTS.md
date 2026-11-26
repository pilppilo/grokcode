# Grokcode

Grokcode must never launch Antigravity (`agy`, including its executable and script shims) or read Gemini credentials under `~/.gemini/`. Antigravity may connect interactively as an MCP stdio client.

Grokcode attaches to OpenCode at `127.0.0.1:4096`. Never start, stop, or restart OpenCode automatically. Use `start_opencode` only on explicit operator request. The shell bridge denies the OpenCode CLI and process-control commands.
