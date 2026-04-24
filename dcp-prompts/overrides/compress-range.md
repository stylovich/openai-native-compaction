Collapse a range in the conversation into a detailed Spanish summary.

LANGUAGE
Write the summary in Spanish unless the compressed range is entirely in another language and the active user preference clearly changed. Preserve exact file paths, commands, code identifiers, quoted user examples, and error strings verbatim.

THE SUMMARY
The summary must preserve enough technical context to continue the task without the raw range. Capture current objective, durable user constraints, relevant decisions, current implementation state, pending validation steps, important files, commands, and tool outcomes.

Be complete but lean. Prefer current state over chronology. Do not preserve long changelogs, failed attempts that no longer matter, verbose tool output, or repeated explanations. If the range contains a user-facing pending task, handoff instruction, test example, or validation request, keep it explicitly.

USER INTENT FIDELITY
When the range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, requested outcomes, or language preference. Quote short user instructions when that best preserves exact meaning.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- `(bN)`

Compressed block sections in context are marked with:

- `[Compressed conversation section]`

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat `(bN)` placeholders as reserved tokens. Do not emit `(bN)` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like `compressed bN`, not a placeholder.
- Before finalizing, verify the set of placeholders exactly matches the required set, with no duplicates.

FLOW PRESERVATION WITH PLACEHOLDERS
When using compressed block placeholders, write surrounding text so it remains coherent after placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment.
- Preserve chronology and causality around placeholders.
- Do not write prose that depends on the placeholder staying literal, such as "as noted in `(b2)`".

BOUNDARY IDS
Specify boundaries by ID using the injected IDs visible in the conversation:

- `mNNNN` IDs identify raw messages.
- `bN` IDs identify previously compressed blocks.

Each message has an ID inside XML metadata tags like `<dcp-message-id>...</dcp-message-id>`. The same ID tag appears in every tool output of the message it belongs to. Treat these tags as boundary metadata only, not tool result content.

Rules:

- Pick `startId` and `endId` directly from injected IDs in context.
- IDs must exist in the current visible context.
- `startId` must appear before `endId`.
- Do not invent IDs.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include them as separate entries in the `content` array of a single tool call. Each entry should have its own `startId`, `endId`, and `summary`.
