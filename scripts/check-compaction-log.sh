#!/usr/bin/env bash
set -euo pipefail

log_dir="${OPENCODE_LOG_DIR:-$HOME/.local/share/opencode/log}"
pattern="PLUGIN_HOOK_ENTERED|PLUGIN_USED|PLUGIN_FALLBACK|PLUGIN_NO_AUTH|PLUGIN_NO_SUMMARY|openai-native-compaction|session.compaction|/summarize|responses/compact|Incorrect API key|insufficient permissions|Invalid value"

if [ "${1:-}" ]; then
  latest="$1"
else
  latest="$(ls -t "$log_dir"/*.log 2>/dev/null | head -n 1)"
fi

if [ ! -f "$latest" ]; then
  echo "No OpenCode log file found in $log_dir" >&2
  exit 1
fi

echo "Log: $latest"

if command -v rg >/dev/null 2>&1; then
  rg -n "$pattern" "$latest" || true
else
  grep -En "$pattern" "$latest" || true
fi
