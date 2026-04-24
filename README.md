# OpenAI-native compaction plugin for OpenCode

This plugin makes OpenCode generate its compaction summary from OpenAI's native
`/responses/compact` flow instead of relying only on OpenCode's built-in
summarizer prompt.

It is intended for local OpenCode/OpenChamber usage, including VS Code setups
where OpenChamber starts and manages the OpenCode server.

## Current Status

The repo currently includes:

- the production plugin in `openai-native-compaction.js`
- fixture-based replay tests under `tests/`
- a minimal CI workflow that runs syntax + tests on GitHub Actions
- conservative runtime hardening for retries, timeouts, and fallback logging

## What It Does

1. Reads the current session through the OpenCode SDK.
2. Reconstructs the part of the conversation OpenCode is about to compact.
3. Preserves the last `2` user turns by default.
4. Calls `POST /v1/responses/compact` with the configured OpenAI model.
5. Calls `POST /v1/responses` to turn the compacted window into an
   OpenCode-compatible anchored summary.
6. Replaces OpenCode's compaction prompt with that summary.

The current summary template is optimized for continuity after compaction:

- `Goal`
- `Active User Preferences & Constraints`
- `Progress`
- `Discoveries`
- `Key Decisions`
- `Next Steps`
- `Critical Context`
- `Relevant Files`

## Limitation

OpenCode plugins can replace the compaction prompt, but they cannot replace
OpenCode's internal message objects with OpenAI's opaque native compaction item.
So the plugin does not store OpenAI's encrypted compaction object inside
OpenCode's session store. It uses native compaction to produce the summary text
that OpenCode stores.

## Repo Layout

- `openai-native-compaction.js`: the plugin.
- `package.json`: local test/check scripts.
- `tests/openai-native-compaction.test.js`: unit + replay tests.
- `tests/fixtures/`: sanitized replay fixtures and expected request bodies.
- `.github/workflows/ci.yml`: GitHub Actions workflow for `npm run check`.
- `scripts/install-global.sh`: copies the plugin and wrapper into the expected
  local OpenCode/OpenChamber locations.
- `scripts/opencode-openchamber.example`: wrapper used by OpenChamber to start
  OpenCode with the plugin environment.
- `scripts/check-compaction-log.sh`: shows the latest OpenCode compaction/plugin
  log markers.

## Quick Install

From this repo:

```bash
./scripts/install-global.sh
```

This installs:

```text
~/.config/opencode/plugins/openai-native-compaction.js
~/.local/bin/opencode-openchamber
~/.config/opencode/dcp-prompts/overrides/*.md
~/.config/opencode/openai-native-compaction.key
```

The key file is created with mode `600` if it does not exist.

## API Key

Preferred setup: put a project API key with Responses write permission in:

```text
~/.config/opencode/openai-native-compaction.key
```

Supported file formats:

```bash
sk-...
OPENAI_API_KEY=sk-...
export OPENAI_API_KEY=sk-...
OPENCODE_NATIVE_COMPACTION_API_KEY=sk-...
```

Set safe permissions:

```bash
chmod 600 ~/.config/opencode/openai-native-compaction.key
```

Do not commit this file.

### Auth Resolution Order

The plugin looks for credentials in this order:

1. `OPENCODE_NATIVE_COMPACTION_API_KEY`
2. `OPENAI_API_KEY`
3. `OPENCODE_NATIVE_COMPACTION_API_KEY_FILE`
4. `~/.config/opencode/openai-native-compaction.key`
5. `OPENCODE_NATIVE_COMPACTION_AUTH_FILE`
6. `~/.local/share/opencode/auth.json`

OpenCode's logged-in OAuth token may not have the API scopes required for
`/v1/responses/compact`. If you see `Missing scopes: api.responses.write`, use a
normal OpenAI API key.

## Environment Variables

Main settings:

