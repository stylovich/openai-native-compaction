import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAINativeCompactionPlugin, { __test } from "../openai-native-compaction.js";

const here = dirname(fileURLToPath(import.meta.url));

function readFixture(name) {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

test("normalizeBaseUrl appends v1 and trims trailing slashes", () => {
  assert.equal(__test.normalizeBaseUrl("https://api.openai.com"), "https://api.openai.com/v1");
  assert.equal(__test.normalizeBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1");
});

test("plugin module exposes a default plugin factory export", () => {
  assert.equal(typeof OpenAINativeCompactionPlugin, "object");
  assert.equal(OpenAINativeCompactionPlugin.id, "openai-native-compaction");
  assert.equal(typeof OpenAINativeCompactionPlugin.server, "function");
});

test("isInternalCompactionSystemPrompt detects OpenCode's internal compaction agent prompt", () => {
  assert.equal(
    __test.isInternalCompactionSystemPrompt("You are a helpful AI assistant tasked with summarizing conversations."),
    true,
  );
  assert.equal(__test.isInternalCompactionSystemPrompt("You are a normal coding assistant."), false);
});

test("buildMinimalCompactionMessages keeps a tiny user compaction batch", () => {
  const messages = [
    {
      info: {
        id: "msg_prev",
        sessionID: "ses_test",
        role: "assistant",
        agent: "build",
        time: { created: 1 },
      },
      parts: [],
    },
    {
      info: {
        id: "msg_compact",
        sessionID: "ses_test",
        role: "user",
        agent: "compaction",
        time: { created: 2 },
      },
      parts: [
        {
          id: "part_compaction",
          sessionID: "ses_test",
          messageID: "msg_compact",
          type: "compaction",
          auto: true,
        },
        {
          id: "part_text",
          sessionID: "ses_test",
          messageID: "msg_compact",
          type: "text",
          text: "x".repeat(20_000),
        },
      ],
    },
  ];

  const minimal = __test.buildMinimalCompactionMessages(messages);

  assert.equal(minimal.length, 1);
  assert.equal(minimal[0].info.id, "msg_compact");
  assert.equal(minimal[0].parts.length, 2);
  assert.equal(minimal[0].parts[0].type, "compaction");
  assert.equal(minimal[0].parts[1].type, "text");
  assert.match(minimal[0].parts[1].text, /final compacted summary only/i);
  assert.equal(__test.getSessionIDFromMessages(minimal), "ses_test");
  assert.equal(__test.hasRecentCompactionMarker(messages), true);
});

test("messageDumpStats summarizes transformed message batches", () => {
  const stats = __test.messageDumpStats([
    {
      info: {
        id: "msg_user",
        sessionID: "ses_test",
        role: "user",
        agent: "build",
      },
      parts: [{ type: "text", text: "hola" }],
    },
    {
      info: {
        id: "msg_assistant",
        sessionID: "ses_test",
        role: "assistant",
        agent: "build",
      },
      parts: [
        { type: "reasoning", text: "pensando" },
        {
          type: "tool",
          state: {
            input: { q: "abc" },
            output: "resultado",
          },
        },
      ],
    },
  ]);

  assert.equal(stats.messages, 2);
  assert.equal(stats.parts, 3);
  assert.equal(stats.textChars, 12);
  assert.equal(stats.reasoningChars, 8);
  assert.equal(stats.toolOutputChars, 9);
  assert.equal(stats.partTypes.text, 1);
  assert.equal(stats.partTypes.reasoning, 1);
  assert.equal(stats.partTypes.tool, 1);
  assert.equal(stats.roles.user, 1);
  assert.equal(stats.roles.assistant, 1);
  assert.equal(stats.agents.build, 2);
});

test("parseApiKey supports raw and assignment formats", () => {
  assert.equal(__test.parseApiKey("sk-test"), "sk-test");
  assert.equal(__test.parseApiKey("OPENAI_API_KEY=sk-test"), "sk-test");
  assert.equal(__test.parseApiKey("export OPENCODE_NATIVE_COMPACTION_API_KEY='sk-test'"), "sk-test");
  assert.equal(__test.parseApiKey("# comment only\n\n"), "");
});

test("envReasoningEffort defaults to medium and supports disabling", () => {
  const previous = process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT;

  try {
    delete process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT;
    assert.equal(__test.envReasoningEffort("OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT"), "medium");

    process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT = "HIGH";
    assert.equal(__test.envReasoningEffort("OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT"), "high");

    process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT = "none";
    assert.equal(__test.envReasoningEffort("OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT"), "");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT;
    else process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT = previous;
  }
});

test("parseRetryAfterMs supports seconds and HTTP dates", () => {
  assert.equal(__test.parseRetryAfterMs("1.5"), 1500);

  const future = new Date(Date.now() + 2000).toUTCString();
  const parsed = __test.parseRetryAfterMs(future);

  assert.ok(parsed >= 0);
  assert.ok(parsed <= 30_000);
});

test("parseRetryAfterMsFromMessage supports OpenAI rate limit hints", () => {
  assert.equal(
    __test.parseRetryAfterMsFromMessage(
      "Rate limit reached. Please try again in 15.329s. Visit https://platform.openai.com/account/rate-limits",
    ),
    16329,
  );
});

test("isRetryableStatus marks only transient HTTP classes as retryable", () => {
  assert.equal(__test.isRetryableStatus(401), false);
  assert.equal(__test.isRetryableStatus(403), false);
  assert.equal(__test.isRetryableStatus(429), true);
  assert.equal(__test.isRetryableStatus(503), true);
});

test("isRequestTooLargeMessage detects context window errors", () => {
  assert.equal(__test.isRequestTooLargeMessage("Your input exceeds the context window of this model."), true);
  assert.equal(
    __test.isRequestTooLargeMessage(
      "Rate limit reached for gpt-5.4-mini on tokens per min (TPM): Limit 200000, Used 114422, Requested 139953.",
    ),
    false,
  );
  assert.equal(
    __test.isRequestTooLargeMessage(
      "Request too large for gpt-5.4 on tokens per min (TPM): Limit 400000, Requested 794930.",
    ),
    true,
  );
});

test("buildSummaryPrompt includes the new durable-preferences and discoveries sections", () => {
  const prompt = __test.buildSummaryPrompt("## Goal\n\n- Previous summary.");

  assert.match(prompt, /## Active User Preferences & Constraints/);
  assert.match(prompt, /## Discoveries/);
  assert.match(prompt, /<previous-summary>/);
  assert.match(prompt, /current-state relevant completed work only/);
  assert.match(prompt, /Preserve pending user-requested activities/);
});

test("extractResponseText prefers output_text and falls back to assistant content", () => {
  const inline = {
    output_text: "inline output",
    output: [],
  };

  assert.equal(__test.extractResponseText(inline), "inline output");

  const response = readFixture("summary-response.json");
  assert.equal(__test.extractResponseText(response), "## Goal\n\n- Explicar el repo.");
});

test("extractResponseText also supports summary_text, text, and refusal parts", () => {
  const response = {
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "summary_text", text: "Resumen. " },
          { type: "text", text: "Texto. " },
          { type: "refusal", refusal: "Negativa." },
        ],
      },
    ],
  };

  assert.equal(__test.extractResponseText(response), "Resumen. Texto. Negativa.");
});

