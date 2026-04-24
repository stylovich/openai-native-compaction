#!/usr/bin/env bash
set -euo pipefail

node_major_required="${CODEMEM_NODE_MAJOR:-24}"
observer_provider="${CODEMEM_OBSERVER_PROVIDER:-openai}"
observer_model="${CODEMEM_OBSERVER_MODEL:-gpt-5.4-mini}"
observer_runtime="${CODEMEM_OBSERVER_RUNTIME:-api_http}"
observer_max_chars="${CODEMEM_OBSERVER_MAX_CHARS:-12000}"
observer_max_tokens="${CODEMEM_OBSERVER_MAX_TOKENS:-4000}"

opencode_config="${OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"
codemem_config_dir="${CODEMEM_CONFIG_DIR:-$HOME/.config/codemem}"
codemem_config="$codemem_config_dir/config.jsonc"
wrapper="${OPENCODE_OPENCHAMBER_WRAPPER:-$HOME/.local/bin/opencode-openchamber}"
bin_dir="${CODEMEM_BIN_DIR:-$HOME/.local/bin}"
codemem_runner="$bin_dir/codemem"

ensure_node() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  if [ "$major" = "$node_major_required" ]; then
    return 0
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm use "$node_major_required" --silent >/dev/null
    return 0
  fi

  echo "Node $node_major_required is required for codemem, and nvm was not found." >&2
  echo "Install Node $node_major_required or set NVM_DIR before running this script." >&2
  return 1
}

write_codemem_config() {
  mkdir -p "$codemem_config_dir"
  cat >"$codemem_config" <<EOF
{
  // Keep codemem's observer aligned with the native compaction plugin.
  // Storage and retrieval remain local in ~/.codemem/mem.sqlite.
  "observer_provider": "$observer_provider",
  "observer_model": "$observer_model",
  "observer_runtime": "$observer_runtime",
  "observer_auth_source": "auto",
  "observer_max_chars": $observer_max_chars,
  "observer_max_tokens": $observer_max_tokens
}
EOF
}

install_codemem_runner() {
  mkdir -p "$bin_dir"
  cat >"$codemem_runner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

export CODEMEM_NODE_MAJOR="${CODEMEM_NODE_MAJOR:-24}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # codemem depends on native modules such as better-sqlite3; keep the
  # Node ABI stable regardless of the shell/OpenCode process environment.
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use "$CODEMEM_NODE_MAJOR" --silent >/dev/null
fi

exec npx -y codemem "$@"
EOF
  chmod 755 "$codemem_runner"
}

run_codemem_setup() {
  npx -y codemem setup --opencode-only
}

normalize_opencode_config() {
  mkdir -p "$(dirname "$opencode_config")"
  if [ ! -e "$opencode_config" ]; then
    printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' >"$opencode_config"
  fi

  OPENCODE_CONFIG_PATH="$opencode_config" node <<'EOF'
const fs = require("node:fs");

const path = process.env.OPENCODE_CONFIG_PATH;
const text = fs.readFileSync(path, "utf8");
const config = JSON.parse(text);

config.mcp ??= {};
config.mcp.codemem = {
  type: "local",
  command: [
    "bash",
    "-lc",
    "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"; if [ -s \"$NVM_DIR/nvm.sh\" ]; then . \"$NVM_DIR/nvm.sh\"; nvm use \"${CODEMEM_NODE_MAJOR:-24}\" --silent >/dev/null; fi; exec npx -y codemem mcp",
  ],
  enabled: true,
};

const conflictingPlugins = new Set([
  "opencode-mem",
  "opencode-nowledge-mem",
  "opencode-supermemory",
  "@supermemoryai/opencode-supermemory",
]);

const plugins = Array.isArray(config.plugin) ? config.plugin : [];
const nextPlugins = [];
for (const plugin of plugins) {
  if (typeof plugin !== "string") continue;
  if (conflictingPlugins.has(plugin)) continue;
  if (!nextPlugins.includes(plugin)) nextPlugins.push(plugin);
}
if (!nextPlugins.includes("@codemem/opencode-plugin")) {
  nextPlugins.push("@codemem/opencode-plugin");
}
config.plugin = nextPlugins;

fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
EOF
}

patch_openchamber_wrapper() {
  if [ ! -e "$wrapper" ]; then
    mkdir -p "$(dirname "$wrapper")"
    cat >"$wrapper" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"

exec "$OPENCODE_BIN" "$@"
EOF
    chmod 755 "$wrapper"
  fi

  if grep -q "CODEMEM_NODE_MAJOR" "$wrapper"; then
    return 0
  fi

  WRAPPER_PATH="$wrapper" node <<'EOF'
const fs = require("node:fs");

const path = process.env.WRAPPER_PATH;
const text = fs.readFileSync(path, "utf8");
const marker = 'OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"';
const block = `

export CODEMEM_NODE_MAJOR="\${CODEMEM_NODE_MAJOR:-24}"
export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # codemem requires Node 24+ for its npx-powered MCP/runtime commands.
  # This is scoped to the OpenCode process launched by OpenChamber.
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use "$CODEMEM_NODE_MAJOR" --silent >/dev/null 2>&1 || true
fi
`;

let next = text;
if (next.includes(marker)) {
  next = next.replace(marker, `${marker}${block}`);
} else {
  next = next.replace(/\nexec\s+/, `${block}\nexec `);
}
fs.writeFileSync(path, next);
EOF
  chmod 755 "$wrapper"
}

verify() {
  node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))" "$opencode_config"
  npx -y codemem config where >/dev/null
  npx -y codemem stats >/dev/null
}

ensure_node
write_codemem_config
install_codemem_runner
run_codemem_setup
normalize_opencode_config
patch_openchamber_wrapper
verify

cat <<EOF
Installed codemem for OpenCode.

OpenCode config:
  $opencode_config

codemem config:
  $codemem_config

OpenChamber wrapper:
  $wrapper

codemem runner:
  $codemem_runner

Observer:
  provider=$observer_provider model=$observer_model runtime=$observer_runtime

Next steps:
  1. Restart OpenCode/OpenChamber.
  2. Run: npx -y codemem stats
  3. Run: npx -y codemem db raw-events-status
EOF
