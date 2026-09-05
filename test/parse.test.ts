import assert from "node:assert/strict";
import { test } from "node:test";
import { ParseError, parseEvent, parseEventJson } from "../src/domain.js";

test("parseEvent rejects garbage", () => {
  assert.throws(() => parseEvent(null), ParseError);
  assert.throws(() => parseEvent([]), ParseError);
  assert.throws(() => parseEvent("nope"), ParseError);
  assert.throws(() => parseEvent({}), ParseError);
  assert.throws(() => parseEvent({ kind: "nope" }), ParseError);
  assert.throws(() => parseEvent({ kind: "run_created" }), ParseError);
  assert.throws(() => parseEventJson("{"), ParseError);
  assert.throws(() => parseEventJson("[]"), ParseError);
  assert.throws(
    () =>
      parseEvent({
        kind: "step_finished",
        ts: "2026-09-04T12:00:00.000Z",
        runId: "x",
        stepId: "s",
        exitCode: "0",
      }),
    ParseError,
  );
});

test("parseEvent accepts a run_created event", () => {
  const ev = parseEvent({
    kind: "run_created",
    ts: "2026-09-04T12:00:00.000Z",
    runId: "11111111-1111-1111-1111-111111111111",
    prompt: "hello",
    cwd: "/tmp",
  });
  assert.equal(ev.kind, "run_created");
});
