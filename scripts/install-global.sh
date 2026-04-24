#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_src="$repo_dir/openai-native-compaction.js"
wrapper_src="$repo_dir/scripts/opencode-openchamber.example"
dcp_prompt_src="$repo_dir/dcp-prompts/overrides"

plugin_dir="$HOME/.config/opencode/plugins"
dcp_prompt_dir="$HOME/.config/opencode/dcp-prompts/overrides"
dcp_config="$HOME/.config/opencode/dcp.jsonc"
bin_dir="$HOME/.local/bin"
key_file="$HOME/.config/opencode/openai-native-compaction.key"

mkdir -p "$plugin_dir" "$dcp_prompt_dir" "$bin_dir" "$(dirname "$key_file")"

install -m 644 "$plugin_src" "$plugin_dir/openai-native-compaction.js"
install -m 755 "$wrapper_src" "$bin_dir/opencode-openchamber"
install -m 644 "$dcp_prompt_src"/*.md "$dcp_prompt_dir/"

node <<'EOF'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dcpConfig = path.join(os.homedir(), ".config", "opencode", "dcp.jsonc");

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stripTrailingCommas(text) {
  return text.replace(/,\s*([}\]])/g, "$1");
}

let config = {};
if (fs.existsSync(dcpConfig)) {
  const raw = fs.readFileSync(dcpConfig, "utf8").trim();
  if (raw) {
    config = JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
  }
}

config.$schema ??=
  "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json";
config.experimental ??= {};
config.experimental.customPrompts = true;

fs.mkdirSync(path.dirname(dcpConfig), { recursive: true });
fs.writeFileSync(dcpConfig, `${JSON.stringify(config, null, 2)}\n`);
EOF

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

Installed DCP prompt overrides:
  $dcp_prompt_dir

DCP config:
  $dcp_config

API key file:
  $key_file

Next steps:
  1. Put an OpenAI API key with Responses write permission in the key file.
  2. Set VS Code setting:
     "openchamber.opencodeBinary": "$bin_dir/opencode-openchamber"
  3. Reload VS Code and restart the OpenChamber API connection.
EOF
