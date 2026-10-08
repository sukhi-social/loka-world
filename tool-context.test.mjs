import assert from "node:assert/strict";
import test from "node:test";

import { withToolContext } from "./tool-context.mjs";

test("adds state after the tool has run in text and structured output", async () => {
  let focus = null;
  const handler = withToolContext(
    async () => {
      focus = { task: "write", started_at: "2026-09-27T00:00:00Z" };
      return { content: [{ type: "text", text: "started" }] };
    },
    async () => ({ current_time: { iso: "2026-09-27T00:00:01Z" }, focus_status: focus, todos: [{ id: 1 }] }),
  );

  const result = await handler({});
  const context = result.structuredContent.loka_context;

  assert.equal(context.current_time.iso, "2026-09-27T00:00:01Z");
  assert.equal(context.focus_status.task, "write");
  assert.deepEqual(context.todos, [{ id: 1 }]);
  assert.match(context.observed_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(result.content.length, 1);
  assert.match(result.content[0].text, /^started/);
  assert.match(result.content[0].text, /loka_context:/);
});

test("includes common state on tool errors", async () => {
  const handler = withToolContext(
    async () => {
      throw new Error("could not complete");
    },
    async () => ({ current_time: { iso: "now" }, focus_status: null, todos: [] }),
  );

  const result = await handler({});

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.loka_context.current_time.iso, "now");
  assert.match(result.content[0].text, /could not complete/);
  assert.match(result.content[0].text, /loka_context:/);
});

test("keeps the tool result when shared state cannot be read", async () => {
  const handler = withToolContext(
    async () => ({ content: [{ type: "text", text: "done" }] }),
    async () => {
      throw new Error("state unavailable");
    },
  );

  const result = await handler({});

  assert.equal(result.content.length, 1);
  assert.match(result.content[0].text, /^done/);
  assert.match(result.content[0].text, /loka_context:/);
  assert.equal(result.structuredContent.loka_context.context_available, false);
  assert.deepEqual(result.structuredContent.loka_context.todos, []);
});
