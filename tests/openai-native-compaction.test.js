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
    assert.equal(requests[0].body.model, "gpt-5.4");
    assert.equal(requests[0].body.input.length, 2);
    assert.deepEqual(
      requests[0].body.input.map((item) => item.role),
      ["user", "assistant"],
    );
    assert.equal(requests[1].url, "https://api.openai.com/v1/responses");
    assert.equal(requests[1].body.model, "gpt-5.4-mini");
    assert.equal(requests[1].body.input[0].role, "user");
    assert.equal(requests[1].body.input[1].role, "assistant");
    assert.equal(requests[1].body.input[1].content[0].type, "output_text");
    assert.equal(requests[1].body.input[2].type, "compaction");
    assert.equal(requests[1].body.input.at(-1).role, "user");
    assert.match(requests[1].body.input.at(-1).content, /## Active User Preferences & Constraints/);
    assert.match(requests[1].body.input.at(-1).content, /## Discoveries/);
    assert.match(requests[1].body.input.at(-1).content, /<previous-summary>/);
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