```bash
export OPENCODE_NATIVE_COMPACTION_MODEL="${OPENCODE_NATIVE_COMPACTION_MODEL:-gpt-5.4-mini}"
export OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL="${OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL:-gpt-5.4-mini}"
export OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT="${OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT:-medium}"
export OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT="${OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT:-medium}"
export OPENCODE_NATIVE_COMPACTION_API_KEY_FILE="${OPENCODE_NATIVE_COMPACTION_API_KEY_FILE:-$HOME/.config/opencode/openai-native-compaction.key}"
export OPENCODE_NATIVE_COMPACTION_TAIL_TURNS="${OPENCODE_NATIVE_COMPACTION_TAIL_TURNS:-2}"
export OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS="${OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS:-6000}"
export OPENCODE_NATIVE_COMPACTION_TIMEOUT_MS="${OPENCODE_NATIVE_COMPACTION_TIMEOUT_MS:-120000}"
export OPENCODE_NATIVE_COMPACTION_MAX_RETRIES="${OPENCODE_NATIVE_COMPACTION_MAX_RETRIES:-3}"
export OPENCODE_NATIVE_COMPACTION_RETRY_BASE_MS="${OPENCODE_NATIVE_COMPACTION_RETRY_BASE_MS:-750}"
export OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING="${OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING:-0}"
export OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS="${OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS:-0}"
export OPENCODE_NATIVE_COMPACTION_ENABLE_DCP_INTEROP="${OPENCODE_NATIVE_COMPACTION_ENABLE_DCP_INTEROP:-1}"
export OPENCODE_NATIVE_COMPACTION_DEBUG="${OPENCODE_NATIVE_COMPACTION_DEBUG:-1}"
```

Optional extras:

```bash
export OPENCODE_NATIVE_COMPACTION_BASE_URL="https://api.openai.com/v1"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENCODE_NATIVE_COMPACTION_AUTH_FILE="$HOME/.local/share/opencode/auth.json"
export OPENCODE_NATIVE_COMPACTION_DCP_STORAGE_DIR="$HOME/.local/share/opencode/storage/plugin/dcp"
```

Set either reasoning effort variable to `none` or `off` to omit the `reasoning`
field from that OpenAI request.

## Runtime Behavior

- The plugin retries transient OpenAI failures once by default.
- Retryable statuses are `408`, `409`, `425`, `429`, `500`, `502`, `503`,
  and `504`.
- `401`, `403`, and other non-transient `4xx` responses are not retried.
- `Retry-After` is respected when OpenAI returns it.
- Timeout/network/API failures fall back to OpenCode's default compaction path
  instead of breaking the session.
- Fallback logs include structured metadata such as `code`, `status`,
  `retryable`, `attempt`, and `path`.
- When DCP state is present, the plugin reuses active DCP summaries from
  `~/.local/share/opencode/storage/plugin/dcp/<sessionId>.json` and compacts the
  normalized summary instead of the covered raw messages.

## DCP Prompt Overrides