test("normalizeCompactedWindow rewrites assistant input_text parts to output_text", () => {
  const response = readFixture("compact-response.json");
  const normalized = __test.normalizeCompactedWindow(response.output);

  assert.equal(normalized[0].content[0].type, "input_text");
  assert.equal(normalized[1].content[0].type, "output_text");
  assert.equal(normalized[2].type, "compaction");
  assert.equal(normalized[2].encrypted_content, "opaque_compaction_blob");
});

test("normalizeDcpSummary strips DCP headers and trailing block metadata tags", () => {
  const summary = __test.normalizeDcpSummary(
    "[Compressed conversation section]\nResumen persistido por DCP.\n\n<dcp-message-id>b12</dcp-message-id>",
  );

  assert.equal(summary, "Resumen persistido por DCP.");
});

test("completedCompactions and latestCompletedCompaction recover the last stored summary", () => {
  const messages = readFixture("session-with-compaction.json");
  const completed = __test.completedCompactions(messages);
  const latest = __test.latestCompletedCompaction(messages);

  assert.equal(completed.length, 1);
  assert.ok(completed[0].summary.includes("Hallazgo inicial."));
  assert.equal(latest.userIndex, 2);
  assert.equal(latest.assistantIndex, 3);
  assert.ok(latest.summary.includes("## Discoveries"));
});

