import { readFileSync } from "node:fs";

const SERVICE = "openai-native-compaction";
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_TAIL_TURNS = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 6_000;
const DEFAULT_API_KEY_FILE = `${process.env.HOME || ""}/.config/opencode/openai-native-compaction.key`;
const DEFAULT_OPENCODE_AUTH_PATH = `${process.env.HOME || ""}/.local/share/opencode/auth.json`;

// Mirrors OpenCode's current anchored summary template as closely as possible.
const SUMMARY_TEMPLATE = `Output exactly this Markdown structure and keep the section order unchanged:

---
## Goal

- [single-sentence task summary]

## Constraints & Preferences

- [user constraints, preferences, specs, or "(none)"]

## Progress

### Done

- [completed work or "(none)"]

### In Progress

- [current work or "(none)"]

### Blocked

- [blockers or "(none)"]

## Key Decisions

- [decision and why, or "(none)"]

## Next Steps

- [ordered next actions or "(none)"]

## Critical Context

- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files

- [file or directory path: why it matters, or "(none)"]

---

Rules:

- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function unwrap(result) {
  if (result && typeof result === "object" && "data" in result) return result.data;
  return result;
}

function normalizeBaseUrl(url) {
  const trimmed = (url || "https://api.openai.com/v1").replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

async function safeLog(client, level, message, metadata) {
  if (!client?.app?.log) return;
  try {
    const normalizedLevel = level === "warning" ? "warn" : level;
    await client.app.log({
      body: {
        service: SERVICE,
        level: normalizedLevel,
        message: metadata ? `${message} ${JSON.stringify(metadata)}` : message,
      },
    });
  } catch {
    // Ignore logging failures.
  }
}

function isCompactionTriggerMessage(message) {
  return (
    message?.info?.role === "user" &&
    Array.isArray(message?.parts) &&
    message.parts.some((part) => part?.type === "compaction")
  );
}

function textParts(message) {
  return (message?.parts ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || "").trim())
    .filter(Boolean);
}

function summaryText(message) {
  const text = textParts(message).join("\n\n").trim();
  return text || undefined;
}

function completedCompactions(messages) {
  const users = new Map();

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isCompactionTriggerMessage(message)) continue;
    users.set(message.info.id, i);
  }

  const completed = [];

  for (let assistantIndex = 0; assistantIndex < messages.length; assistantIndex += 1) {
    const message = messages[assistantIndex];
    if (message?.info?.role !== "assistant") continue;
    if (!message?.info?.summary || !message?.info?.finish || message?.info?.error) continue;

    const userIndex = users.get(message.info.parentID);
    if (userIndex === undefined) continue;

    completed.push({
      userIndex,
      assistantIndex,
      summary: summaryText(message),
    });
  }

  return completed;
}

function dropPendingCompactionTail(messages) {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  return isCompactionTriggerMessage(last) ? messages.slice(0, -1) : messages;
}

function turns(messages) {
  const result = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.info?.role !== "user") continue;
    if ((message.parts ?? []).some((part) => part?.type === "compaction")) continue;

    result.push({ start: i, end: messages.length, id: message.info.id });
  }

  for (let i = 0; i < result.length - 1; i += 1) {
    result[i].end = result[i + 1].start;
  }

  return result;
}

function selectHead(messages, tailTurns) {
  if (!messages.length) return messages;
  if (tailTurns <= 0) return messages;

  const allTurns = turns(messages);
  if (!allTurns.length) return messages;

  const keep = allTurns.slice(-tailTurns)[0];
  if (!keep || keep.start <= 0) return messages;

  return messages.slice(0, keep.start);
}

function truncateMiddle(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  if (maxChars <= 32) return text.slice(0, maxChars);

  const head = Math.floor((maxChars - 11) / 2);
  const tail = maxChars - 11 - head;
  return `${text.slice(0, head)}\n[...snip...]\n${text.slice(-tail)}`;
}

function safeJson(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderToolState(state, maxChars) {
  if (!state || typeof state !== "object") return "";

  if (state.status === "completed") {
    const input = safeJson(state.input);
    const output = truncateMiddle(String(state.output || ""), maxChars);
    return [
      `[Tool completed] ${state.title || ""}`.trim(),
      input ? `Input:\n${input}` : "",
      output ? `Output:\n${output}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (state.status === "error") {
    const input = safeJson(state.input);
    return [
      "[Tool error]",
      input ? `Input:\n${input}` : "",
      state.error ? `Error:\n${state.error}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (state.status === "running") {
    const input = safeJson(state.input);
    return [
      `[Tool running] ${state.title || ""}`.trim(),
      input ? `Input:\n${input}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (state.status === "pending") {
    const input = safeJson(state.input);
    return ["[Tool pending]", input ? `Input:\n${input}` : ""].filter(Boolean).join("\n\n");
  }

  return "";
}

function renderPart(part, options) {
  if (!part || typeof part !== "object") return "";

  switch (part.type) {
    case "text":
      return String(part.text || "").trim();

    case "file": {
      const label = `[Attached ${part.mime || "file"}${part.filename ? `: ${part.filename}` : ""}]`;
      const sourcePath = part.source?.path ? `Source: ${part.source.path}` : "";
      return [label, sourcePath].filter(Boolean).join("\n");
    }

    case "tool": {
      const header = `[Tool] ${part.tool || "unknown"}`;
      const state = renderToolState(part.state, options.toolOutputMaxChars);
      return [header, state].filter(Boolean).join("\n\n");
    }

    case "patch":
      return part.files?.length ? `[Patch] ${part.files.join(", ")}` : "[Patch]";

    case "subtask":
      return [`[Subtask] ${part.description || ""}`.trim(), part.agent ? `Agent: ${part.agent}` : "", part.prompt ? `Prompt:\n${part.prompt}` : ""]
        .filter(Boolean)
        .join("\n\n");

    case "agent":
      return part.name ? `[Agent] ${part.name}` : "";

    case "retry":
      return `[Retry ${part.attempt ?? ""}] ${part.error?.data?.message || part.error?.name || ""}`.trim();

    case "snapshot":
      return options.includeSnapshots ? `[Snapshot]\n${truncateMiddle(String(part.snapshot || ""), options.toolOutputMaxChars)}` : "";

    case "step-finish":
      return part.reason ? `[Step finished] ${part.reason}` : "";

    case "reasoning":
      return options.includeReasoning ? String(part.text || "").trim() : "";

    case "compaction":
    case "step-start":
      return "";

    default:
      return "";
  }
}

function renderMessage(message, options) {
  const chunks = [];

  for (const part of message?.parts ?? []) {
    const text = renderPart(part, options);
    if (text) chunks.push(text);
  }

  return chunks.join("\n\n").trim();
}

function toResponseInput(message, text) {
  return {
    type: "message",
    role: message?.info?.role === "assistant" ? "assistant" : "user",
    content: text,
  };
}

function buildSummaryPrompt(previousSummary) {
  const anchor = previousSummary
    ? [
        "Update the anchored summary below using the conversation history already carried in the compacted context.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history already carried in the compacted context.";

  return `${anchor}\n\n${SUMMARY_TEMPLATE}`;
}

function buildEchoPrompt(summary) {
  return [
    "Ignore the conversation above for output generation.",
    "Return exactly the Markdown between <summary> and </summary>.",
    "Do not add or remove characters. Do not add code fences, commentary, or trailing notes.",
    "<summary>",
    summary.trim(),
    "</summary>",
  ].join("\n\n");
}

async function openaiRequest({ apiKey, baseUrl, path, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out calling ${path}`)), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let json = {};

    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = { raw };
      }
    }

    if (!response.ok) {
      throw new Error(json?.error?.message || raw || `${path} failed with HTTP ${response.status}`);
    }

    return json;
  } finally {
    clearTimeout(timer);
  }
}

function extractResponseText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks = [];

  for (const item of response?.output ?? []) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;

    for (const part of item.content ?? []) {
      if (!part) continue;
      if ((part.type === "output_text" || part.type === "summary_text" || part.type === "text") && typeof part.text === "string") {
        chunks.push(part.text);
      }
      if (part.type === "refusal" && typeof part.refusal === "string") {
        chunks.push(part.refusal);
      }
    }
  }

  return chunks.join("").trim();
}

function normalizeCompactedWindow(items) {
  return items.map((item) => {
    if (!item || typeof item !== "object" || item.type !== "message" || !Array.isArray(item.content)) {
      return item;
    }

    const content = item.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (item.role === "assistant" && part.type === "input_text") {
        return { ...part, type: "output_text" };
      }
      return part;
    });

    return { ...item, content };
  });
}

function getApiKey() {
  return env("OPENCODE_NATIVE_COMPACTION_API_KEY", env("OPENAI_API_KEY", getLocalApiKeyFileToken() || getOpenCodeOpenAIAuthToken()));
}

function getLocalApiKeyFileToken() {
  const keyPath = env("OPENCODE_NATIVE_COMPACTION_API_KEY_FILE", DEFAULT_API_KEY_FILE);
  if (!keyPath) return "";

  try {
    return parseApiKey(readFileSync(keyPath, "utf8"));
  } catch {
    return "";
  }
}

function parseApiKey(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";

  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (!firstLine) return "";

  const assignment = firstLine.match(/^(?:export\s+)?(?:OPENCODE_NATIVE_COMPACTION_API_KEY|OPENAI_API_KEY)\s*=\s*(.+)$/);
  const token = assignment ? assignment[1].trim() : firstLine;

  return token.replace(/^['"]|['"]$/g, "").trim();
}

function getOpenCodeOpenAIAuthToken() {
  const authPath = env("OPENCODE_NATIVE_COMPACTION_AUTH_FILE", DEFAULT_OPENCODE_AUTH_PATH);
  if (!authPath) return "";

  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"))?.openai;

    if (auth?.type === "api" && typeof auth.key === "string") {
      return auth.key;
    }

    if (auth?.type !== "oauth" || typeof auth.access !== "string") {
      return "";
    }

    if (typeof auth.expires === "number" && auth.expires <= Date.now() + 60_000) {
      return "";
    }

    return auth.access;
  } catch {
    return "";
  }
}

function getBaseUrl() {
  return normalizeBaseUrl(env("OPENCODE_NATIVE_COMPACTION_BASE_URL", env("OPENAI_BASE_URL", "https://api.openai.com/v1")));
}

async function computeNativeSummary({ client, sessionID }) {
  const allMessages = unwrap(await client.session.messages({ path: { id: sessionID } }));
  if (!Array.isArray(allMessages) || allMessages.length === 0) return undefined;

  const history = dropPendingCompactionTail(allMessages);
  const prior = completedCompactions(history);
  const hiddenIndexes = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]));
  const previousSummary = prior.length ? prior[prior.length - 1].summary : undefined;
  const visibleHistory = history.filter((_, index) => !hiddenIndexes.has(index));

  const tailTurns = envInt("OPENCODE_NATIVE_COMPACTION_TAIL_TURNS", DEFAULT_TAIL_TURNS);
  const head = selectHead(visibleHistory, tailTurns);

  const renderOptions = {
    toolOutputMaxChars: envInt("OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS", DEFAULT_TOOL_OUTPUT_MAX_CHARS),
    includeReasoning: envBool("OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING", false),
    includeSnapshots: envBool("OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS", false),
  };

  const inputItems = head
    .map((message) => {
      const text = renderMessage(message, renderOptions);
      return text ? toResponseInput(message, text) : undefined;
    })
    .filter(Boolean);

  if (inputItems.length === 0) {
    return previousSummary;
  }

  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const timeoutMs = envInt("OPENCODE_NATIVE_COMPACTION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const model = env("OPENCODE_NATIVE_COMPACTION_MODEL", DEFAULT_MODEL);
  const summaryModel = env("OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL", model);

  const compacted = await openaiRequest({
    apiKey,
    baseUrl,
    path: "/responses/compact",
    timeoutMs,
    body: {
      model,
      input: inputItems,
    },
  });

  const compactedWindow = normalizeCompactedWindow(Array.isArray(compacted?.output) ? compacted.output : []);
  if (!compactedWindow.length) {
    throw new Error("responses/compact returned no output window");
  }

  const summaryResponse = await openaiRequest({
    apiKey,
    baseUrl,
    path: "/responses",
    timeoutMs,
    body: {
      model: summaryModel,
      store: false,
      instructions:
        "You are writing a continuation summary for OpenCode compaction. Output only the requested Markdown and nothing else.",
      input: [
        ...compactedWindow,
        {
          type: "message",
          role: "user",
          content: buildSummaryPrompt(previousSummary),
        },
      ],
    },
  });

  const summary = extractResponseText(summaryResponse);
  if (!summary) {
    throw new Error("responses.create returned no summary text");
  }

  return summary.trim();
}

export const OpenAINativeCompactionPlugin = async ({ client }) => {
  let warnedMissingKey = false;

  await safeLog(client, "info", "PLUGIN_INITIALIZED_OPENAI_NATIVE_COMPACTION OpenAI-native compaction plugin initialized.");

  return {
    "experimental.session.compacting": async (input, output) => {
      if (envBool("OPENCODE_NATIVE_COMPACTION_DEBUG", false)) {
        await safeLog(client, "info", "PLUGIN_HOOK_ENTERED_OPENAI_NATIVE_COMPACTION experimental.session.compacting hook entered.", {
          sessionID: input.sessionID,
        });
      }

      const apiKey = getApiKey();
      if (!apiKey) {
        if (!warnedMissingKey) {
          warnedMissingKey = true;
          await safeLog(client, "warning", "PLUGIN_NO_AUTH_OPENAI_NATIVE_COMPACTION OPENAI_API_KEY is missing; falling back to OpenCode's default compaction.");
        }
        return;
      }

      try {
        const summary = await computeNativeSummary({ client, sessionID: input.sessionID });
        if (!summary) {
          if (envBool("OPENCODE_NATIVE_COMPACTION_DEBUG", false)) {
            await safeLog(client, "warn", "PLUGIN_NO_SUMMARY_OPENAI_NATIVE_COMPACTION Native compaction produced no summary; falling back to OpenCode's default compaction.", {
              sessionID: input.sessionID,
            });
          }
          return;
        }

        output.prompt = buildEchoPrompt(summary);

        if (envBool("OPENCODE_NATIVE_COMPACTION_DEBUG", false)) {
          await safeLog(client, "info", "PLUGIN_USED_OPENAI_NATIVE_COMPACTION Installed OpenAI-native compaction summary into OpenCode prompt.", {
            sessionID: input.sessionID,
            summaryChars: summary.length,
          });
        }
      } catch (error) {
        await safeLog(client, "warning", "PLUGIN_FALLBACK_OPENAI_NATIVE_COMPACTION OpenAI-native compaction failed; falling back to OpenCode's default compaction.", {
          sessionID: input.sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
};