If you use `@tarquinen/opencode-dcp` with this plugin, enable DCP custom prompts
so DCP summaries stay in Spanish and preserve pending handoff tasks:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
  "experimental": {
    "customPrompts": true
  }
}
```

`./scripts/install-global.sh` copies the repo overrides into OpenCode's DCP
prompt directory. To copy them manually:

```bash
mkdir -p ~/.config/opencode/dcp-prompts/overrides
cp dcp-prompts/overrides/*.md ~/.config/opencode/dcp-prompts/overrides/
```

Restart OpenCode/OpenChamber after changing DCP config or prompt files.

## OpenChamber / VS Code

OpenChamber starts OpenCode as a managed process. Environment variables from an
interactive shell are not reliable when VS Code was opened from a desktop
launcher. Use the wrapper instead.

After running `./scripts/install-global.sh`, configure VS Code:

```json
{
  "openchamber.opencodeBinary": "/home/YOUR_USER/.local/bin/opencode-openchamber"
}
```

Then run:

```text
Developer: Reload Window
OpenChamber: Restart API Connection
OpenChamber: Show OpenCode Status
```

The status should show:

```text
OpenCode binary (configured): /home/YOUR_USER/.local/bin/opencode-openchamber
```

## Direct OpenCode Usage

Run the wrapper directly:

```bash
~/.local/bin/opencode-openchamber
```

Or export env vars manually before starting OpenCode:

```bash
export OPENCODE_NATIVE_COMPACTION_MODEL="gpt-5.4-mini"
export OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL="gpt-5.4-mini"
export OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT="medium"
export OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT="medium"
export OPENCODE_NATIVE_COMPACTION_DEBUG="1"
opencode
```

## Testing

Run the full local checks:

```bash
npm run check
```

Or only the test suite:

```bash
npm run test
```

Current coverage includes:

- helper-level tests for URL normalization, API key parsing, retry parsing, and
  response extraction
- replay tests for `/responses/compact -> /responses`
- fallback and edge cases such as empty compact output
- tool-heavy fixtures with long tool outputs, prior summaries, and optional
  reasoning/snapshot inclusion
- DCP interop replays using persisted `storage/plugin/dcp` state
- HTTP/runtime behavior for `429`, `403`, timeout, and raw/JSON error bodies

GitHub Actions runs the same `npm run check` command on `push` to `main` and on
every `pull_request`.

## Verify It Worked

Force or wait for a session compaction, then run:

```bash
./scripts/check-compaction-log.sh
```

Or manually:

```bash
rg "PLUGIN_HOOK_ENTERED|PLUGIN_USED|PLUGIN_FALLBACK|PLUGIN_NO_AUTH|PLUGIN_NO_SUMMARY" ~/.local/share/opencode/log
```

Success marker:

```text
PLUGIN_USED_OPENAI_NATIVE_COMPACTION
```

Expected flow:

```text
PLUGIN_INITIALIZED_OPENAI_NATIVE_COMPACTION
PLUGIN_HOOK_ENTERED_OPENAI_NATIVE_COMPACTION
PLUGIN_USED_OPENAI_NATIVE_COMPACTION
```

Fallback markers:

```text
PLUGIN_FALLBACK_OPENAI_NATIVE_COMPACTION
PLUGIN_NO_AUTH_OPENAI_NATIVE_COMPACTION
PLUGIN_NO_SUMMARY_OPENAI_NATIVE_COMPACTION
```

OpenCode log filenames and timestamps are often UTC. Check file modification
time if the filename looks one timezone ahead of local time.

## Troubleshooting

`Missing scopes: api.responses.write`

The OpenCode OAuth token does not have enough scope. Use an OpenAI API key in
`~/.config/opencode/openai-native-compaction.key`.

`Incorrect API key provided: OPENAI_A...`

The key file was probably read as a literal `OPENAI_API_KEY=...` line by an old
plugin version. Current versions parse assignment syntax.

`Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.`

Current versions normalize assistant content returned by `/responses/compact`
before sending it to `/responses`. If you still see this, the installed plugin
is stale.

Only `PLUGIN_HOOK_ENTERED` appears

The hook ran, but the native summary path did not complete. Check for
`PLUGIN_FALLBACK`, `PLUGIN_NO_AUTH`, or `PLUGIN_NO_SUMMARY` in the same log.

No recent logs appear

Find the active log by modification time:

```bash
ls -lt ~/.local/share/opencode/log | head
tail -F "$(ls -t ~/.local/share/opencode/log/*.log | head -n 1)"
```

## Version Notes

This was verified with:

```text
OpenCode 1.14.20
OpenChamber 1.9.7 / 1.9.8
VS Code 1.115.0
Linux x64
```

Newer OpenCode plugin APIs may change hook names or auth storage. If the plugin
loads but never reaches `PLUGIN_HOOK_ENTERED`, check the installed
`@opencode-ai/plugin` typings for `experimental.session.compacting`.