test("dropPendingCompactionTail removes only the trailing compaction trigger", () => {
  const messages = readFixture("session-with-compaction.json");
  const trimmed = __test.dropPendingCompactionTail(messages);

  assert.equal(trimmed.length, messages.length - 1);
  assert.equal(trimmed.at(-1).info.id, "msg_assistant_3");
});

test("selectHead keeps older turns and preserves the last N turns outside the head slice", () => {
  const messages = readFixture("session-with-compaction.json").slice(0, 8);
  const head = __test.selectHead(messages, 2);

  assert.deepEqual(
    head.map((message) => message.info.id),
    ["msg_user_1", "msg_assistant_1", "msg_compact_trigger", "msg_compact_summary"],
  );
});

test("applyDcpInterop injects active DCP summaries and skips covered raw messages", () => {
  const fullHistory = readFixture("session-with-dcp.json");
  const dcpState = readFixture("dcp-session-state.json").prune.messages;
  const head = fullHistory.slice(0, 2);

  const transformed = __test.applyDcpInterop(head, dcpState, fullHistory);

  assert.deepEqual(
    transformed.map((message) => message.info.id),
    ["msg_dcp_summary_1_msg_user_1"],
  );
  assert.equal(transformed[0].info.role, "user");
  assert.equal(transformed[0].meta.syntheticDcpSummary, true);
  assert.match(
    transformed[0].parts[0].text,
    /DCP guarda el estado en .*storage\/plugin\/dcp/,
  );
  assert.doesNotMatch(transformed[0].parts[0].text, /<dcp-message-id>/);
});

test("selectHead ignores synthetic DCP summaries when preserving the last user turns", () => {
  const synthetic = {
    info: { id: "msg_dcp_summary_1_msg_assistant_2", role: "user" },
    parts: [{ type: "text", text: "Resumen DCP" }],
    meta: { syntheticDcpSummary: true },
  };

  const messages = [
    {
      info: { id: "msg_user_1", role: "user" },
      parts: [{ type: "text", text: "Turno viejo" }],
    },
    {
      info: { id: "msg_assistant_1", role: "assistant" },
      parts: [{ type: "text", text: "Respuesta vieja" }],
    },
    {
      info: { id: "msg_user_2", role: "user" },
      parts: [{ type: "text", text: "Último turno real" }],
    },
    synthetic,
    {
      info: { id: "msg_assistant_2", role: "assistant" },
      parts: [{ type: "text", text: "Seguimiento" }],
    },
  ];

  const head = __test.selectHead(messages, 1);

  assert.deepEqual(
    head.map((message) => message.info.id),
    ["msg_user_1", "msg_assistant_1"],
  );
});

test("reduceCompactInputItems halves multi-message windows and truncates a single oversized item", () => {
  const multi = [
    { type: "message", role: "user", content: "uno" },
    { type: "message", role: "assistant", content: "dos" },
    { type: "message", role: "user", content: "tres" },
    { type: "message", role: "assistant", content: "cuatro" },
  ];

  const halved = __test.reduceCompactInputItems(multi);
  assert.deepEqual(
    halved.map((item) => item.content),
    ["tres", "cuatro"],
  );

  const single = [{ type: "message", role: "user", content: "x".repeat(12000) }];
  const truncated = __test.reduceCompactInputItems(single);
  assert.equal(truncated.length, 1);
  assert.ok(truncated[0].content.length < single[0].content.length);
  assert.match(truncated[0].content, /\[\.\.\.snip\.\.\.\]/);
});

