#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_src="$repo_dir/openai-native-compaction.js"
wrapper_src="$repo_dir/scripts/opencode-openchamber.example"

plugin_dir="$HOME/.config/opencode/plugins"
bin_dir="$HOME/.local/bin"
key_file="$HOME/.config/opencode/openai-native-compaction.key"

mkdir -p "$plugin_dir" "$bin_dir" "$(dirname "$key_file")"

install -m 644 "$plugin_src" "$plugin_dir/openai-native-compaction.js"
install -m 755 "$wrapper_src" "$bin_dir/opencode-openchamber"

if [ ! -e "$key_file" ]; then
  install -m 600 /dev/null "$key_file"
else
  chmod 600 "$key_file"
fi

cat <<EOF
Installed OpenAI-native compaction plugin:
  $plugin_dir/openai-native-compaction.js

Installed OpenChamber wrapper:
  $bin_dir/opencode-openchamber

API key file:
  $key_file

Next steps:
  1. Put an OpenAI API key with Responses write permission in the key file.
  2. Set VS Code setting:
     "openchamber.opencodeBinary": "$bin_dir/opencode-openchamber"
  3. Reload VS Code and restart the OpenChamber API connection.
EOF
