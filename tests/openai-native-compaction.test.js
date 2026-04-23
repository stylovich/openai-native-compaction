import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { __test } from "../openai-native-compaction.js";

const here = dirname(fileURLToPath(import.meta.url));

function readFixture(name) {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

test("normalizeBaseUrl appends v1 and trims trailing slashes", () => {
  assert.equal(__test.normalizeBaseUrl("https://api.openai.com"), "https://api.openai.com/v1");
  assert.equal(__test.normalizeBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1");
});

test("parseApiKey supports raw and assignment formats", () => {
  assert.equal(__test.parseApiKey("sk-test"), "sk-test");
  assert.equal(__test.parseApiKey("OPENAI_API_KEY=sk-test"), "sk-test");
  assert.equal(__test.parseApiKey("export OPENCODE_NATIVE_COMPACTION_API_KEY='sk-test'"), "sk-test");
  assert.equal(__test.parseApiKey("# comment only\n\n"), "");
});

test("buildSummaryPrompt includes the new durable-preferences and discoveries sections", () => {
  const prompt = __test.buildSummaryPrompt("## Goal\n\n- Previous summary.");

  assert.match(prompt, /## Active User Preferences & Constraints/);
  assert.match(prompt, /## Discoveries/);
  assert.match(prompt, /<previous-summary>/);
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
  const previousTailTurns = process.env.OPENCODE_NATIVE_COMPACTION_TAIL_TURNS;

  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENCODE_NATIVE_COMPACTION_MODEL = "gpt-5.4";
  process.env.OPENCODE_NATIVE_COMPACTION_SUMMARY_MODEL = "gpt-5.4-mini";
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
  }
});

test("openaiRequest falls back to raw text when the error body is not JSON", async () => {
  const previousFetch = globalThis.fetch;

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
  }
});

test("openaiRequest aborts with a timeout error when fetch never resolves", async () => {
  const previousFetch = globalThis.fetch;

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
  }
});