test("computeNativeSummary replays compact -> responses using the sanitized fixtures", async () => {
  const messages = readFixture("session-with-compaction.json").slice(0, 8);
  const compactResponse = readFixture("compact-response.json");
  const summaryResponse = readFixture("summary-response.json");
  const expectedCompactRequest = readFixture("replay-expected-compact-request.json");
  const expectedSummaryRequest = readFixture("replay-expected-summary-request.json");
  const requests = [];

  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
  const previousSummaryModel = process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
  const previousReasoningEffort = process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT;
  const previousSummaryReasoningEffort = process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT;
  const previousTailTurns = process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;

  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENCODE_NATIVE_COMPACTION_MODEL = "gpt-5.4";
  process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = "gpt-5.4-mini";
  process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT = "medium";
  process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT = "medium";
  process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = "2";

  globalThis.fetch = async (url, options) => {
    requests.push({
      url,
      body: JSON.parse(String(options.body)),
      authorization: options.headers.authorization,
    });

    const responseBody = requests.length === 1 ? compactResponse : summaryResponse;

    return {
      ok: true,
      async text() {
        return JSON.stringify(responseBody);
      },
    };
  };

  try {
    const summary = await __test.computeNativeSummary({
      client: {
        session: {
          messages: async () => ({ data: messages }),
        },
      },
      sessionID: "ses_test",
      dumpRun: undefined,
    });

    assert.equal(summary, "## Goal\n\n- Explicar el repo.");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "https://api.openai.com/v1/responses/compact");
    assert.equal(requests[0].authorization, "Bearer sk-test");
    assert.deepEqual(requests[0].body, expectedCompactRequest);
    assert.equal(requests[1].url, "https://api.openai.com/v1/responses");
    assert.deepEqual(requests[1].body, expectedSummaryRequest);
  } finally {
    globalThis.fetch = previousFetch;

    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;

    if (previousModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_MODEL = previousModel;

    if (previousSummaryModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = previousSummaryModel;

    if (previousReasoningEffort === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT;
    else process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT = previousReasoningEffort;

    if (previousSummaryReasoningEffort === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT;
    else process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT = previousSummaryReasoningEffort;

    if (previousTailTurns === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;
    else process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = previousTailTurns;
  }
});

test("computeNativeSummary returns the previous summary when there is no new visible input to compact", async () => {
  const messages = [
    {
      info: { id: "msg_compact_trigger", role: "user" },
      parts: [{ type: "compaction" }],
    },
    {
      info: {
        id: "msg_compact_summary",
        parentID: "msg_compact_trigger",
        role: "assistant",
        summary: true,
        finish: "stop",
      },
      parts: [{ type: "text", text: "## Goal\n\n- Summary already stored." }],
    },
    {
      info: { id: "msg_pending_compaction", role: "user" },
      parts: [{ type: "compaction" }],
    },
  ];

  const previousFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      throw new Error("fetch should not be called when there is no new input");
    };

    const summary = await __test.computeNativeSummary({
      client: {
        session: {
          messages: async () => ({ data: messages }),
        },
      },
      sessionID: "ses_empty",
      dumpRun: undefined,
    });

    assert.equal(summary, "## Goal\n\n- Summary already stored.");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("computeNativeSummary throws when /responses/compact returns no output window", async () => {
  const messages = readFixture("session-with-compaction.json").slice(0, 8);
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.OPENAI_API_KEY;

  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({ output: [] });
    },
  });

  try {
    await assert.rejects(
      () =>
        __test.computeNativeSummary({
          client: {
            session: {
              messages: async () => ({ data: messages }),
            },
          },
          sessionID: "ses_empty_compact",
          dumpRun: undefined,
        }),
      /responses\/compact returned no output window/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("computeNativeSummary serializes tool-heavy history with truncation and preserves a long previous summary anchor", async () => {
  const messages = readFixture("session-with-tools-and-summary.json");
  const compactResponse = readFixture("compact-response.json");
  const summaryResponse = readFixture("summary-response.json");
  const expectedCompactRequest = readFixture("replay-tools-expected-compact-request.json");
  const requests = [];

  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
  const previousSummaryModel = process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
  const previousReasoningEffort = process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT;
  const previousSummaryReasoningEffort = process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT;
  const previousTailTurns = process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;
  const previousToolChars = process.env.OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS;
  const previousReasoning = process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING;
  const previousSnapshots = process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS;

  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENCODE_NATIVE_COMPACTION_MODEL = "gpt-5.4";
  process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = "gpt-5.4-mini";
  process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT = "medium";
  process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT = "medium";
  process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = "2";
  process.env.OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS = "80";
  process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING = "0";
  process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS = "0";

  globalThis.fetch = async (url, options) => {
    requests.push({
      url,
      body: JSON.parse(String(options.body)),
    });

    return {
      ok: true,
      async text() {
        return JSON.stringify(requests.length === 1 ? compactResponse : summaryResponse);
      },
    };
  };

  try {
    await __test.computeNativeSummary({
      client: {
        session: {
          messages: async () => ({ data: messages }),
        },
      },
      sessionID: "ses_tools",
      dumpRun: undefined,
    });

    assert.deepEqual(requests[0].body, expectedCompactRequest);
    assert.equal(requests[0].body.input.length, 2);
    assert.match(requests[0].body.input[1].content, /\[\.\.\.snip\.\.\.\]/);
    assert.doesNotMatch(requests[0].body.input[1].content, /Esta cadena interna/);
    assert.doesNotMatch(requests[0].body.input[1].content, /\[Snapshot\]/);

    const summaryPrompt = requests[1].body.input.at(-1).content;
    assert.match(summaryPrompt, /Hallazgo previo B: el frontend depende de un sistema de temas compartido/);
    assert.match(summaryPrompt, /## Active User Preferences & Constraints/);
  } finally {
    globalThis.fetch = previousFetch;

    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_MODEL = previousModel;
    if (previousSummaryModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = previousSummaryModel;
    if (previousReasoningEffort === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT;
    else process.env.OPENCODE_NATIVE_COMPACTION_REASONING_EFFORT = previousReasoningEffort;
    if (previousSummaryReasoningEffort === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT;
    else process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_REASONING_EFFORT = previousSummaryReasoningEffort;
    if (previousTailTurns === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;
    else process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = previousTailTurns;
    if (previousToolChars === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS;
    else process.env.OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS = previousToolChars;
    if (previousReasoning === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING;
    else process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING = previousReasoning;
    if (previousSnapshots === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS;
    else process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS = previousSnapshots;
  }
});

test("computeNativeSummary reuses active DCP summaries from persisted plugin state", async () => {
  const messages = readFixture("session-with-dcp.json");
  const compactResponse = readFixture("compact-response.json");
  const summaryResponse = readFixture("summary-response.json");
  const requests = [];

  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
  const previousSummaryModel = process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
  const previousTailTurns = process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;
  const previousDcpStorageDir = process.env.OPENCODE_NATIVE_COMPACTION_DCP_STORAGE_DIR;
  const previousDcpInterop = process.env.OPENCODE_NATIVE_COMPACTION_ENABLE_DCP_INTEROP;

  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENCODE_NATIVE_COMPACTION_MODEL = "gpt-5.4";
  process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = "gpt-5.4-mini";
  process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = "1";
  process.env.OPENCODE_NATIVE_COMPACTION_DCP_STORAGE_DIR = join(here, "fixtures", "dcp-storage");
  process.env.OPENCODE_NATIVE_COMPACTION_ENABLE_DCP_INTEROP = "1";

  globalThis.fetch = async (url, options) => {
    requests.push({
      url,
      body: JSON.parse(String(options.body)),
    });

    return {
      ok: true,
      async text() {
        return JSON.stringify(requests.length === 1 ? compactResponse : summaryResponse);
      },
    };
  };

  try {
    await __test.computeNativeSummary({
      client: {
        session: {
          messages: async () => ({ data: messages }),
        },
      },
      sessionID: "ses_dcp",
      dumpRun: undefined,
    });

    assert.equal(requests[0].body.input.length, 1);
    assert.equal(requests[0].body.input[0].role, "user");
    assert.match(requests[0].body.input[0].content, /DCP guarda el estado en .*storage\/plugin\/dcp/);
    assert.doesNotMatch(requests[0].body.input[0].content, /Analiza el auth legado/);
    assert.doesNotMatch(requests[0].body.input[0].content, /<dcp-message-id>/);
  } finally {
    globalThis.fetch = previousFetch;

    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_MODEL = previousModel;
    if (previousSummaryModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = previousSummaryModel;
    if (previousTailTurns === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;
    else process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = previousTailTurns;
    if (previousDcpStorageDir === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_DCP_STORAGE_DIR;
    else process.env.OPENCODE_NATIVE_COMPACTION_DCP_STORAGE_DIR = previousDcpStorageDir;
    if (previousDcpInterop === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_ENABLE_DCP_INTEROP;
    else process.env.OPENCODE_NATIVE_COMPACTION_ENABLE_DCP_INTEROP = previousDcpInterop;
  }
});

test("computeNativeSummary retries /responses/compact with a smaller input when the request is too large", async () => {
  const messages = [
    {
      info: { id: "msg_user_1", sessionID: "ses_reduce", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "Turno 1" }],
    },
    {
      info: { id: "msg_assistant_1", sessionID: "ses_reduce", role: "assistant", time: { created: 2000 } },
      parts: [{ type: "text", text: "Respuesta 1" }],
    },
    {
      info: { id: "msg_user_2", sessionID: "ses_reduce", role: "user", time: { created: 3000 } },
      parts: [{ type: "text", text: "Turno 2" }],
    },
    {
      info: { id: "msg_assistant_2", sessionID: "ses_reduce", role: "assistant", time: { created: 4000 } },
      parts: [{ type: "text", text: "Respuesta 2" }],
    },
    {
      info: { id: "msg_user_3", sessionID: "ses_reduce", role: "user", time: { created: 5000 } },
      parts: [{ type: "text", text: "Turno 3" }],
    },
    {
      info: { id: "msg_assistant_3", sessionID: "ses_reduce", role: "assistant", time: { created: 6000 } },
      parts: [{ type: "text", text: "Respuesta 3" }],
    },
  ];

  const compactResponse = readFixture("compact-response.json");
  const summaryResponse = readFixture("summary-response.json");
  const compactAttempts = [];

  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
  const previousSummaryModel = process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
  const previousTailTurns = process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;

  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENCODE_NATIVE_COMPACTION_MODEL = "gpt-5.4";
  process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = "gpt-5.4-mini";
  process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = "1";

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options.body));

    if (url.endsWith("/responses/compact")) {
      compactAttempts.push(body.input.length);

      if (body.input.length > 2) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => null },
          async text() {
            return JSON.stringify({
              error: {
                message:
                  "Request too large for gpt-5.4 (for limit gpt-5.4-long-context) on tokens per min (TPM): Limit 400000, Requested 794930.",
              },
            });
          },
        };
      }

      return {
        ok: true,
        async text() {
          return JSON.stringify(compactResponse);
        },
      };
    }

    return {
      ok: true,
      async text() {
        return JSON.stringify(summaryResponse);
      },
    };
  };

  try {
    const summary = await __test.computeNativeSummary({
      client: {
        app: {
          log: async () => ({ data: {} }),
        },
        session: {
          messages: async () => ({ data: messages }),
        },
      },
      sessionID: "ses_reduce",
      dumpRun: undefined,
    });

    assert.equal(summary, "## Goal\n\n- Explicar el repo.");
    assert.deepEqual(compactAttempts, [4, 2]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_MODEL = previousModel;
    if (previousSummaryModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = previousSummaryModel;
    if (previousTailTurns === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;
    else process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = previousTailTurns;
  }
});

test("computeNativeSummary can include reasoning and snapshots when explicitly enabled", async () => {
  const messages = readFixture("session-with-tools-and-summary.json");
  const compactResponse = readFixture("compact-response.json");
  const summaryResponse = readFixture("summary-response.json");
  const requests = [];

  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
  const previousSummaryModel = process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
  const previousTailTurns = process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;
  const previousToolChars = process.env.OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS;
  const previousReasoning = process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING;
  const previousSnapshots = process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS;

  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENCODE_NATIVE_COMPACTION_MODEL = "gpt-5.4";
  process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = "gpt-5.4-mini";
  process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = "2";
  process.env.OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS = "80";
  process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING = "1";
  process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS = "1";

  globalThis.fetch = async (url, options) => {
    requests.push({
      url,
      body: JSON.parse(String(options.body)),
    });

    return {
      ok: true,
      async text() {
        return JSON.stringify(requests.length === 1 ? compactResponse : summaryResponse);
      },
    };
  };

  try {
    await __test.computeNativeSummary({
      client: {
        session: {
          messages: async () => ({ data: messages }),
        },
      },
      sessionID: "ses_tools_verbose",
      dumpRun: undefined,
    });

    const assistantContent = requests[0].body.input[1].content;
    assert.match(assistantContent, /Esta cadena interna no debería aparecer/);
    assert.match(assistantContent, /\[Snapshot\]/);
    assert.match(assistantContent, /\[Tool error\]/);
    assert.match(assistantContent, /\[\.\.\.snip\.\.\.\]/);
  } finally {
    globalThis.fetch = previousFetch;

    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_MODEL = previousModel;
    if (previousSummaryModel === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL;
    else process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = previousSummaryModel;
    if (previousTailTurns === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;
    else process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS = previousTailTurns;
    if (previousToolChars === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS;
    else process.env.OPENCODE_NATIVE_COMPACTION_TOOL_OUTPUT_CHARS = previousToolChars;
    if (previousReasoning === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING;
    else process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_REASONING = previousReasoning;
    if (previousSnapshots === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS;
    else process.env.OPENCODE_NATIVE_COMPACTION_INCLUDE_SNAPSHOTS = previousSnapshots;
  }
});

test("openaiRequest returns parsed JSON on success", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({ ok: true, nested: { value: 1 } });
    },
  });

  try {
    const response = await __test.openaiRequest({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      path: "/responses",
      body: { model: "gpt-5.4" },
      timeoutMs: 1000,
    });

    assert.deepEqual(response, { ok: true, nested: { value: 1 } });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("openaiRequest surfaces JSON API errors", async () => {
  const previousFetch = globalThis.fetch;
  const previousRetries = process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;

  process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = "0";
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    async text() {
      return JSON.stringify({
        error: {
          message: "Rate limit exceeded",
        },
      });
    },
  });

  try {
    await assert.rejects(
      () =>
        __test.openaiRequest({
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
          path: "/responses",
          body: { model: "gpt-5.4" },
          timeoutMs: 1000,
        }),
      /Rate limit exceeded/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRetries === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
    else process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = previousRetries;
  }
});

test("openaiRequest falls back to raw text when the error body is not JSON", async () => {
  const previousFetch = globalThis.fetch;
  const previousRetries = process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;

  process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = "0";
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    async text() {
      return "upstream exploded";
    },
  });

  try {
    await assert.rejects(
      () =>
        __test.openaiRequest({
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
          path: "/responses/compact",
          body: { model: "gpt-5.4" },
          timeoutMs: 1000,
        }),
      /upstream exploded/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRetries === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
    else process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = previousRetries;
  }
});

test("openaiRequest aborts with a timeout error when fetch never resolves", async () => {
  const previousFetch = globalThis.fetch;
  const previousRetries = process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;

  process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = "0";
  globalThis.fetch = async (_url, options) =>
    await new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason ?? new Error("aborted")),
        { once: true },
      );
    });

  try {
    await assert.rejects(
      () =>
        __test.openaiRequest({
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
          path: "/responses",
          body: { model: "gpt-5.4" },
          timeoutMs: 10,
        }),
      /Timed out calling \/responses/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRetries === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
    else process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = previousRetries;
  }
});

test("openaiRequest retries once on 429 and then succeeds", async () => {
  const previousFetch = globalThis.fetch;
  const previousRetries = process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
  const previousRetryBase = process.env.OPENCODE_NATIVE_COMPACTION_RETRY_BASE_MS;
  let attempts = 0;

  process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = "1";
  process.env.OPENCODE_NATIVE_COMPACTION_RETRY_BASE_MS = "0";

  globalThis.fetch = async () => {
    attempts += 1;

    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => "0" },
        async text() {
          return JSON.stringify({ error: { message: "Rate limit exceeded" } });
        },
      };
    }

    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true });
      },
    };
  };

  try {
    const response = await __test.openaiRequest({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      path: "/responses",
      body: { model: "gpt-5.4" },
      timeoutMs: 1000,
    });

    assert.equal(attempts, 2);
    assert.deepEqual(response, { ok: true });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRetries === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
    else process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = previousRetries;
    if (previousRetryBase === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_RETRY_BASE_MS;
    else process.env.OPENCODE_NATIVE_COMPACTION_RETRY_BASE_MS = previousRetryBase;
  }
});

test("openaiRequest does not retry oversized 429 requests and classifies them as request_too_large", async () => {
  const previousFetch = globalThis.fetch;
  const previousRetries = process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
  let attempts = 0;

  process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = "1";

  globalThis.fetch = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 429,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({
          error: {
            message:
              "Request too large for gpt-5.4 (for limit gpt-5.4-long-context) on tokens per min (TPM): Limit 400000, Requested 794930.",
          },
        });
      },
    };
  };

  try {
    await assert.rejects(
      async () => {
        try {
          await __test.openaiRequest({
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
            path: "/responses/compact",
            body: { model: "gpt-5.4" },
            timeoutMs: 1000,
          });
        } catch (error) {
          assert.equal(error instanceof __test.OpenAIRequestError, true);
          assert.equal(error.retryable, false);
          assert.equal(error.status, 429);
          assert.equal(error.code, "request_too_large");
          assert.equal(__test.isCompactOversizeError(error), true);
          throw error;
        }
      },
      /Request too large for gpt-5\.4/,
    );

    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRetries === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
    else process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = previousRetries;
  }
});

test("openaiRequest does not retry 403 missing-scope errors and preserves structured metadata", async () => {
  const previousFetch = globalThis.fetch;
  const previousRetries = process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
  let attempts = 0;

  process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = "1";

  globalThis.fetch = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 403,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({
          error: {
            message: "You have insufficient permissions for this operation. Missing scopes: api.responses.write.",
          },
        });
      },
    };
  };

  try {
    await assert.rejects(
      async () => {
        try {
          await __test.openaiRequest({
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
            path: "/responses/compact",
            body: { model: "gpt-5.4" },
            timeoutMs: 1000,
          });
        } catch (error) {
          assert.equal(error instanceof __test.OpenAIRequestError, true);
          assert.equal(error.retryable, false);
          assert.equal(error.status, 403);
          assert.equal(error.code, "http_403");

          const metadata = __test.errorMetadata(error);
          assert.equal(metadata.retryable, false);
          assert.equal(metadata.status, 403);
          assert.equal(metadata.path, "/responses/compact");
          throw error;
        }
      },
      /Missing scopes: api\.responses\.write/,
    );

    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRetries === undefined) delete process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES;
    else process.env.OPENCODE_NATIVE_COMPACTION_MAX_RETRIES = previousRetries;
  }
});
