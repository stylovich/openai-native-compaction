# codemem setup for OpenCode

This folder contains the optional `codemem` setup used alongside the native
compaction plugin and DCP.

`codemem` is a persistent-memory layer for OpenCode. It captures session events,
extracts durable memories, stores them in a local SQLite database, and injects
relevant memory context back into future prompts.

## What This Installs

Run:

```bash
./codemem/install-codemem.sh
```

The script is idempotent and does the following:

- Ensures the current shell can use Node `24` through `nvm`.
- Runs `npx -y codemem setup --opencode-only`.
- Adds the `@codemem/opencode-plugin` plugin to `~/.config/opencode/opencode.json`.
- Adds the `codemem` MCP server to `~/.config/opencode/opencode.json`.
- Configures the MCP command through `bash -lc` so it loads Node `24` through
  `nvm` even if OpenCode itself was started from a Node `22` environment.
- Removes known conflicting memory plugins from OpenCode config:
  `opencode-mem`, `opencode-nowledge-mem`, `opencode-supermemory`, and
  `@supermemoryai/opencode-supermemory`.
- Writes `~/.config/codemem/config.jsonc`.
- Patches `~/.local/bin/opencode-openchamber` so OpenChamber starts OpenCode
  with Node `24` available for `npx`/MCP runtime commands.

## Recommended Config

The installer writes:

```jsonc
{
  "observer_provider": "openai",
  "observer_model": "gpt-5.4-mini",
  "observer_runtime": "api_http",
  "observer_auth_source": "auto",
  "observer_max_chars": 12000,
  "observer_max_tokens": 4000
}
```

This aligns codemem's observer model with the native compaction plugin. The
database remains local at:

```text
~/.codemem/mem.sqlite
```

`observer_auth_source: "auto"` lets codemem use the available OpenAI/Codex auth
from the local OpenCode login or compatible environment variables.

## Runtime Flow

After restarting OpenCode/OpenChamber:

- The OpenCode plugin starts the local codemem viewer/backend on
  `127.0.0.1:38888`.
- The plugin captures prompts, assistant messages, and tool results.
- Raw events are stored in `~/.codemem/mem.sqlite`.
- The codemem backend processes pending raw events with the observer model.
- Extracted memories are written back to the same SQLite database.
- Relevant memories are injected into the system prompt through
  `experimental.chat.system.transform`.

The model can also write explicit memories through the MCP tool
`memory_remember`. This is useful for decisions, milestones, bugfixes, and
notable discoveries. The automatic capture path still runs independently.

## Verify

Restart OpenCode/OpenChamber, then run:

```bash
npx -y codemem stats
npx -y codemem db raw-events-status
npx -y codemem recent --limit 10
```

The expected OpenCode MCP config for codemem is:

```jsonc
{
  "mcp": {
    "codemem": {
      "type": "local",
      "command": [
        "bash",
        "-lc",
        "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"; if [ -s \"$NVM_DIR/nvm.sh\" ]; then . \"$NVM_DIR/nvm.sh\"; nvm use \"${CODEMEM_NODE_MAJOR:-24}\" --silent >/dev/null; fi; exec npx -y codemem mcp"
      ],
      "enabled": true
    }
  }
}
```

OpenCode-side logs:

```bash
rg "codemem|memory" ~/.local/share/opencode/log
```

codemem plugin log:

```bash
tail -n 200 ~/.codemem/plugin.log
```

Inside OpenCode, you can ask the model to call:

```text
mem-status
memory_learn
```

`mem-status` comes from the OpenCode plugin. `memory_learn` comes from the MCP
server and explains when to search, remember, or forget memories.

## Useful Environment Variables

Override installer defaults:

```bash
CODEMEM_OBSERVER_MODEL="gpt-5.4-mini" ./codemem/install-codemem.sh
CODEMEM_NODE_MAJOR="24" ./codemem/install-codemem.sh
```

Runtime toggles:

```bash
export CODEMEM_INJECT_CONTEXT=0
export CODEMEM_RAW_EVENTS=0
export CODEMEM_VIEWER_AUTO=0
export CODEMEM_PLUGIN_DEBUG=1
export CODEMEM_PLUGIN_LOG=1
```

Use these only for debugging. Normal usage should leave injection, raw events,
and viewer auto-start enabled.

## Notes

- `api_http` is codemem's own observer runtime. It does not automatically use
  the active chat model selected in OpenCode.
- The observer model is fixed by `~/.config/codemem/config.jsonc` or by
  `CODEMEM_OBSERVER_MODEL`.
- `codemem` stores data locally, but the observer model call is remote when the
  provider is `openai`.
- Keep only one memory plugin active at a time to avoid duplicated system-prompt
  injection.
