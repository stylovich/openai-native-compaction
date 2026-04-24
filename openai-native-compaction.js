import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SERVICE = "openai-native-compaction";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_TAIL_TURNS = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_BASE_MS = 750;
const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 6_000;
const DEFAULT_MIN_COMPACT_ITEM_CHARS = 2_048;
const DEFAULT_API_KEY_FILE = `${process.env.HOME || ""}/.config/opencode/openai-native-compaction.key`;
const DEFAULT_OPENCODE_AUTH_PATH = `${process.env.HOME || ""}/.local/share/opencode/auth.json`;
const DEFAULT_MESSAGE_DUMP_DIR = `${process.env.XDG_DATA_HOME || `${process.env.HOME || ""}/.local/share`}/opencode/openai-native-compaction-message-dumps`;
const DEFAULT_DCP_STORAGE_DIR = `${process.env.XDG_DATA_HOME || `${process.env.HOME || ""}/.local/share`}/opencode/storage/plugin/dcp`;
const DCP_COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]";
const DCP_HEADER_REGEX = /^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i;
const DCP_TRAILING_BLOCK_TAG_REGEX = /(?:\r?\n)*<dcp-message-id(?=[\s>])[^>]*>b\d+<\/dcp-message-id>\s*$/i;
const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi;
const INTERNAL_COMPACTION_SIGNATURES = [
  "You are a helpful AI assistant tasked with summarizing conversations",
  "Summarize what was done in this conversation",
  "Return a concise markdown summary",
];
const DEFAULT_COMPACTION_STATE_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_MESSAGE_DUMP_LIMIT = 200;

