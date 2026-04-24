Collapse selected individual messages in the conversation into detailed Spanish summaries.

LANGUAGE
Write summaries in Spanish unless the selected message is entirely in another language and the active user preference clearly changed. Preserve exact file paths, commands, code identifiers, quoted user examples, and error strings verbatim.

THE SUMMARY
Each summary must preserve the technical value of the selected message after the raw message is removed. Capture current objective, durable user constraints, relevant decisions, implementation state, pending validation steps, important files, commands, and tool outcomes.

Be complete but lean. Prefer current state over chronology. If the selected message contains no significant technical decisions, code changes, user requirements, or pending task state, produce a minimal one-line summary.

USER INTENT FIDELITY
When a selected message contains user intent, preserve that intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, requested outcomes, or language preference. Quote short user instructions when that best preserves exact meaning.

MESSAGE IDS
Specify individual raw messages by ID using injected IDs visible in context:

- `mNNNN` IDs identify raw messages.

Each message has an ID inside XML metadata tags like `<dcp-message-id priority="high">m0007</dcp-message-id>`. Use only the inner `mNNNN` value as the `messageId`. Ignore XML attributes such as `priority`.

Rules:

- Pick each `messageId` directly from injected IDs visible in context.
- Only use raw message IDs of the form `mNNNN`.
- Do not invent IDs.
- Messages marked as `<dcp-message-id>BLOCKED</dcp-message-id>` cannot be compressed.
- If prior compress-tool results are present, summarize them minimally only as part of a broader compression pass. Do not invoke the compress tool solely to re-compress an earlier compression result.

BATCHING
Select many messages in a single tool call when they are safe to compress. Each entry summarizes exactly one message, and the tool can receive as many entries as needed in one batch.

GENERAL CLEANUP
Use the topic `limpieza general` for broad cleanup passes. During general cleanup, compress medium and high-priority messages that are not relevant to the active task. Optimize for reducing context footprint while preserving still-active instructions, unresolved questions, constraints, and pending validation requests.