// Preserve operational continuity while retaining important factual discoveries.
const SUMMARY_TEMPLATE = `Output exactly this Markdown structure and keep the section order unchanged:

---
## Goal

- [single-sentence current objective]

## Active User Preferences & Constraints

- [durable user preferences, constraints, specs, language/style requirements, or "(none)"]

## Progress

### Done

- [current-state relevant completed work only; omit stale history or "(none)"]

### In Progress

- [current work or "(none)"]

### Blocked

- [blockers or "(none)"]

## Discoveries

- [important factual findings from the repo, API, tools, errors, data, or "(none)"]

## Key Decisions

- [decision and why, or "(none)"]

## Next Steps

- [ordered next actions, including user-facing validation tasks still pending, or "(none)"]

## Critical Context

- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files

- [file or directory path: why it matters, or "(none)"]

---

Rules:

- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Treat Active User Preferences & Constraints as durable guidance only; do not copy temporary summary or compaction instructions as active preferences.
- Put factual findings in Discoveries; put continuation-critical state in Critical Context; avoid duplicating long lists across both.
- Keep Done focused on state needed to continue; summarize old completed work by outcome instead of preserving a full changelog.
- Preserve pending user-requested activities, validation examples, and handoff instructions in Next Steps when still relevant.
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

function envReasoningEffort(name, fallback = DEFAULT_REASONING_EFFORT) {
  const raw = env(name, fallback).trim().toLowerCase();
  if (!raw || /^(0|false|no|off|none|disabled)$/i.test(raw)) return "";
  return raw;
}

function withReasoning(body, effort) {
  return effort ? { ...body, reasoning: { effort } } : body;
}

function unwrap(result) {
  if (result && typeof result === "object" && "data" in result) return result.data;
  return result;
}

function normalizeBaseUrl(url) {
  const trimmed = (url || "https://api.openai.com/v1").replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

class OpenAIRequestError extends Error {
  constructor({
    message,
    path,
    status,
    code,
    retryable,
    attempt,
    maxAttempts,
    retryAfterMs,
    cause,
  }) {
    super(message, cause ? { cause } : undefined);
    this.name = "OpenAIRequestError";
    this.path = path;
    this.status = status ?? null;
    this.code = code || "unknown_error";
    this.retryable = Boolean(retryable);
    this.attempt = attempt ?? 1;
    this.maxAttempts = maxAttempts ?? 1;
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return undefined;

  const seconds = Number.parseFloat(String(value).trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 30_000);
  }

  const dateMs = Date.parse(String(value));
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), 30_000);
  }

  return undefined;
}

function defaultRetryDelayMs(attempt) {
  const baseMs = Math.max(0, envInt("OPENCODE_NATIVE_COMPACTION_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS));
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 10_000);
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function isRequestTooLargeMessage(message) {
  const value = String(message || "").trim();
  if (!value) return false;

  return (
    /request too large/i.test(value) ||
    /conversation history too large to compact/i.test(value) ||
    /exceeds model context limit/i.test(value) ||
    /maximum context length/i.test(value) ||
    /context[_ -]?length[_ -]?exceeded/i.test(value) ||
    (/tokens per min/i.test(value) && /requested/i.test(value) && /limit/i.test(value))
  );
}

function isCompactOversizeError(error) {
  return (
    error instanceof OpenAIRequestError &&
    error.path === "/responses/compact" &&
    (error.code === "request_too_large" || isRequestTooLargeMessage(error.message))
  );
}

function httpStatusLabel(status) {
  const labels = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    408: "Request Timeout",
    409: "Conflict",
    422: "Unprocessable Entity",
    425: "Too Early",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };

  return labels[status] || "HTTP Error";
}

function isAbortTimeoutError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (typeof error.message === "string" && error.message.includes("Timed out calling")) return true;
  return false;
}

function createOpenAITransportError({ path, attempt, maxAttempts, timeoutMs, error }) {
  if (error instanceof OpenAIRequestError) return error;

  if (isAbortTimeoutError(error)) {
    return new OpenAIRequestError({
      message: `Timed out calling ${path} after ${timeoutMs}ms`,
      path,
      code: "timeout",
      retryable: true,
      attempt,
      maxAttempts,
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new OpenAIRequestError({
    message: `Network error calling ${path}: ${message}`,
    path,
    code: "network_error",
    retryable: true,
    attempt,
    maxAttempts,
    cause: error instanceof Error ? error : undefined,
  });
}

function createOpenAIHttpError({ path, status, raw, json, attempt, maxAttempts, retryAfterMs }) {
  const apiMessage =
    typeof json?.error?.message === "string" && json.error.message.trim()
      ? json.error.message.trim()
      : typeof raw === "string" && raw.trim()
        ? raw.trim()
        : `${path} failed with HTTP ${status}`;

  let message = apiMessage;
  let retryable = isRetryableStatus(status);
  let code = `http_${status}`;
  const requestTooLarge = isRequestTooLargeMessage(apiMessage);

  if (status === 401) {
    message = `${path} failed with HTTP 401 Unauthorized. Verify the configured OpenAI API key or auth token.`;
  } else if (status === 403 && /Missing scopes:/i.test(apiMessage)) {
    message = `${path} failed with HTTP 403 Forbidden. ${apiMessage}`;
  } else if (status === 403) {
    message = `${path} failed with HTTP 403 Forbidden. Check model access, org/project permissions, or API key scopes.`;
  } else if (status === 429) {
    const retryHint = retryAfterMs ? ` Retry-After=${retryAfterMs}ms.` : "";
    message = `${path} failed with HTTP 429 Too Many Requests.${retryHint} ${apiMessage}`.trim();
    if (requestTooLarge) {
      retryable = false;
      code = "request_too_large";
    }
  } else if (status >= 500) {
    message = `${path} failed with HTTP ${status} ${httpStatusLabel(status)}. ${apiMessage}`.trim();
  } else if (!apiMessage.startsWith(path)) {
    message = `${path} failed with HTTP ${status} ${httpStatusLabel(status)}. ${apiMessage}`.trim();
  }

  if (requestTooLarge) {
    retryable = false;
    code = "request_too_large";
  }

  return new OpenAIRequestError({
    message,
    path,
    status,
    code,
    retryable,
    attempt,
    maxAttempts,
    retryAfterMs,
  });
}

function createRuntimeError({ message, path, code, retryable = false, cause }) {
  return new OpenAIRequestError({
    message,
    path,
    code,
    retryable,
    cause,
  });
}

function errorMetadata(error) {
  if (error instanceof OpenAIRequestError) {
    return {
      code: error.code,
      path: error.path,
      status: error.status,
      retryable: error.retryable,
      attempt: error.attempt,
      maxAttempts: error.maxAttempts,
      retryAfterMs: error.retryAfterMs,
      error: error.message,
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error),
  };
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

function latestCompletedCompaction(messages) {
  const completed = completedCompactions(messages);
  const latest = completed.at(-1);
  if (!latest) return undefined;

  return {
    summary: latest.summary || "",
    userIndex: latest.userIndex,
    assistantIndex: latest.assistantIndex,
    userMessage: messages[latest.userIndex]?.info,
    assistantMessage: messages[latest.assistantIndex]?.info,
    assistantParts: messages[latest.assistantIndex]?.parts,
  };
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
    if (isSyntheticDcpSummaryMessage(message)) continue;
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

function isSyntheticDcpSummaryMessage(message) {
  return message?.meta?.syntheticDcpSummary === true;
}

function findLastUserMessage(messages, startIndex) {
  const start = startIndex ?? messages.length - 1;

  for (let i = start; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.info?.role !== "user") continue;
    if (isSyntheticDcpSummaryMessage(message)) continue;
    if ((message.parts ?? []).some((part) => part?.type === "compaction")) continue;
    return message;
  }

  return undefined;
}

function normalizeDcpSummary(summary) {
  if (typeof summary !== "string" || !summary.trim()) return "";

  const trimmed = summary.trim();
  const withoutHeader = DCP_HEADER_REGEX.test(trimmed)
    ? trimmed.slice(trimmed.match(DCP_HEADER_REGEX)[0].length).replace(/^(?:\r?\n)+/, "")
    : trimmed;

  return withoutHeader
    .replace(DCP_TRAILING_BLOCK_TAG_REGEX, "")
    .replace(DCP_PAIRED_TAG_REGEX, "")
    .replace(/(?:\r?\n)+$/, "")
    .trim();
}

function getDcpStorageDir() {
  return env("OPENCODE_NATIVE_COMPACTION_DCP_STORAGE_DIR", DEFAULT_DCP_STORAGE_DIR);
}

function loadDcpState(sessionID) {
  if (!envBool("OPENCODE_NATIVE_COMPACTION_ENABLE_DCP_INTEROP", true)) return undefined;
  if (!sessionID) return undefined;

  const storageDir = getDcpStorageDir();
  if (!storageDir) return undefined;

  try {
    const state = JSON.parse(readFileSync(`${storageDir}/${sessionID}.json`, "utf8"));
    const messagesState = state?.prune?.messages;
    if (!messagesState || typeof messagesState !== "object") return undefined;
    return messagesState;
  } catch {
    return undefined;
  }
}

function createSyntheticDcpSummaryMessage(baseMessage, anchorMessage, summary, blockId) {
  const source = baseMessage?.info?.sessionID ? baseMessage : anchorMessage;
  const sessionID = source?.info?.sessionID || anchorMessage?.info?.sessionID;
  const messageID = `msg_dcp_summary_${blockId}_${anchorMessage?.info?.id || "anchor"}`;

  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      agent: source?.info?.agent,
      model: source?.info?.model,
      time: {
        created: source?.info?.time?.created ?? anchorMessage?.info?.time?.created ?? Date.now(),
      },
    },
    parts: [
      {
        id: `prt_dcp_summary_${blockId}_${anchorMessage?.info?.id || "anchor"}`,
        sessionID,
        messageID,
        type: "text",
        text: summary,
      },
    ],
    meta: {
      syntheticDcpSummary: true,
      dcpBlockId: blockId,
    },
  };
}

function applyDcpInterop(messages, dcpState, sourceHistory = messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (!dcpState || typeof dcpState !== "object") return messages;

  const blocksById = dcpState.blocksById;
  const byMessageId = dcpState.byMessageId;

  if (
    !blocksById ||
    typeof blocksById !== "object" ||
    !byMessageId ||
    typeof byMessageId !== "object"
  ) {
    return messages;
  }

  const sourceMessages = Array.isArray(sourceHistory) && sourceHistory.length ? sourceHistory : messages;
  const sourceIndexByMessageId = new Map(
    sourceMessages
      .map((message, index) => [message?.info?.id, index])
      .filter(([messageID]) => Boolean(messageID)),
  );

  const relevantBlockIds = new Set();
  for (const message of messages) {
    const entry = byMessageId[message?.info?.id];
    for (const blockId of entry?.activeBlockIds ?? []) {
      if (Number.isInteger(blockId) && blockId > 0 && blocksById[String(blockId)]?.active === true) {
        relevantBlockIds.add(blockId);
      }
    }
  }

  if (relevantBlockIds.size === 0) return messages;

  const result = [];
  const injectedBlockIds = new Set();

  for (const message of messages) {
    const messageID = message?.info?.id;
    if (!messageID) {
      result.push(message);
      continue;
    }

    const coveringBlockIds = (byMessageId[messageID]?.activeBlockIds ?? []).filter(
      (blockId) => Number.isInteger(blockId) && relevantBlockIds.has(blockId),
    );

    for (const blockId of coveringBlockIds) {
      if (injectedBlockIds.has(blockId)) continue;

      const summary = normalizeDcpSummary(blocksById[String(blockId)]?.summary);
      if (!summary) continue;

      const sourceIndex = sourceIndexByMessageId.get(messageID);
      const baseUserMessage = findLastUserMessage(sourceMessages, sourceIndex);
      result.push(createSyntheticDcpSummaryMessage(baseUserMessage, message, summary, blockId));
      injectedBlockIds.add(blockId);
    }

    if (coveringBlockIds.length > 0) {
      continue;
    }

    result.push(message);
  }

  return result;
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

function isInternalCompactionSystemPrompt(systemText) {
  return INTERNAL_COMPACTION_SIGNATURES.some((signature) => systemText.includes(signature));
}

function isMessageBatchEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    entry.info &&
    typeof entry.info === "object" &&
    typeof entry.info.id === "string" &&
    typeof entry.info.sessionID === "string" &&
    Array.isArray(entry.parts)
  );
}

function getSessionIDFromMessages(messages) {
  const first = Array.isArray(messages) ? messages.find(isMessageBatchEntry) : undefined;
  return first?.info?.sessionID;
}

function hasRecentCompactionMarker(messages, windowSize = 3) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.slice(-windowSize).some((entry) => {
    if (!isMessageBatchEntry(entry)) return false;
    if (entry.info.agent === "compaction") return true;
    return entry.parts.some((part) => part && typeof part === "object" && part.type === "compaction");
  });
}

function buildMinimalCompactionMessages(messages) {
  const usable = Array.isArray(messages) ? messages.filter(isMessageBatchEntry) : [];
  const candidate =
    [...usable].reverse().find((entry) => entry.info.role === "user" && entry.info.agent === "compaction") ||
    [...usable].reverse().find((entry) => entry.info.role === "user");

  if (!candidate) return [];

  const compactionPart = candidate.parts.find((part) => part && typeof part === "object" && part.type === "compaction");
  const parts = [];

  if (compactionPart) {
    parts.push(compactionPart);
  }

  parts.push({
    id: `${candidate.info.id}-native-compaction-text`,
    sessionID: candidate.info.sessionID,
    messageID: candidate.info.id,
    type: "text",
    synthetic: true,
    text: "Use the compaction prompt to output the final compacted summary only.",
  });

  return [
    {
      info: candidate.info,
      parts,
    },
  ];
}

function safeFilenameSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function messageDumpStats(messages) {
  const stats = {
    messages: Array.isArray(messages) ? messages.length : 0,
    parts: 0,
    textChars: 0,
    reasoningChars: 0,
    toolOutputChars: 0,
    toolInputChars: 0,
    partTypes: {},
    roles: {},
    agents: {},
  };

  for (const entry of Array.isArray(messages) ? messages : []) {
    const info = entry?.info || {};
    if (info.role) stats.roles[info.role] = (stats.roles[info.role] || 0) + 1;
    if (info.agent) stats.agents[info.agent] = (stats.agents[info.agent] || 0) + 1;

    for (const part of Array.isArray(entry?.parts) ? entry.parts : []) {
      stats.parts += 1;
      const type = part?.type || "unknown";
      stats.partTypes[type] = (stats.partTypes[type] || 0) + 1;

      if (typeof part?.text === "string") stats.textChars += part.text.length;
      if (type === "reasoning" && typeof part?.text === "string") stats.reasoningChars += part.text.length;
      if (part?.state?.output) stats.toolOutputChars += String(part.state.output).length;
      if (part?.state?.input) stats.toolInputChars += JSON.stringify(part.state.input).length;
      if (part?.state?.raw) stats.toolInputChars += String(part.state.raw).length;
    }
  }

  return stats;
}

async function dumpMessagesTransform({ client, sessionID, stage, messages, sequence }) {
  if (!envBool("OPENCODE_NATIVE_COMPACTION_DUMP_MESSAGES", false)) return;

  const dumpDir = env("OPENCODE_NATIVE_COMPACTION_MESSAGE_DUMP_DIR", DEFAULT_MESSAGE_DUMP_DIR);
  const safeSessionID = safeFilenameSegment(sessionID);
  const sessionDir = `${dumpDir}/${safeSessionID}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${String(sequence).padStart(4, "0")}-${stamp}-${safeFilenameSegment(stage)}.json`;
  const filePath = `${sessionDir}/${filename}`;
  const payload = {
    stage,
    sessionID,
    time: new Date().toISOString(),
    stats: messageDumpStats(messages),
    messages,
  };

  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload, null, 2));

    if (envBool("OPENCODE_NATIVE_COMPACTION_DEBUG", false)) {
      await safeLog(client, "info", "PLUGIN_DUMPED_MESSAGES_OPENAI_NATIVE_COMPACTION Dumped chat messages transform batch.", {
        sessionID,
        stage,
        filePath,
        stats: payload.stats,
      });
    }
  } catch (error) {
    await safeLog(client, "warn", "PLUGIN_DUMP_MESSAGES_FAILED_OPENAI_NATIVE_COMPACTION Failed to dump chat messages transform batch.", {
      sessionID,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function openaiRequest({ apiKey, baseUrl, path, body, timeoutMs }) {
  const maxRetries = Math.max(0, envInt("OPENCODE_NATIVE_COMPACTION_MAX_RETRIES", DEFAULT_MAX_RETRIES));
  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
        const error = createOpenAIHttpError({
          path,
          status: response.status,
          raw,
          json,
          attempt,
          maxAttempts,
          retryAfterMs,
        });

        if (error.retryable && attempt < maxAttempts) {
          await sleep(retryAfterMs ?? defaultRetryDelayMs(attempt));
          continue;
        }

        throw error;
      }

      return json;
    } catch (error) {
      const normalized = createOpenAITransportError({
        path,
        attempt,
        maxAttempts,
        timeoutMs,
        error,
      });

      if (normalized.retryable && attempt < maxAttempts) {
        await sleep(defaultRetryDelayMs(attempt));
        continue;
      }

      throw normalized;
    } finally {
      clearTimeout(timer);
    }
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

function compactInputStats(items) {
  const messages = Array.isArray(items) ? items.length : 0;
  const totalChars = (items ?? []).reduce((total, item) => total + String(item?.content || "").length, 0);
  const maxChars = (items ?? []).reduce((max, item) => Math.max(max, String(item?.content || "").length), 0);

  return {
    messages,
    totalChars,
    maxChars,
  };
}

function reduceCompactInputItems(items) {
  if (!Array.isArray(items) || items.length === 0) return items;

  if (items.length > 1) {
    return items.slice(-Math.ceil(items.length / 2));
  }

  const [item] = items;
  const content = typeof item?.content === "string" ? item.content : "";
  if (!content) return items;

  const minChars = Math.max(256, envInt("OPENCODE_NATIVE_COMPACTION_MIN_COMPACT_ITEM_CHARS", DEFAULT_MIN_COMPACT_ITEM_CHARS));
  if (content.length <= minChars) {
    return items;
  }

  const nextChars = Math.max(minChars, Math.floor(content.length / 2));
  if (nextChars >= content.length) {
    return items;
  }

  return [
    {
      ...item,
      content: truncateMiddle(content, nextChars),
    },
  ];
}

async function compactWithAdaptiveReduction({
  apiKey,
  baseUrl,
  timeoutMs,
  model,
  reasoningEffort,
  inputItems,
  client,
  sessionID,
}) {
  let candidateItems = inputItems;
  let reductions = 0;

  while (candidateItems.length > 0) {
    try {
      const compacted = await openaiRequest({
        apiKey,
        baseUrl,
        path: "/responses/compact",
        timeoutMs,
        body: withReasoning(
          {
            model,
            input: candidateItems,
          },
          reasoningEffort,
        ),
      });

      return {
        compacted,
        compactInput: candidateItems,
        reductions,
      };
    } catch (error) {
      if (!isCompactOversizeError(error)) {
        throw error;
      }

      const nextItems = reduceCompactInputItems(candidateItems);
      const unchanged =
        nextItems.length === candidateItems.length &&
        nextItems.every((item, index) => item?.content === candidateItems[index]?.content);

      if (unchanged) {
        throw error;
      }

      reductions += 1;

      if (envBool("OPENCODE_NATIVE_COMPACTION_DEBUG", false)) {
        await safeLog(
          client,
          "warn",
          "PLUGIN_REDUCED_COMPACT_INPUT_OPENAI_NATIVE_COMPACTION Reducing compact input after oversized request.",
          {
            sessionID,
            reduction: reductions,
            previous: compactInputStats(candidateItems),
            next: compactInputStats(nextItems),
            code: error.code,
          },
        );
      }

      candidateItems = nextItems;
    }
  }

  throw createRuntimeError({
    message: "Unable to reduce compact input to a valid size",
    path: "/responses/compact",
    code: "compact_input_exhausted",
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
  const dcpAwareHead = applyDcpInterop(head, loadDcpState(sessionID), visibleHistory);

  const renderOptions = {
    toolOutputMaxChars: envInt("OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS", DEFAULT_TOOL_OUTPUT_MAX_CHARS),
    includeReasoning: envBool("OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING", false),
    includeSnapshots: envBool("OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS", false),
  };

  const inputItems = dcpAwareHead
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
  const reasoningEffort = envReasoningEffort("OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT");
  const summaryReasoningEffort = envReasoningEffort("OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT", reasoningEffort);

  const { compacted } = await compactWithAdaptiveReduction({
    apiKey,
    baseUrl,
    timeoutMs,
    model,
    reasoningEffort,
    inputItems,
    client,
    sessionID,
  });

  const compactedWindow = normalizeCompactedWindow(Array.isArray(compacted?.output) ? compacted.output : []);
  if (!compactedWindow.length) {
    throw createRuntimeError({
      message: "responses/compact returned no output window",
      path: "/responses/compact",
      code: "invalid_compact_output",
    });
  }

  const summaryResponse = await openaiRequest({
    apiKey,
    baseUrl,
    path: "/responses",
    timeoutMs,
    body: withReasoning(
      {
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
      summaryReasoningEffort,
    ),
  });

  const summary = extractResponseText(summaryResponse);
  if (!summary) {
    throw createRuntimeError({
      message: "responses.create returned no summary text",
      path: "/responses",
      code: "empty_summary_text",
    });
  }

  return summary.trim();
}

export const PLUGIN_ID = "openai-native-compaction";

export const server = async ({ client }) => {
  let warnedMissingKey = false;
  const pendingCompactions = new Map();
  const activeCompactionTransforms = new Set();
  const messageDumpCounts = new Map();
  const compactionStateMaxAgeMs = envInt("OPENCODE_NATIVE_COMPACTION_STATE_MAX_AGE_MS", DEFAULT_COMPACTION_STATE_MAX_AGE_MS);
  const messageDumpLimit = Math.max(0, envInt("OPENCODE_NATIVE_COMPACTION_MESSAGE_DUMP_LIMIT", DEFAULT_MESSAGE_DUMP_LIMIT));

  function clearCompactionState(sessionID) {
    if (!sessionID) return;
    pendingCompactions.delete(sessionID);
    activeCompactionTransforms.delete(sessionID);
  }

  function pruneStaleCompactionState(now = Date.now()) {
    for (const [sessionID, state] of pendingCompactions.entries()) {
      if (!state || typeof state.createdAt !== "number") {
        clearCompactionState(sessionID);
        continue;
      }

      if (now - state.createdAt > compactionStateMaxAgeMs) {
        clearCompactionState(sessionID);
      }
    }
  }

  await safeLog(client, "info", "PLUGIN_INITIALIZED_OPENAI_NATIVE_COMPACTION OpenAI-native compaction plugin initialized.");

  return {
    event: async (input) => {
      const sessionID = input?.event?.properties?.sessionID;

      switch (input?.event?.type) {
        case "session.compacted":
        case "session.error":
        case "session.idle":
          clearCompactionState(sessionID);
          break;
        default:
          break;
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      pruneStaleCompactionState();

      if (!input?.sessionID) return;
      if (!pendingCompactions.has(input.sessionID)) return;

      const systemText = Array.isArray(output.system) ? output.system.join("\n") : "";
      if (!isInternalCompactionSystemPrompt(systemText)) return;

      activeCompactionTransforms.add(input.sessionID);

      if (envBool("OPENCODE_NATIVE_COMPACTION_DEBUG", false)) {
        await safeLog(client, "info", "PLUGIN_DETECTED_INTERNAL_COMPACTION_OPENAI_NATIVE_COMPACTION Detected OpenCode internal compaction agent.", {
          sessionID: input.sessionID,
        });
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      pruneStaleCompactionState();

      const sessionID = getSessionIDFromMessages(output.messages);
      if (!sessionID) return;

      const currentDumpCount = messageDumpCounts.get(sessionID) || 0;
      const canDump = messageDumpLimit === 0 || currentDumpCount < messageDumpLimit;
      if (canDump) {
        messageDumpCounts.set(sessionID, currentDumpCount + 1);
        await dumpMessagesTransform({
          client,
          sessionID,
          stage: "pre-native-transform",
          messages: output.messages,
          sequence: currentDumpCount + 1,
        });
      }

      if (!pendingCompactions.has(sessionID)) return;

      const shouldTrim = activeCompactionTransforms.has(sessionID) || hasRecentCompactionMarker(output.messages);
      if (!shouldTrim) return;

      const replacement = buildMinimalCompactionMessages(output.messages);
      if (replacement.length === 0) return;

      const previousCount = Array.isArray(output.messages) ? output.messages.length : 0;
      output.messages.splice(0, output.messages.length, ...replacement);

      if (envBool("OPENCODE_NATIVE_COMPACTION_DEBUG", false)) {
        await safeLog(client, "info", "PLUGIN_TRIMMED_COMPACTION_MESSAGES_OPENAI_NATIVE_COMPACTION Replaced compaction message batch with a minimal echo batch.", {
          sessionID,
          previousCount,
          nextCount: output.messages.length,
        });
      }

      const nextDumpCount = messageDumpCounts.get(sessionID) || 0;
      const canDumpTrimmed = messageDumpLimit === 0 || nextDumpCount < messageDumpLimit;
      if (canDumpTrimmed) {
        messageDumpCounts.set(sessionID, nextDumpCount + 1);
        await dumpMessagesTransform({
          client,
          sessionID,
          stage: "post-native-transform",
          messages: output.messages,
          sequence: nextDumpCount + 1,
        });
      }
    },
    "experimental.session.compacting": async (input, output) => {
      pruneStaleCompactionState();

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
        pendingCompactions.set(input.sessionID, {
          createdAt: Date.now(),
          summary,
        });
        activeCompactionTransforms.delete(input.sessionID);

        if (envBool("OPENCODE_NATIVE_COMPACTION_DEBUG", false)) {
          await safeLog(client, "info", "PLUGIN_USED_OPENAI_NATIVE_COMPACTION Installed OpenAI-native compaction summary into OpenCode prompt.", {
            sessionID: input.sessionID,
            summaryChars: summary.length,
          });
        }
      } catch (error) {
        clearCompactionState(input.sessionID);
        await safeLog(client, "warning", "PLUGIN_FALLBACK_OPENAI_NATIVE_COMPACTION OpenAI-native compaction failed; falling back to OpenCode's default compaction.", {
          sessionID: input.sessionID,
          ...errorMetadata(error),
        });
      }
    },
  };
};

export const OpenAINativeCompactionPlugin = {
  id: PLUGIN_ID,
  server,
};

export default OpenAINativeCompactionPlugin;

export const __test = {
  SUMMARY_TEMPLATE,
  buildMinimalCompactionMessages,
  buildSummaryPrompt,
  compactInputStats,
  completedCompactions,
  computeNativeSummary,
  dropPendingCompactionTail,
  extractResponseText,
  getSessionIDFromMessages,
  hasRecentCompactionMarker,
  envReasoningEffort,
  isInternalCompactionSystemPrompt,
  isCompactOversizeError,
  isRequestTooLargeMessage,
  latestCompletedCompaction,
  normalizeBaseUrl,
  normalizeCompactedWindow,
  OpenAIRequestError,
  applyDcpInterop,
  messageDumpStats,
  errorMetadata,
  isRetryableStatus,
  isSyntheticDcpSummaryMessage,
  loadDcpState,
  normalizeDcpSummary,
  openaiRequest,
  parseApiKey,
  parseRetryAfterMs,
  reduceCompactInputItems,
  selectHead,
};
